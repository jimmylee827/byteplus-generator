// Pins POST /api/generate: the exact upstream body per model and input shape, the
// gallery record, the files written, key rotation, and every error path.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, call, FILES } = require('../helpers/server');
const { expectUpstream } = require('../helpers/golden');

const ID_RE = /^\d{8}_\d{6}_\d{3}(_\d+)?$/;
let srv;

before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });
beforeEach(() => srv.mock.clear());

const generate = (form) => call(srv, 'POST', '/api/generate', { form });
const lastArk = () => srv.mock.ark().at(-1);

describe('image request bodies', () => {
    it('endpoint model, text only, trims the prompt', async () => {
        const r = await generate({ prompt: '  a red fox in snow  ', model: 'endpoint', size: '1728x2304', watermark: 'false' });
        assert.equal(r.status, 200);
        expectUpstream('image-endpoint-text', lastArk());
    });

    it('defaults: no model, no size, no watermark', async () => {
        const r = await generate({ prompt: 'defaults' });
        assert.equal(r.status, 200);
        expectUpstream('image-defaults', lastArk());
        assert.equal(r.body.item.requestedSize, '4K');
        assert.equal(r.body.item.watermark, false);
    });

    it('Seedream 5.0 Pro drops sequential/stream and forwards output_format', async () => {
        const r = await generate({
            prompt: 'pro', model: 'dola-seedream-5-0-pro-260628', size: '1776x2368', output_format: 'jpeg', watermark: 'true'
        });
        assert.equal(r.status, 200);
        expectUpstream('image-5-0-pro', lastArk());
    });

    it('output_format "auto" is not sent; pass-through model ids keep sequential/stream', async () => {
        const r = await generate({ prompt: 'pass', model: 'seedream-4-0-250828', size: '2K', output_format: 'auto' });
        assert.equal(r.status, 200);
        expectUpstream('image-passthrough', lastArk());
    });

    it('one reference image is sent as a single data URI', async () => {
        const r = await generate({ prompt: 'one ref', size: '4K', images: FILES.png('a.png') });
        assert.equal(r.status, 200);
        expectUpstream('image-one-ref', lastArk());
        assert.equal(r.body.item.inputCount, 1);
        assert.deepEqual(r.body.item.inputThumbs, [`/gallery/${r.body.item.id}_in_0.png`]);
    });

    it('nine reference images are sent as an array; thumbs keep their extensions', async () => {
        const images = Array.from({ length: 9 }, (_, i) => (i % 2 ? FILES.jpeg(`r${i}.jpg`) : FILES.png(`r${i}.png`)));
        const r = await generate({ prompt: 'nine refs', size: '2K', images });
        assert.equal(r.status, 200);
        expectUpstream('image-nine-refs', lastArk());
        const { id, inputThumbs } = r.body.item;
        assert.equal(inputThumbs.length, 9);
        assert.equal(inputThumbs[1], `/gallery/${id}_in_1.jpg`);
        for (const t of inputThumbs) assert.ok(fs.existsSync(path.join(srv.dataDir, t)));
    });

    it('a tenth image is rejected by the upload limit', async () => {
        const images = Array.from({ length: 10 }, (_, i) => FILES.png(`r${i}.png`));
        const r = await generate({ prompt: 'ten', images });
        assert.notEqual(r.status, 200);
        assert.equal(srv.mock.ark().length, 0);
    });
});

