// Several processes on one data folder: the lock, gallery ids and records, shared key
// rotation state, and the video finalize lock.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startServer, call, makeTmp } = require('../helpers/server');
const { withLock } = require('../../core/stores/lock');

const WORKER = path.join(__dirname, '..', 'fixtures', 'scripts', 'lock-worker.js');
const runWorker = (dir, times) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, dir, String(times)], { stdio: 'inherit' });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
});

describe('file lock', () => {
    it('serialises read-modify-write across processes', async () => {
        const dir = makeTmp('ams-lock-');
        await Promise.all([1, 2, 3, 4].map(() => runWorker(dir, 40)));
        assert.equal(fs.readFileSync(path.join(dir, 'counter.txt'), 'utf-8'), '160');
    });

    it('breaks a lock left behind by a dead process', async () => {
        const dir = makeTmp('ams-lock-');
        fs.mkdirSync(path.join(dir, 'locks'));
        // pid 2^22+7 is far above macOS/Linux defaults, so it is not running.
        fs.writeFileSync(path.join(dir, 'locks', 'stale.lock'), JSON.stringify({ pid: 4194311, at: Date.now(), token: 'x' }));
        const got = await withLock(path.join(dir, 'locks'), 'stale', async () => 'entered', { timeoutMs: 2000 });
        assert.equal(got, 'entered');
        assert.ok(!fs.existsSync(path.join(dir, 'locks', 'stale.lock')));
    });
});

describe('two servers, one data folder', () => {
    const servers = [];
    after(async () => { await Promise.all(servers.map(s => s.stop())); });

    it('concurrent generations from both get unique ids and are all recorded', async () => {
        const dataDir = makeTmp('ams-shared-');
        const a = await startServer({ dataDir });
        const b = await startServer({ dataDir });
        servers.push(a, b);
        const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => call(i % 2 ? a : b, 'POST', '/api/generate', { form: { prompt: `p${i}` } })));
        assert.deepEqual(rs.map(r => r.status), rs.map(() => 200));
        const ids = rs.map(r => r.body.item.id);
        assert.equal(new Set(ids).size, 16);
        const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'gallery', 'manifest.json'), 'utf-8'));
        assert.equal(manifest.items.length, 16);
        for (const id of ids) assert.ok(fs.existsSync(path.join(dataDir, 'gallery', `${id}.jpeg`)));
        assert.deepEqual(fs.readdirSync(path.join(dataDir, 'gallery')).filter(f => f.endsWith('.part') || f.endsWith('.tmp')), []);
    });

    it('key rotation in one process is seen by the other', async () => {
        const dataDir = makeTmp('ams-shared-');
        const mockDir = makeTmp('ams-mock-');
        const a = await startServer({ dataDir, mockDir });
        const b = await startServer({ dataDir, mockDir });
        servers.push(a, b);
        a.mock.rules([{ match: 'POST https://ark', response: { status: 401, text: 'revoked' } }]);
        assert.equal((await call(a, 'POST', '/api/generate', { form: { prompt: 'x' } })).status, 200);
        assert.equal((await call(b, 'POST', '/api/generate', { form: { prompt: 'y' } })).status, 200);
        assert.deepEqual(a.mock.ark().map(r => r.keyIndex), [0, 1, 1]);
        assert.equal((await call(b, 'GET', '/api/health')).body.activeKeys, 2);
        const state = fs.readFileSync(path.join(dataDir, '.state', 'keys.json'), 'utf-8');
        assert.ok(!state.includes('key-aaaa1111'), 'raw keys must never be written');
    });

    it('a 401-disabled key stays disabled across a restart', async () => {
        const dataDir = makeTmp('ams-shared-');
        const a = await startServer({ dataDir });
        a.mock.rules([{ match: 'POST https://ark', response: { status: 401, text: 'revoked' } }]);
        await call(a, 'POST', '/api/generate', { form: { prompt: 'x' } });
        await a.stop();
        const b = await startServer({ dataDir });
        servers.push(b);
        assert.equal((await call(b, 'GET', '/api/health')).body.activeKeys, 2);
    });

    it('two pollers of one finished task download it once', async () => {
        const dataDir = makeTmp('ams-shared-');
        const mockDir = makeTmp('ams-mock-');
        const a = await startServer({ dataDir, mockDir });
        const b = await startServer({ dataDir, mockDir });
        servers.push(a, b);
        const c = await call(a, 'POST', '/api/video/generate', { form: { userMessage: 'p', refVideoUrl: 'https://x/y.mp4' } });
        const id = c.body.taskId;
        const done = { status: 200, json: { id, status: 'succeeded', duration: 5, content: { video_url: 'https://mock.cdn/once.mp4' } } };
        a.mock.rules([{ match: 'GET https://ark', response: done }, { match: 'GET https://ark', response: done }]);
        const [ra, rb] = await Promise.all([
            call(a, 'GET', `/api/video/tasks/${id}`),
            call(b, 'GET', `/api/video/tasks/${id}`)
        ]);
        assert.equal(ra.body.record.fullVideo, `/videos/${id}.mp4`);
        assert.equal(rb.body.record.fullVideo, `/videos/${id}.mp4`);
        assert.equal(a.mock.log().filter(l => l.url === 'https://mock.cdn/once.mp4').length, 1);
        const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'videos', 'manifest.json'), 'utf-8'));
        assert.equal(manifest.items.filter(i => i.id === id).length, 1);
    });
});
