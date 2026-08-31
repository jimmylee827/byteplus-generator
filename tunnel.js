// ============ Auto tunnel (cloudflared quick tunnel) ============
// BytePlus fetches reference media from a URL server-side, so uploading a local
// clip requires this server to be reachable from the internet. A cloudflared quick
// tunnel provides that, but its hostname is EPHEMERAL — it rotates when the tunnel
// is reaped, the network drops, or the process dies, which silently breaks uploads
// mid-session.
//
// This module owns a tunnel for the lifetime of the server: it spawns cloudflared,
// parses the assigned hostname, watches for the process dying, and respawns with
// backoff — publishing each new hostname so callers always read the current one.
// Nothing here is on the request path; if the tunnel is down, uploads report as
// unavailable and pasted URLs keep working.
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

class Tunnel {
    // Two modes:
    //  - quick (default): ephemeral *.trycloudflare.com hostname, throttled by
    //    Cloudflare, rotates on every reconnect. Zero setup.
    //  - named: `name` + `hostname` run YOUR pre-created tunnel on your own domain.
    //    The hostname is fixed and known up front, so it's published immediately
    //    rather than scraped from stdout, and it survives every reconnect.
    constructor({ port, envPath, writeEnv = true, log = console, name = null, hostname = null }) {
        this.port = port;
        this.envPath = envPath;
        this.writeEnv = writeEnv;
        this.log = log;
        this.name = name;
        this.hostname = hostname ? hostname.replace(/^https?:\/\//, '').replace(/\/+$/, '') : null;
        this.named = Boolean(name && this.hostname);
        this.url = null;
        this.proc = null;
        this.stopped = false;
        this.attempt = 0;
        this.listeners = new Set();
    }

    /** Current public base URL, or null while the tunnel is down. */
    getUrl() { return this.url; }

    /** Subscribe to URL changes (including null when the tunnel drops). */
    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    _publish(url) {
        if (this.url === url) return;
        this.url = url;
        for (const fn of this.listeners) {
            try { fn(url); } catch (e) { this.log.error('[TUNNEL] listener failed:', e.message); }
        }
        // Only quick tunnels need mirroring — a named hostname is fixed, so rewriting
        // .env on every boot would just churn a file you configured by hand.
        if (url && this.writeEnv && !this.named) this._syncEnv(url).catch(e =>
            this.log.error('[TUNNEL] could not update .env:', e.message));
    }

    // Mirror the live hostname into .env so it's visible and survives as a hint —
    // the in-memory value is always authoritative. Written atomically via rename so
    // an editor watching the file never observes a truncated .env.
    async _syncEnv(url) {
        if (!this.envPath || !fs.existsSync(this.envPath)) return;
        const raw = await fsp.readFile(this.envPath, 'utf-8');
        const line = `PUBLIC_BASE_URL=${url}`;
        let next;
        if (/^PUBLIC_BASE_URL=.*$/m.test(raw)) {
            next = raw.replace(/^PUBLIC_BASE_URL=.*$/m, line);
        } else {
            next = raw.replace(/\s*$/, '\n') +
                '\n# Managed by tunnel.js — rewritten each time the quick tunnel rotates.\n' +
                line + '\n';
        }
        if (next === raw) return;
        const tmp = this.envPath + '.tmp';
        await fsp.writeFile(tmp, next);
        await fsp.rename(tmp, this.envPath);
    }

    start() {
        if (this.stopped) return;
        this._spawn();
    }

    _spawn() {
        // `tunnel run` attaches to a pre-created named tunnel and routes to the local
        // port; the hostname comes from the DNS route you set up, not from stdout.
        const args = this.named
            ? ['tunnel', '--url', `http://localhost:${this.port}`, 'run', this.name]
            : ['tunnel', '--url', `http://localhost:${this.port}`];
        this.log.log(this.named
            ? `[TUNNEL] starting named tunnel "${this.name}" → https://${this.hostname}`
            : '[TUNNEL] starting cloudflared quick tunnel…');
        let proc;
        try {
            proc = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            this.log.error('[TUNNEL] failed to spawn cloudflared:', e.message);
            return this._scheduleRestart();
        }
        this.proc = proc;

        // Quick tunnels announce a random hostname on stderr, so it has to be scraped.
        // Named tunnels already know theirs — publish once a connection is registered
        // so we never advertise a URL before the edge can route to it.
        let found = false;
        const READY_RE = /Registered tunnel connection|Connection [a-f0-9-]+ registered/i;
        const scan = (chunk) => {
            const text = String(chunk);
            if (found) return;
            if (this.named) {
                if (!READY_RE.test(text)) return;
                found = true;
                this.attempt = 0;
                const url = `https://${this.hostname}`;
                this.log.log('[TUNNEL] up →', url);
                this._publish(url);
                return;
            }
            const m = text.match(URL_RE);
            if (m) {
                found = true;
                this.attempt = 0;
                this.log.log('[TUNNEL] up →', m[0]);
                this._publish(m[0]);
            }
        };
        proc.stdout.on('data', scan);
        proc.stderr.on('data', scan);

        // Config mistakes (unknown tunnel name, missing credentials) fail the same way
        // every retry, so surface the reason instead of silently looping on backoff.
        const FATAL_RE = /tunnel not found|Cannot determine default origin certificate|failed to find credentials|not authorized|doesn't exist/i;
        proc.stderr.on('data', (chunk) => {
            const text = String(chunk);
            if (this.named && FATAL_RE.test(text)) {
                this.log.error(`[TUNNEL] named tunnel "${this.name}" cannot start — check that it exists ` +
                    `(cloudflared tunnel list) and that ~/.cloudflared holds its credentials:\n  ${text.trim().slice(0, 300)}`);
            }
        });

        proc.on('error', (e) => {
            if (e.code === 'ENOENT') {
                this.log.error('[TUNNEL] cloudflared not found on PATH. Install it ' +
                    '(brew install cloudflared) or set PUBLIC_BASE_URL manually. ' +
                    'Uploads stay disabled; pasted URLs still work.');
                this.stopped = true; // no point retrying a missing binary
                return;
            }
            this.log.error('[TUNNEL] process error:', e.message);
        });

        proc.on('exit', (code, signal) => {
            this.proc = null;
            if (this.stopped) return;
            this.log.error(`[TUNNEL] cloudflared exited (code=${code} signal=${signal}) — uploads disabled until it returns.`);
            this._publish(null);
            this._scheduleRestart();
        });

        // If no hostname appears, the tunnel is wedged — kill it so 'exit' restarts us.
        setTimeout(() => {
            if (!found && this.proc === proc) {
                this.log.error('[TUNNEL] no hostname after 45s — restarting.');
                try { proc.kill('SIGTERM'); } catch { /* already gone */ }
            }
        }, 45000).unref?.();
    }

    _scheduleRestart() {
        if (this.stopped) return;
        // Backoff 2s → 60s so a persistent outage doesn't spin.
        const delay = Math.min(2000 * Math.pow(2, this.attempt++), 60000);
        this.log.log(`[TUNNEL] reconnecting in ${Math.round(delay / 1000)}s…`);
        setTimeout(() => this._spawn(), delay).unref?.();
    }

    stop() {
        this.stopped = true;
        if (this.proc) {
            try { this.proc.kill('SIGTERM'); } catch { /* already gone */ }
            this.proc = null;
        }
    }
}

module.exports = { Tunnel };
