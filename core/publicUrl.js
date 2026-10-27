// The public address BytePlus fetches staged uploads from — answered the same way for
// every process.
//
// The tasks API only accepts reference media as a URL that BytePlus can fetch
// server-side (verified: `file_id` is not a supported content type, and data URIs
// are rejected). To use a *local* clip we must therefore serve it ourselves at an
// address reachable from the public internet. PUBLIC_BASE_URL is that address —
// e.g. an ngrok/cloudflared tunnel pointed at this server. Without it, uploads are
// refused up front with an actionable message and only pasted URLs work.
// A quick tunnel's hostname ROTATES, so this can't be a boot-time constant: it's
// read live on every request. AUTO_TUNNEL=0 disables the supervisor and pins the
// value to whatever .env holds — the only mode where PUBLIC_BASE_URL is yours to
// set by hand. A named tunnel does NOT need it: TUNNEL_NAME/TUNNEL_HOSTNAME keep
// the supervisor on and it reports the fixed hostname itself.
//
// Resolution order:
//   1. AUTO_TUNNEL=0            → PUBLIC_BASE_URL from .env, verbatim.
//   2. the process owns a tunnel → its live value (set by serve / tunnel up).
//   3. otherwise                → .state/tunnel.json, if it says "up" and its owner
//                                 process is still alive. A PUBLIC_BASE_URL left in .env
//                                 by the quick tunnel is only a hint and is not trusted.
const fs = require('fs');
const { pidAlive } = require('./stores/lock');

let ownSource = null;

/** Called by the process that runs the tunnel: fn() returns its current URL or ''. */
function setOwnTunnel(fn) { ownSource = fn; }

function readTunnelState(config) {
    try { return JSON.parse(fs.readFileSync(config.tunnelStateFile, 'utf-8')); } catch { return null; }
}

/** Live tunnel state for `tunnel status`: the file, plus whether its owner is alive. */
function tunnelStatus(config) {
    const st = readTunnelState(config);
    const ownerAlive = Boolean(st && pidAlive(st.ownerPid));
    return {
        autoTunnel: config.autoTunnel,
        mode: config.autoTunnel ? (config.tunnelName && config.tunnelHostname ? 'named' : 'quick') : 'manual',
        status: !config.autoTunnel ? (config.publicBaseUrlEnv ? 'up' : 'down') : (st && ownerAlive ? st.status : 'down'),
        url: currentPublicUrl(config) || null,
        ownerPid: st && ownerAlive ? st.ownerPid : null,
        updatedAt: st ? st.updatedAt : null
    };
}

function currentPublicUrl(config) {
    if (!config.autoTunnel) return config.publicBaseUrlEnv;
    if (ownSource) return (ownSource() || '').replace(/\/+$/, '');
    const st = readTunnelState(config);
    if (st && st.status === 'up' && st.url && pidAlive(st.ownerPid)) return String(st.url).replace(/\/+$/, '');
    return '';
}

module.exports = { currentPublicUrl, setOwnTunnel, tunnelStatus, readTunnelState };
