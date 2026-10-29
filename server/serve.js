// `ai-media-studio serve` (and `npm start`, `node server.js`): the web UI + HTTP API,
// plus the tunnel supervisor and the staging sweep for the server's lifetime.
// `ai-media-studio tunnel up` reuses the same lifecycle but serves only the staging
// folder, for CLI/MCP users who want uploads without the UI.
//
// Ports: PORT / `--port` are honoured exactly (a busy one is an error). With neither
// set, 3000 is only a preference — if something else (a Next.js dev server, say) holds
// it, the server takes whatever the OS gives and says so.
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const express = require('express');
const { getConfig } = require('../core/config');
const { createContext } = require('../core/context');
const { createStores } = require('../core/stores');
const { StudioError } = require('../core/errors');
const { Tunnel } = require('../core/tunnel');
const { setOwnTunnel, readTunnelState } = require('../core/publicUrl');
const { pidAlive } = require('../core/stores/lock');
const { sweepStaging, ensureStagingDir } = require('../core/staging');
const { createApp, tunnelScope } = require('./app');

// Creates the data folders and empty manifests a fresh install needs (never overwrites).
async function ensureDataLayout(config) {
    const stores = createStores(config);
    await Promise.all([stores.gallery.list(), stores.prompts.list(), stores.videos.list()]);
    ensureStagingDir(config);
}

function otherLiveTunnelOwner(config) {
    const st = readTunnelState(config);
    return st && st.ownerPid !== process.pid && st.status !== 'down' && pidAlive(st.ownerPid) ? st : null;
}

// --- server state (which port the studio is really on) ---
function readServerState(config) {
    try { return JSON.parse(fs.readFileSync(config.serverStateFile, 'utf-8')); } catch { return null; }
}

function writeServerState(config, { port }) {
    try {
        fs.mkdirSync(config.stateDir, { recursive: true });
        fs.writeFileSync(config.serverStateFile, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }, null, 2));
    } catch { /* state is a convenience, never a reason to fail */ }
}

function clearServerState(config) {
    try { fs.unlinkSync(config.serverStateFile); } catch { /* already gone */ }
}

/** The studio this process can see: its pid is alive and it answers /api/health. */
function liveServer(config) {
    const st = readServerState(config);
    return st && st.port && pidAlive(st.pid) ? st : null;
}

// --- ports ---
function isPortFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        // No host: same dual-stack bind http.Server uses, so a server on [::]:PORT counts.
        srv.listen(port);
    });
}

/** Does something on this port answer like this app (rather than some other program)? */
async function probeStudio(port, timeoutMs = 800) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { if (body.length < 4096) body += d; });
            res.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    resolve(Boolean(d && d.ok === true && typeof d.activeKeys === 'number'));
                } catch { resolve(false); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

function listen(app, port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        const onError = (e) => { server.removeListener('listening', onListening); reject(e); };
        const onListening = () => { server.removeListener('error', onError); resolve(server); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
    });
}

/**
 * Bind the port. When it is explicitly configured, a busy port is an error; when it is
 * the default, 3000 is only a preference and a free port is taken instead.
 */
async function listenWithFallback(app, { port, explicitPort, log }) {
    try {
        const server = await listen(app, port);
        return { server, port: server.address().port };
    } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        if (explicitPort) {
            throw new StudioError('USAGE', `Port ${port} is already in use. Pick another with --port (or PORT in .env).`);
        }
        const server = await listen(app, 0);
        const actual = server.address().port;
        log.log(`[PORT] ${port} is in use by another program — using ${actual} instead (set PORT or --port to choose).`);
        return { server, port: actual };
    }
}

function stagingApp(config) {
    const app = express();
    app.use(tunnelScope);
    app.use('/videos/staging', express.static(config.stagingDir));
    return app;
}

