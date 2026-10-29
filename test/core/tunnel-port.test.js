// How a named tunnel is started (token / UUID / name) and how ports are chosen —
// 3000 is a preference, never a requirement.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { tunnelArgs, certStatus, Tunnel } = require('../../core/tunnel');
const { tunnelStatus } = require('../../core/publicUrl');
const { buildConfig } = require('../../core/config');
const { listenWithFallback, isPortFree, probeStudio } = require('../../server/serve');
const { makeTmp } = require('../helpers/server');
const { runCli } = require('../helpers/cli');

const closers = [];
after(async () => { await Promise.all(closers.map(close => close())); });

function listenOn(port, handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(port, () => {
            closers.push(() => new Promise(r => srv.close(r)));
            resolve(srv.address().port);
        });
    });
}
function occupy(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(port, () => {
            closers.push(() => new Promise(r => srv.close(r)));
            resolve(srv.address().port);
        });
    });
}
const freePort = async () => {
    const p = await occupy(0);
    await closers.pop()();
    return p;
};

describe('tunnel start methods', () => {
    it('builds the right cloudflared arguments for each method', () => {
        assert.deepEqual(tunnelArgs({ port: 3000 }), ['tunnel', '--url', 'http://localhost:3000']);
        assert.deepEqual(tunnelArgs({ port: 4321, method: 'name', name: 'byteplus-studio' }),
            ['tunnel', '--url', 'http://localhost:4321', 'run', 'byteplus-studio']);
        // Running by UUID needs no cert.pem — the credentials file is passed explicitly.
        assert.deepEqual(tunnelArgs({ port: 4321, method: 'uuid', uuid: 'abc', credentialsFile: '/c.json' }),
            ['tunnel', '--url', 'http://localhost:4321', 'run', '--credentials-file', '/c.json', 'abc']);
        assert.deepEqual(tunnelArgs({ port: 4321, method: 'token', token: 'tok' }),
            ['tunnel', '--url', 'http://localhost:4321', 'run', '--token', 'tok']);
    });

    it('recognises what cert.pem actually is', () => {
        const dir = makeTmp('ams-cert-');
        const write = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
        const token = write('token.pem', '-----BEGIN ARGO TUNNEL TOKEN-----\neyJ6b25l\n-----END ARGO TUNNEL TOKEN-----\n');
        const cert = write('cert.pem', '-----BEGIN ARGO TUNNEL CERTIFICATE-----\nMII\n-----END ARGO TUNNEL CERTIFICATE-----\n');
        const plain = write('plain.pem', '-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----\n');
        const junk = write('junk.pem', 'hello\n');
        assert.equal(certStatus(token).problem, 'token');
        assert.equal(certStatus(path.join(dir, 'missing.pem')).problem, 'missing');
        assert.equal(certStatus(junk).problem, 'unreadable');
        assert.equal(certStatus(cert).ok, true);
        assert.equal(certStatus(plain).ok, true);
    });

    it('refuses to run by name with a broken cert instead of looping on "unauthorized"', () => {
        const dir = makeTmp('ams-cert-');
        const originCert = path.join(dir, 'cert.pem');
        fs.writeFileSync(originCert, '-----BEGIN ARGO TUNNEL TOKEN-----\nx\n-----END ARGO TUNNEL TOKEN-----\n');
        const statePath = path.join(dir, 'tunnel.json');
        const lines = [];
        const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
        const t = new Tunnel({ port: 3000, name: 'byteplus-studio', hostname: 'x.example', originCert, statePath, log, writeEnv: false });
        t.start();
        assert.equal(t.stopped, true, 'no retry loop');
        assert.match(lines.join('\n'), /Argo Tunnel token, not a certificate/);
        assert.match(lines.join('\n'), /TUNNEL_UUID/);
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.status, 'down');
        t.stop();
    });

    it('UUID runs never consult the cert, and a missing credentials file is named', () => {
        const dir = makeTmp('ams-cert-');
        const missingCert = path.join(dir, 'nope.pem');
        const lines = [];
        const t = new Tunnel({
            port: 3000, hostname: 'x.example', originCert: missingCert, writeEnv: false,
            uuid: 'u-1', credentialsFile: path.join(dir, 'no-such-uuid.json'),
            log: { log: (m) => lines.push(m), error: (m) => lines.push(m) }
        });
        assert.equal(t.method, 'uuid');
        t.start();
        assert.equal(t.stopped, true);
        assert.match(lines.join('\n'), /credentials file/);
        assert.doesNotMatch(lines.join('\n'), /certificate/, 'the cert is irrelevant to a UUID run');

        const tokenRun = new Tunnel({ port: 3000, hostname: 'x.example', originCert: missingCert, writeEnv: false, token: 'tok', log: { log() {}, error() {} } });
        assert.equal(tokenRun.method, 'token');
        tokenRun.stop();
    });

    it('tunnel status reports the method and, only for name mode, the cert problem', () => {
        const dir = makeTmp('ams-status-');
        const originCert = path.join(dir, 'cert.pem');
        fs.writeFileSync(originCert, '-----BEGIN ARGO TUNNEL TOKEN-----\nx\n-----END ARGO TUNNEL TOKEN-----\n');
        const base = { AI_MEDIA_STUDIO_DATA_DIR: dir, TUNNEL_NAME: 'byteplus-studio', TUNNEL_HOSTNAME: 'x.example', TUNNEL_ORIGIN_CERT: originCert };
        const byName = tunnelStatus(buildConfig(base));
        assert.deepEqual([byName.mode, byName.method], ['named', 'name']);
        assert.equal(byName.cert.ok, false);
        assert.equal(byName.cert.problem, 'token');

        const byUuid = tunnelStatus(buildConfig({ ...base, TUNNEL_UUID: '559e2f6e-0000-0000-0000-000000000000' }));
        assert.deepEqual([byUuid.mode, byUuid.method], ['named', 'uuid']);
        assert.equal(byUuid.uuid, '559e2f6e-0000-0000-0000-000000000000');
        assert.equal(byUuid.cert, undefined, 'a UUID run does not depend on cert.pem');
    });
});