describe('image record and files', () => {
    it('downloads the result, records it newest first', async () => {
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 200, json: { data: [{ url: 'https://mock.cdn/x.jpeg', size: '2048x2048' }] } } }]);
        const r = await generate({ prompt: 'record me', model: 'endpoint', size: '2K' });
        assert.equal(r.status, 200);
        const item = r.body.item;
        assert.match(item.id, ID_RE);
        assert.deepEqual(Object.keys(item), [
            'id', 'prompt', 'model', 'size', 'requestedSize', 'watermark', 'inputCount', 'inputThumbs', 'outputPath', 'createdAt'
        ]);
        assert.equal(item.model, 'ep-test-endpoint-0001');
        assert.equal(item.size, '2048x2048');
        assert.equal(item.requestedSize, '2K');
        assert.equal(item.outputPath, `/gallery/${item.id}.jpeg`);
        assert.ok(fs.existsSync(path.join(srv.dataDir, item.outputPath)));
        const manifest = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'gallery', 'manifest.json'), 'utf-8'));
        assert.equal(manifest.items[0].id, item.id);
        const dl = srv.mock.log().at(-1);
        assert.equal(dl.url, 'https://mock.cdn/x.jpeg');
    });

    it('concurrent generations all succeed, with unique ids, and are all recorded', async (t) => {
        if (srv.target === 'legacy') {
            // Legacy bug: the manifest is rewritten in place without a lock, so a
            // concurrent reader can see a half-written file and the request fails with a
            // JSON parse error after the image was already downloaded. Fixed by the
            // locked, atomic store.
            t.skip('legacy manifest writes race (see comment)');
            return;
        }
        const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => generate({ prompt: `c${i}` })));
        assert.deepEqual(rs.map(r => r.status), rs.map(() => 200));
        const ids = rs.map(r => r.body.item.id);
        assert.equal(new Set(ids).size, ids.length);
        for (const id of ids) assert.match(id, ID_RE);
        const recorded = new Set(JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'gallery', 'manifest.json'), 'utf-8')).items.map(i => i.id));
        for (const id of ids) assert.ok(recorded.has(id), `record ${id} missing from the manifest`);
    });
});

describe('image errors', () => {
    it('missing or blank prompt → 400', async () => {
        for (const prompt of [undefined, '   ']) {
            const r = await generate(prompt === undefined ? { size: '2K' } : { prompt });
            assert.equal(r.status, 400);
            assert.deepEqual(r.body, { success: false, error: 'Prompt is required.' });
        }
        assert.equal(srv.mock.ark().length, 0);
    });

    it('upstream JSON error envelope → its message, with the upstream status', async () => {
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 400, json: { error: { code: 'InvalidParameter', message: 'size is invalid' } } } }]);
        const r = await generate({ prompt: 'bad size', size: '9K' });
        assert.equal(r.status, 400);
        assert.deepEqual(r.body, { success: false, error: 'size is invalid' });
    });

    it('upstream error with code only → the code', async () => {
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 422, json: { error: { code: 'OnlyCode' } } } }]);
        const r = await generate({ prompt: 'code only' });
        assert.deepEqual([r.status, r.body], [422, { success: false, error: 'OnlyCode' }]);
    });

    it('upstream plain-text error → the raw text', async () => {
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 500, text: 'boom' } }]);
        const r = await generate({ prompt: 'text error' });
        assert.deepEqual([r.status, r.body], [500, { success: false, error: 'boom' }]);
    });

    it('no url in the upstream response → 502', async () => {
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 200, json: { data: [] } } }]);
        const r = await generate({ prompt: 'empty' });
        assert.deepEqual([r.status, r.body], [502, { success: false, error: 'No image returned by upstream.' }]);
    });

    it('download failure → 502, nothing recorded', async () => {
        srv.mock.rules([{ match: 'GET https://mock.cdn', response: { status: 404, text: 'gone' } }]);
        const before = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'gallery', 'manifest.json'), 'utf-8')).items.length;
        const r = await generate({ prompt: 'no download' });
        assert.deepEqual([r.status, r.body], [502, { success: false, error: 'Failed to save image locally.' }]);
        const afterCount = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'gallery', 'manifest.json'), 'utf-8')).items.length;
        assert.equal(afterCount, before);
    });

    it('network error → 500 with the error message', async () => {
        srv.mock.rules([{ match: 'POST https://ark', response: { networkError: true } }]);
        const r = await generate({ prompt: 'offline' });
        assert.deepEqual([r.status, r.body], [500, { success: false, error: 'fetch failed (mock network error)' }]);
    });
});