function tunnelOptions(config, port) {
    return {
        port,
        envPath: config.envFile,
        statePath: config.tunnelStateFile,
        // Set a name + hostname to run your own named tunnel on a domain you control: a
        // fixed hostname, and none of the quick tunnel's throttling. Falls back to a
        // quick tunnel when both are missing. TUNNEL_TOKEN / TUNNEL_UUID pick how the
        // named tunnel is started — see core/tunnel.js:tunnelArgs().
        name: config.tunnelName,
        hostname: config.tunnelHostname,
        uuid: config.tunnelUuid,
        credentialsFile: config.tunnelCredentials || (config.tunnelUuid ? nameCredentials(config.tunnelUuid) : null),
        token: config.tunnelToken,
        originCert: config.tunnelOriginCert
    };
}

// cloudflared keeps each tunnel's secret at ~/.cloudflared/<uuid>.json.
function nameCredentials(uuid) {
    return path.join(os.homedir(), '.cloudflared', `${uuid}.json`);
}

function installSignalHandlers(tunnel, { onExit } = {}) {
    // Don't leave an orphaned cloudflared behind when the process goes away.
    let shuttingDown = false;
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            if (shuttingDown) return;
            shuttingDown = true;
            tunnel?.stop();
            if (onExit) onExit();
            process.exit(0);
        });
    }
}

/**
 * Start the web UI + API. Resolves once listening.
 * @param {{ port?: number, stagingOnly?: boolean, log?: Console }} [opts]
 */
async function run({ port, stagingOnly = false, log = console } = {}) {
    const config = getConfig();
    const ctx = createContext({ surface: 'http', log, config });
    await ensureDataLayout(config);

    const explicitPort = port !== undefined || process.env.PORT !== undefined;
    const requested = port !== undefined ? port : config.port;
    const app = stagingOnly ? stagingApp(config) : createApp(ctx);
    const { server, port: PORT } = await listenWithFallback(app, { port: requested, explicitPort, log });

    let tunnel = null;
    let publicBaseUrl = config.publicBaseUrlEnv;

    if (stagingOnly) {
        log.log(`Serving videos/staging on http://localhost:${PORT} (staging only).`);
    } else {
        writeServerState(config, { port: PORT });
        log.log(`BytePlus Studio running on http://localhost:${PORT}`);
        log.log(`Loaded ${config.apiKeys.length} API key(s).`);
        if (config.apiKeys.length > 0) log.log('Video editing enabled (Seedance 2.5).');
    }

    // Reclaim staged inputs orphaned by tasks that never finished polling.
    sweepStaging(config, log);
    setInterval(() => sweepStaging(config, log), 60 * 60 * 1000).unref();

    // Keep a public tunnel alive for the server's lifetime so local-file uploads
    // work without manual setup. Quick-tunnel hostnames rotate, so the supervisor
    // republishes the new one into publicBaseUrl (and .env) on every reconnect —
    // no restart needed. Set AUTO_TUNNEL=0 to manage PUBLIC_BASE_URL yourself.
    if (!config.autoTunnel) {
        log.log(publicBaseUrl
            ? `[TUNNEL] auto-tunnel off; using PUBLIC_BASE_URL=${publicBaseUrl}`
            : '[TUNNEL] auto-tunnel off and no PUBLIC_BASE_URL — uploads disabled (pasted URLs still work).');
    } else if (otherLiveTunnelOwner(config)) {
        // `tunnel up` (or another serve) already owns it; reuse that address.
        const st = otherLiveTunnelOwner(config);
        log.log(`[TUNNEL] process ${st.ownerPid} already runs the tunnel; using its address.`);
    } else {
        // The supervisor owns the address from here on. Any PUBLIC_BASE_URL left in .env is
        // a stale hostname from a previous run — trusting it would advertise a dead URL to
        // BytePlus until the tunnel comes up.
        if (publicBaseUrl) {
            log.log('[TUNNEL] ignoring stale PUBLIC_BASE_URL until the tunnel reports in.');
            publicBaseUrl = '';
        }
        setOwnTunnel(() => publicBaseUrl);
        tunnel = new Tunnel({ ...tunnelOptions(config, PORT), log });
        tunnel.onChange((url) => {
            publicBaseUrl = url ? url.replace(/\/+$/, '') : '';
            log.log(url
                ? `[TUNNEL] uploads enabled via ${publicBaseUrl}`
                : '[TUNNEL] uploads disabled until the tunnel reconnects.');
        });
        tunnel.start();
    }

    installSignalHandlers(tunnel, { onExit: stagingOnly ? null : () => clearServerState(config) });
    return { server, port: PORT, tunnel };
}

