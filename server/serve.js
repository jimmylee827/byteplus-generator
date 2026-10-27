// `ai-media-studio serve` (and `npm start`, `node server.js`): the web UI + HTTP API,
// plus the tunnel supervisor and the staging sweep for the server's lifetime.
// `ai-media-studio tunnel up` reuses the same lifecycle but serves only the staging
// folder, for CLI/MCP users who want uploads without the UI.
const http = require('http');
const express = require('express');
const { getConfig } = require('../core/config');
const { createContext } = require('../core/context');
const { createStores } = require('../core/stores');
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

/**
 * Start listening and run the tunnel + sweep. Resolves once listening.
 * @param {{ port?: number, stagingOnly?: boolean, log?: Console }} [opts]
 */
async function run({ port, stagingOnly = false, log = console } = {}) {
    const config = getConfig();
    const PORT = port || config.port;
    const ctx = createContext({ surface: 'http', log, config });
    await ensureDataLayout(config);

    let app;
    if (stagingOnly) {
        app = express();
        app.use(tunnelScope);
        app.use('/videos/staging', express.static(config.stagingDir));
    } else {
        app = createApp(ctx);
    }

    let tunnel = null;
    let publicBaseUrl = config.publicBaseUrlEnv;
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, resolve);
    });

    if (stagingOnly) {
        log.log(`Serving videos/staging on http://localhost:${PORT} (staging only).`);
    } else {
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
        tunnel = new Tunnel({
            port: PORT,
            envPath: config.envFile,
            statePath: config.tunnelStateFile,
            log,
            // Set both to run your own named tunnel on a domain you control: a fixed
            // hostname, and none of the quick tunnel's throttling. Falls back to a quick
            // tunnel when either is missing.
            name: config.tunnelName,
            hostname: config.tunnelHostname
        });
        tunnel.onChange((url) => {
            publicBaseUrl = url ? url.replace(/\/+$/, '') : '';
            log.log(url
                ? `[TUNNEL] uploads enabled via ${publicBaseUrl}`
                : '[TUNNEL] uploads disabled until the tunnel reconnects.');
        });
        tunnel.start();
    }

    // Don't leave an orphaned cloudflared behind when the server goes away.
    let shuttingDown = false;
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            if (shuttingDown) return;
            shuttingDown = true;
            tunnel?.stop();
            process.exit(0);
        });
    }
    return { server, port: PORT, tunnel };
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

module.exports = { run, main, ensureDataLayout };

if (require.main === module) main();