describe('key rotation (fresh server per case)', () => {
    let s;
    beforeEach(async () => { await s?.stop(); s = await startServer(); });
    after(async () => { await s?.stop(); });
    const gen = (prompt) => call(s, 'POST', '/api/generate', { form: { prompt } });
    const keyIndexes = () => s.mock.ark().map(r => r.keyIndex);

    for (const status of [402, 403, 429]) {
        it(`${status} rotates to the next key without disabling`, async () => {
            s.mock.rules([{ match: 'POST https://ark', response: { status, text: 'quota' } }]);
            assert.equal((await gen('a')).status, 200);
            assert.deepEqual(keyIndexes(), [0, 1]);
            // key 0 is still usable: two more 429s walk 1 → 2 → 0
            s.mock.rules([
                { match: 'POST https://ark', response: { status: 429, text: 'q' } },
                { match: 'POST https://ark', response: { status: 429, text: 'q' } }
            ]);
            assert.equal((await gen('b')).status, 200);
            assert.deepEqual(keyIndexes(), [0, 1, 1, 2, 0]);
        });
    }

    it('401 disables the key: later rotation skips it', async () => {
        s.mock.rules([{ match: 'POST https://ark', response: { status: 401, text: 'bad key' } }]);
        assert.equal((await gen('a')).status, 200);
        // Only two keys are active now, so each call gets at most two attempts.
        s.mock.rules([{ match: 'POST https://ark', response: { status: 429, text: 'q' } }]);
        assert.equal((await gen('b')).status, 200);
        s.mock.rules([{ match: 'POST https://ark', response: { status: 429, text: 'q' } }]);
        assert.equal((await gen('c')).status, 200);
        assert.deepEqual(keyIndexes(), [0, 1, 1, 2, 2, 1]);
        const h = await call(s, 'GET', '/api/health');
        assert.equal(h.body.activeKeys, 2);
        assert.equal(h.body.totalKeys, 3);
    });

    it('every key rejected → 503 after one attempt per active key', async () => {
        s.mock.rules([1, 2, 3].map(() => ({ match: 'POST https://ark', response: { status: 429, text: 'q' } })));
        const r = await gen('exhaust');
        assert.deepEqual([r.status, r.body], [503, { success: false, error: 'All API keys exhausted or invalid.' }]);
        assert.deepEqual(keyIndexes(), [0, 1, 2]);
    });

    it('all keys 401 → disabled; the next call fails immediately', async () => {
        s.mock.rules([1, 2, 3].map(() => ({ match: 'POST https://ark', response: { status: 401, text: 'bad' } })));
        assert.equal((await gen('x')).status, 503);
        s.mock.clear();
        const r = await gen('y');
        assert.deepEqual([r.status, r.body], [503, { success: false, error: 'All API keys exhausted or invalid.' }]);
        assert.equal(s.mock.ark().length, 0);
        assert.equal((await call(s, 'GET', '/api/health')).body.activeKeys, 0);
    });

    it('hot-swaps after 200 successful uses', async () => {
        for (let i = 0; i < 200; i++) assert.equal((await gen(`u${i}`)).status, 200);
        assert.ok(keyIndexes().every(k => k === 0));
        await gen('201st');
        assert.equal(keyIndexes().at(-1), 1);
    });
});

describe('health', () => {
    it('reports keys and uploads', async () => {
        const r = await call(srv, 'GET', '/api/health');
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        assert.equal(r.body.totalKeys, 3);
        assert.equal(r.body.videoEnabled, true);
        assert.equal(r.body.videoUploadsEnabled, true);
        assert.equal(r.body.publicBaseUrl, 'https://public.example.test');
    });
});