/**
 * `tunnel up`: point a tunnel at something that serves videos/staging — this app's own
 * running server if there is one, otherwise a staging-only listener. Never requires the
 * studio to be on 3000, and never takes a port another program is using.
 */
async function runTunnelUp({ port, log = console } = {}) {
    const config = getConfig();
    if (!config.autoTunnel) {
        throw new StudioError('USAGE', 'AUTO_TUNNEL=0, so the tunnel is managed by hand: set PUBLIC_BASE_URL in .env instead.');
    }
    const owner = otherLiveTunnelOwner(config);
    if (owner) {
        throw new StudioError('USAGE', `A tunnel is already running (process ${owner.ownerPid}${owner.url ? `, ${owner.url}` : ''}).`);
    }
    await ensureDataLayout(config);

    const explicit = port !== undefined;
    const live = liveServer(config);
    let target = explicit ? port : live ? live.port : config.port;
    let server = null;
    let serving = false;

    if (explicit && await probeStudio(port)) {
        // Asked for a port that already serves staging: point the tunnel at it.
        log.log(`[TUNNEL] staging is already served by the studio on port ${port}.`);
    } else if (!explicit && live && await probeStudio(live.port)) {
        log.log(`[TUNNEL] staging is already served by the studio on port ${live.port}.`);
    } else if (!explicit && await probeStudio(target)) {
        log.log(`[TUNNEL] staging is already served by the studio on port ${target}.`);
    } else if (explicit) {
        // Explicitly asked for this port: use it, or fail loudly.
        ({ server } = await listenWithFallback(stagingApp(config), { port: target, explicitPort: true, log }));
        serving = true;
        log.log(`Serving videos/staging on http://localhost:${target} (staging only).`);
    } else if (await isPortFree(target)) {
        ({ server } = await listen(stagingApp(config), target));
        serving = true;
        log.log(`Serving videos/staging on http://localhost:${target} (staging only).`);
    } else {
        // Another program (a Next.js dev server on 3000, say) holds it: take a free port.
        ({ server, port: target } = await listenWithFallback(stagingApp(config), { port: 0, explicitPort: true, log }));
        serving = true;
        log.log(`[PORT] ${config.port} is in use by another program — serving videos/staging on http://localhost:${target}.`);
    }

    sweepStaging(config, log);
    setInterval(() => sweepStaging(config, log), 60 * 60 * 1000).unref();

    const tunnel = new Tunnel({ ...tunnelOptions(config, target), log });
    let url = '';
    setOwnTunnel(() => url);
    tunnel.onChange((u) => {
        url = u ? u.replace(/\/+$/, '') : '';
        log.log(u ? `[TUNNEL] uploads enabled via ${url}` : '[TUNNEL] uploads disabled until the tunnel reconnects.');
    });
    tunnel.start();
    installSignalHandlers(tunnel, { onExit: () => { if (serving && server) server.close(); } });
    return { server, port: target, tunnel };
}

/** `node server.js` / `npm start`: the original boot contract, including its exit. */
async function main(opts = {}) {
    const config = getConfig();
    if (!config.endpointId || config.apiKeys.length === 0) {
        console.error('ERROR: Missing ENDPOINT_ID or BYTEPLUS_API_KEYS in .env file.');
        process.exit(1);
    }
    try {
        await run(opts);
    } catch (e) {
        console.error(`ERROR: could not start the server: ${e.message}`);
        process.exit(1);
    }
}

module.exports = {
    run, runTunnelUp, main, ensureDataLayout,
    // exported for tests and diagnostics
    listenWithFallback, isPortFree, probeStudio, readServerState, writeServerState, clearServerState, tunnelOptions
};

if (require.main === module) main();
