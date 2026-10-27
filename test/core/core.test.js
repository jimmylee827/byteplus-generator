// Core behaviour that is new in the refactor (the legacy behaviour is pinned under
// test/characterisation): id collisions, real file extensions, tunnel scope,
// dry runs, plans, key reset, and the derived fields on poll responses.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, call, FILES, makeTmp } = require('../helpers/server');
const { nextGalleryId, formatTimestamp } = require('../../core/images');
const { detectImageExt } = require('../../core/files');
const { pollDelay } = require('../../core/videos');
const { buildConfig } = require('../../core/config');
const { KeyManager } = require('../../core/keys');

describe('gallery ids', () => {
    it('suffixes _2, _3 … when the timestamp is taken', () => {
        const dir = makeTmp('ams-ids-');
        const date = new Date(2026, 0, 2, 3, 4, 5, 6);
        const base = formatTimestamp(date);
        assert.equal(base, '20260102_030405_006');
        assert.equal(nextGalleryId(dir, date), base);
        fs.writeFileSync(path.join(dir, `${base}.jpeg`), '');
        assert.equal(nextGalleryId(dir, date), `${base}_2`);
        fs.writeFileSync(path.join(dir, `${base}_2.part`), '');    // a reservation counts as taken
        assert.equal(nextGalleryId(dir, date), `${base}_3`);
        fs.writeFileSync(path.join(dir, `${base}_3_in_0.png`), ''); // so do input thumbs
        assert.equal(nextGalleryId(dir, date), `${base}_4`);
    });

    it('detects the real image format', () => {
        assert.equal(detectImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
        assert.equal(detectImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
        assert.equal(detectImageExt(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
        assert.equal(detectImageExt(Buffer.from('???')), 'jpeg');
    });
});

describe('keys', () => {
    it('reset clears uses and disabled flags; status never shows a key', async () => {
        const config = buildConfig({ AI_MEDIA_STUDIO_DATA_DIR: makeTmp('ams-keys-'), BYTEPLUS_API_KEYS: 'alpha-secret-1,beta-secret-2' });
        const km = new KeyManager(config.apiKeys, { stateFile: config.keysStateFile, locksDir: config.locksDir, log: { log() {}, error() {} } });
        const a = await km.acquire();
        await km.rotate(a.hash, { disable: true, status: 401 });
        let st = await km.status();
        assert.equal(st.current, 1);
        assert.equal(st.keys[0].disabled, true);
        assert.equal(st.keys[0].key, '****et-1');
        assert.ok(!JSON.stringify(st).includes('alpha-secret-1'));
        await km.reset();
        st = await km.status();
        assert.deepEqual(st.keys.map(k => [k.uses, k.disabled]), [[0, false], [0, false]]);
        assert.equal(st.current, 0);
    });

    it('a key removed from the list is dropped; reordering keeps the current key', async () => {
        const dataDir = makeTmp('ams-keys-');
        const mk = (keys) => {
            const c = buildConfig({ AI_MEDIA_STUDIO_DATA_DIR: dataDir, BYTEPLUS_API_KEYS: keys });
            return new KeyManager(c.apiKeys, { stateFile: c.keysStateFile, locksDir: c.locksDir, log: { log() {}, error() {} } });
        };
        const one = mk('k1,k2,k3');
        const first = await one.acquire();
        await one.rotate(first.hash, { status: 429 }); // now on k2
        const two = mk('k3,k2');                        // k1 removed, order changed
        assert.equal((await two.acquire()).key, 'k2');
        const state = JSON.parse(fs.readFileSync(path.join(dataDir, '.state', 'keys.json'), 'utf-8'));
        assert.equal(Object.keys(state.keys).length, 2);
    });
});

describe('poll cadence', () => {
    it('matches the composer: 5s × 5, then 10s until attempt 20, then 20s', () => {
        assert.deepEqual([1, 5, 6, 19, 20, 50].map(pollDelay), [5000, 5000, 10000, 10000, 20000, 20000]);
    });
});

describe('server behaviour new in the refactor', () => {
    let srv;
    before(async () => { srv = await startServer(); });
    after(async () => { await srv?.stop(); });
    beforeEach(() => srv.mock.clear());

    it('a PNG result is saved as .png', async () => {
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 200, json: { data: [{ url: 'https://mock.cdn/out.png' }] } } }]);
        const r = await call(srv, 'POST', '/api/generate', { form: { prompt: 'png please', model: 'dola-seedream-5-0-pro-260628', output_format: 'png' } });
        assert.equal(r.body.item.outputPath, `/gallery/${r.body.item.id}.png`);
        assert.equal(r.full.item.paths.output, path.join(srv.dataDir, 'gallery', `${r.body.item.id}.png`));
        assert.ok(fs.existsSync(r.full.item.paths.output));
    });

    it('model + resolution + ratio replace the browser size matrix; the catalogue format is applied', async () => {
        await call(srv, 'POST', '/api/generate', { form: { prompt: 'm', model: 'dola-seedream-5-0-pro-260628', resolution: '1.5K', ratio: '16:9' } });
        const body = JSON.parse(srv.mock.ark().at(-1).raw);
        assert.equal(body.size, '2048x1152');
        assert.equal(body.output_format, 'jpeg');
    });

    it('slots are compiled by core when sent with the template', async () => {
        await call(srv, 'POST', '/api/generate', { form: { prompt: 'A {{style:cyberpunk}} {{thing}}', slots: JSON.stringify({ thing: 'city' }) } });
        assert.equal(JSON.parse(srv.mock.ark().at(-1).raw).prompt, 'A cyberpunk city');
    });

    it('errors carry a stable code', async () => {
        const r = await call(srv, 'POST', '/api/generate', { form: { prompt: ' ' } });
        assert.equal(r.full.code, 'VALIDATION');
        const nf = await call(srv, 'GET', '/api/gallery/nope');
        assert.equal(nf.full.code, 'NOT_FOUND');
    });

    it('requests that came through the tunnel only reach staged files', async () => {
        fs.mkdirSync(path.join(srv.dataDir, 'videos', 'staging'), { recursive: true });
        fs.writeFileSync(path.join(srv.dataDir, 'videos', 'staging', 'probe.bin'), 'probe');
        const viaTunnel = { headers: { 'cf-connecting-ip': '203.0.113.9' } };
        const health = await fetch(`${srv.url}/api/health`, viaTunnel);
        assert.equal(health.status, 404);
        const del = await fetch(`${srv.url}/api/gallery/x`, { method: 'DELETE', ...viaTunnel });
        assert.equal(del.status, 404);
        const ui = await fetch(`${srv.url}/`, viaTunnel);
        assert.equal(ui.status, 404);
        const staged = await fetch(`${srv.url}/videos/staging/probe.bin`, viaTunnel);
        assert.equal(staged.status, 200);
        assert.equal(await staged.text(), 'probe');
        assert.equal((await fetch(`${srv.url}/api/health`)).status, 200, 'localhost is unaffected');
    });

    it('poll responses say whether to stop, why it failed, and when to poll next', async () => {
        const c = await call(srv, 'POST', '/api/video/generate', { form: { userMessage: 'p', refVideoUrl: 'https://x/y.mp4' } });
        const running = await call(srv, 'GET', `/api/video/tasks/${c.body.taskId}?attempt=7`);
        assert.deepEqual([running.full.terminal, running.full.failureReason, running.full.nextPollMs], [false, null, 10000]);
        srv.mock.rules([{ match: 'GET https://ark', response: { status: 200, json: { status: 'failed' } } }]);
        const failed = await call(srv, 'GET', `/api/video/tasks/${c.body.taskId}?attempt=8`);
        assert.deepEqual([failed.full.terminal, failed.full.failureReason, failed.full.nextPollMs], [true, 'Generation failed upstream.', null]);
        const list = await call(srv, 'GET', '/api/video/gallery');
        assert.ok(!list.full.pendingIds.includes(c.body.taskId));
    });

    it('catalogue and plan endpoints', async () => {
        const m = await call(srv, 'GET', '/api/models');
        assert.equal(m.body.image.defaultRatio, '3:4');
        assert.ok(!JSON.stringify(m.body).includes('ep-test-endpoint'), 'the endpoint id is not exposed');
        const modes = await call(srv, 'GET', '/api/video/modes');
        assert.deepEqual(modes.body.duration, { min: 4, max: 30, default: 5 });
        const plan = await call(srv, 'POST', '/api/video/plan', { json: { mode: 'edit', prompt: 'x', hasImage: true, duration: 3 } });
        assert.equal(plan.body.subtask, 'reference');
        assert.deepEqual(plan.body.accepts, { ratio: true, duration: true });
        assert.deepEqual(plan.body.problems.map(p => p.message), ['Duration must be between 4 and 30 seconds.']);
        const clip = await call(srv, 'POST', '/api/video/plan', { json: { mode: 'edit', prompt: 'x', hasVideo: true } });
        assert.deepEqual([clip.body.subtask, clip.body.ready], ['edit', true]);
        const compiled = await call(srv, 'POST', '/api/prompts/compile', { json: { text: 'A {{s:x}} {{t}}', values: { t: 'y', gone: 1 } } });
        assert.deepEqual(compiled.body.values, { s: 'x', t: 'y' });
        assert.equal(compiled.body.text, 'A x y');
        assert.deepEqual(compiled.body.segments, [{ text: 'A ' }, { slot: 's', value: 'x' }, { text: ' ' }, { slot: 't', value: 'y' }]);
    });
});