describe('port selection', () => {
    const quiet = { log() {} };

    it('3000 is a preference: a busy default moves to a free port', async () => {
        const busy = await occupy(0);
        const lines = [];
        const { server, port } = await listenWithFallback((req, res) => res.end('ok'), {
            port: busy, explicitPort: false, log: { log: (m) => lines.push(m) }
        });
        closers.push(() => new Promise(r => server.close(r)));
        assert.notEqual(port, busy);
        assert.ok(port > 0);
        assert.match(lines.join('\n'), new RegExp(`\\[PORT\\] ${busy} is in use`));
    });

    it('an explicitly configured port that is busy is an error, not a silent move', async () => {
        const busy = await occupy(0);
        await assert.rejects(
            listenWithFallback((req, res) => res.end('ok'), { port: busy, explicitPort: true, log: quiet }),
            (e) => e.code === 'USAGE' && /already in use/.test(e.message)
        );
    });

    it('an explicitly configured free port is used exactly', async () => {
        const p = await freePort();
        const { server, port } = await listenWithFallback((req, res) => res.end('ok'), { port: p, explicitPort: true, log: quiet });
        closers.push(() => new Promise(r => server.close(r)));
        assert.equal(port, p);
    });

    it('isPortFree and probeStudio tell our app from any other program', async () => {
        const free = await freePort();
        assert.equal(await isPortFree(free), true);
        const ours = await listenOn(0, (req, res) => res.end(JSON.stringify({ success: true, ok: true, activeKeys: 1 })));
        assert.equal(await isPortFree(ours), false);
        assert.equal(await probeStudio(ours), true);
        const other = await listenOn(0, (req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html>next</html>'); });
        assert.equal(await probeStudio(other), false);
        assert.equal(await probeStudio(free), false, 'nothing listening');
    });
});

describe('tunnel up refusals (no cloudflared is started)', () => {
    it('AUTO_TUNNEL=0 is refused with what to do instead', async () => {
        const dir = makeTmp('ams-up-');
        const r = await runCli(['tunnel', 'up', '--json'], { dataDir: dir, mockDir: makeTmp('ams-mock-'), env: { AUTO_TUNNEL: '0' } });
        assert.deepEqual([r.code, r.json.code], [2, 'USAGE']);
        assert.match(r.json.error, /AUTO_TUNNEL=0/);
    });

    it('a tunnel already owned by a live process is refused', async () => {
        const dir = makeTmp('ams-up-');
        fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.state', 'tunnel.json'), JSON.stringify({
            status: 'up', url: 'https://x.example', mode: 'named', method: 'uuid', ownerPid: process.pid, port: 3000
        }));
        const r = await runCli(['tunnel', 'up', '--json'], { dataDir: dir, mockDir: makeTmp('ams-mock-'), env: { AUTO_TUNNEL: '1', PUBLIC_BASE_URL: '' } });
        assert.deepEqual([r.code, r.json.code], [2, 'USAGE']);
        assert.match(r.json.error, /already running/);
    });
});
