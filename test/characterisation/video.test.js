// Pins the Seedance routes: task bodies for every subtask, every validation message,
// staging and unstaging, the poll → finalize path, and the video gallery.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, call, FILES } = require('../helpers/server');
const { expectUpstream } = require('../helpers/golden');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });
beforeEach(() => srv.mock.clear());

const create = (form) => call(srv, 'POST', '/api/video/generate', { form });
const poll = (id) => call(srv, 'GET', `/api/video/tasks/${encodeURIComponent(id)}`);
const lastArk = () => srv.mock.ark().at(-1);
const stagingFiles = () => fs.readdirSync(path.join(srv.dataDir, 'videos', 'staging'));
const manifest = () => JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'videos', 'manifest.json'), 'utf-8'));
const STAGED_RE = /^https:\/\/public\.example\.test\/videos\/staging\/\d+_[0-9a-f]{8}\.\w+$/;

const RECORD_KEYS = [
    'id', 'status', 'prompt', 'model', 'taskType', 'videoRatio', 'videoResolution', 'duration',
    'requestedRatio', 'requestedDuration', 'watermark', 'generateAudio', 'refSource', 'stagedPaths',
    'refImage', 'fullVideo', 'firstFrame', 'lastFrame', 'inputFirstFrame', 'inputLastFrame', 'createdAt', 'updatedAt'
];

describe('video task bodies', () => {
    it('edit from a pasted URL, minimal fields (mode defaults to edit)', async () => {
        const r = await create({ userMessage: '  neon night  ', refVideoUrl: ' https://cdn.example/clip.mp4 ' });
        assert.equal(r.status, 200);
        expectUpstream('video-edit-url', lastArk());
        assert.deepEqual(Object.keys(r.body), ['success', 'taskId', 'record']);
        assert.deepEqual(Object.keys(r.body.record), RECORD_KEYS);
        assert.equal(r.body.record.refSource, 'url');
        assert.equal(r.body.record.taskType, 'edit');
        assert.deepEqual(r.body.record.stagedPaths, []);
    });

    it('edit with every optional field; ratio/duration are not sent and not validated', async () => {
        const r = await create({
            mode: 'edit', userMessage: 'full', refVideoUrl: 'https://cdn.example/clip.mp4',
            model: 'dreamina-seedance-2-5-260628', resolution: '720p', watermark: 'true',
            generateAudio: 'true', seed: '42', ratio: '16:9', duration: '31'
        });
        assert.equal(r.status, 200);
        expectUpstream('video-edit-url-full', lastArk());
        assert.equal(r.body.record.requestedDuration, null);
        assert.equal(r.body.record.generateAudio, true);
    });

    it('edit with an uploaded clip and reference image: both staged behind PUBLIC_BASE_URL', async () => {
        const r = await create({ userMessage: 'upload', video: FILES.mp4(), image: FILES.png('look.png'), generateAudio: 'false' });
        assert.equal(r.status, 200);
        expectUpstream('video-edit-upload', lastArk());
        const body = JSON.parse(lastArk().raw);
        assert.match(body.content[1].video_url.url, STAGED_RE);
        assert.match(body.content[2].image_url.url, STAGED_RE);
        const rec = r.body.record;
        assert.equal(rec.refSource, 'upload');
        assert.equal(rec.refImage, `/videos/${rec.id}_ref.png`);
        assert.equal(rec.stagedPaths.length, 2);
        for (const p of rec.stagedPaths) {
            assert.ok(path.isAbsolute(p));
            assert.ok(fs.existsSync(p));
        }
        assert.ok(fs.existsSync(path.join(srv.dataDir, rec.refImage)));
    });

    it('reference image only → reference subtask with ratio and duration', async () => {
        const r = await create({ userMessage: 'ref', image: FILES.jpeg('r.jpg'), ratio: '9:16', duration: '8', generateAudio: 'false' });
        assert.equal(r.status, 200);
        expectUpstream('video-reference', lastArk());
        assert.equal(r.body.record.taskType, 'reference');
        assert.equal(r.body.record.refSource, 'image');
        assert.equal(r.body.record.requestedRatio, '9:16');
        assert.equal(r.body.record.requestedDuration, 8);
    });

    it('reference with no ratio and an empty duration → duration 5, no ratio', async () => {
        const r = await create({ userMessage: 'ref default', image: FILES.png(), duration: '' });
        assert.equal(r.status, 200);
        expectUpstream('video-reference-defaults', lastArk());
    });

    it('first frame only; ratio is never sent in frame mode', async () => {
        const r = await create({ mode: 'firstLast', userMessage: 'push in', firstFrame: FILES.png('first.png'), duration: '6', ratio: '16:9' });
        assert.equal(r.status, 200);
        expectUpstream('video-first-frame', lastArk());
        const rec = r.body.record;
        assert.equal(rec.taskType, 'first_last');
        assert.equal(rec.inputFirstFrame, `/videos/${rec.id}_infirst.png`);
        assert.equal(rec.inputLastFrame, null);
        assert.equal(rec.requestedRatio, null);
    });

    it('first and last frame; seed 0 is dropped', async () => {
        const r = await create({
            mode: 'firstLast', userMessage: 'morph', firstFrame: FILES.png('a.png'), lastFrame: FILES.jpeg('b.jpg'),
            seed: '0', generateAudio: 'true', resolution: '480p'
        });
        assert.equal(r.status, 200);
        expectUpstream('video-first-last', lastArk());
        assert.equal(r.body.record.inputLastFrame, `/videos/${r.body.record.id}_inlast.jpg`);
    });
});

describe('video validation (nothing reaches upstream)', () => {
    const cases = [
        ['edit without an instruction', { userMessage: '  ', refVideoUrl: 'https://x/y.mp4' }, 'An edit instruction is required.'],
        ['frames without a prompt', { mode: 'firstLast', firstFrame: FILES.png() }, 'A prompt is required.'],
        ['frames without a first frame', { mode: 'firstLast', userMessage: 'p', lastFrame: FILES.png() }, 'A first frame image is required.'],
        ['frames mixed with a reference URL', { mode: 'firstLast', userMessage: 'p', firstFrame: FILES.png(), refVideoUrl: 'https://x/y.mp4' },
            'First/last frame mode can\'t be combined with a reference video or reference image — the model rejects mixing them. Clear the reference media, or switch to Edit mode.'],
        ['frames mixed with a reference image', { mode: 'firstLast', userMessage: 'p', firstFrame: FILES.png(), image: FILES.png() },
            'First/last frame mode can\'t be combined with a reference video or reference image — the model rejects mixing them. Clear the reference media, or switch to Edit mode.'],
        ['frame images in edit mode', { userMessage: 'p', refVideoUrl: 'https://x/y.mp4', firstFrame: FILES.png() },
            'Frame images were supplied but the request is in Edit mode. Switch to first/last frame mode.'],
        ['edit with no reference at all', { userMessage: 'p' }, 'Add a reference video (upload a clip or provide a URL) or a reference image.'],
        ['reference duration below 4', { userMessage: 'p', image: FILES.png(), duration: '3' }, 'Duration must be between 4 and 30 seconds.'],
        ['reference duration above 30', { userMessage: 'p', image: FILES.png(), duration: '31' }, 'Duration must be between 4 and 30 seconds.'],
        ['frame duration not a number', { mode: 'firstLast', userMessage: 'p', firstFrame: FILES.png(), duration: 'abc' }, 'Duration must be between 4 and 30 seconds.'],
        ['upload over VIDEO_UPLOAD_LIMIT_MB', { userMessage: 'p', video: FILES.mp4('big.mp4', 1024 * 1024 + 1) },
            'File too large — the limit is 1 MB. Trim the clip, export it smaller, or raise VIDEO_UPLOAD_LIMIT_MB in .env.']
    ];
    for (const [name, form, error] of cases) {
        it(name, async () => {
            const staged = stagingFiles();
            const r = await create(form);
            assert.equal(r.status, 400);
            assert.deepEqual(r.body, { success: false, error });
            assert.equal(srv.mock.ark().length, 0);
            assert.deepEqual(stagingFiles(), staged, 'staged files must be cleaned up');
        });
    }
});

describe('uploads without a public URL', () => {
    let s;
    before(async () => { s = await startServer({ env: { PUBLIC_BASE_URL: '' } }); });
    after(async () => { await s?.stop(); });

    it('health reports uploads disabled', async () => {
        const h = await call(s, 'GET', '/api/health');
        assert.equal(h.body.videoUploadsEnabled, false);
        assert.equal(h.body.publicBaseUrl, null);
    });
    it('edit upload is refused and suggests a URL', async () => {
        const r = await call(s, 'POST', '/api/video/generate', { form: { userMessage: 'p', video: FILES.mp4() } });
        assert.deepEqual([r.status, r.body], [400, {
            success: false,
            error: 'Uploads are paused while the public tunnel reconnects — BytePlus downloads reference media itself, so this server must be reachable. It should recover within a few seconds; retry shortly, or paste a public video URL instead. (If AUTO_TUNNEL=0, set PUBLIC_BASE_URL yourself.)'
        }]);
    });
    it('frame upload is refused without the URL hint', async () => {
        const r = await call(s, 'POST', '/api/video/generate', { form: { mode: 'firstLast', userMessage: 'p', firstFrame: FILES.png() } });
        assert.equal(r.body.error, 'Uploads are paused while the public tunnel reconnects — BytePlus downloads reference media itself, so this server must be reachable. It should recover within a few seconds; retry shortly. (If AUTO_TUNNEL=0, set PUBLIC_BASE_URL yourself.)');
    });
    it('a pasted URL still works', async () => {
        const r = await call(s, 'POST', '/api/video/generate', { form: { userMessage: 'p', refVideoUrl: 'https://x/y.mp4' } });
        assert.equal(r.status, 200);
    });
});

describe('video upstream errors', () => {
    it('rejected task → upstream status, extracted message and raw body; staging cleaned', async () => {
        const err = { error: { code: 'InvalidParameter', message: 'video too short' } };
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 400, json: err } }]);
        const staged = stagingFiles();
        const r = await create({ userMessage: 'p', video: FILES.mp4() });
        assert.deepEqual([r.status, r.body], [400, { success: false, error: 'video too short', raw: JSON.stringify(err) }]);
        assert.deepEqual(stagingFiles(), staged);
    });
    it('string error and missing envelope', async () => {
        srv.mock.rules([
            { match: 'POST https://ark', response: { status: 400, json: { error: 'plain' } } },
            { match: 'POST https://ark', response: { status: 500, text: 'not json' } }
        ]);
        const a = await create({ userMessage: 'p', refVideoUrl: 'https://x/y.mp4' });
        assert.deepEqual(a.body, { success: false, error: 'plain', raw: '{"error":"plain"}' });
        const b = await create({ userMessage: 'p', refVideoUrl: 'https://x/y.mp4' });
        assert.deepEqual([b.status, b.body], [500, { success: false, error: 'Upstream 500', raw: 'not json' }]);
    });
    it('no task id → 502', async () => {
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 200, json: {} } }]);
        const r = await create({ userMessage: 'p', refVideoUrl: 'https://x/y.mp4' });
        assert.deepEqual([r.status, r.body], [502, { success: false, error: 'No task id returned by upstream.' }]);
    });
    it('network error → 500', async () => {
        srv.mock.rules([{ match: 'POST https://ark', response: { networkError: true } }]);
        const staged = stagingFiles();
        const r = await create({ userMessage: 'p', image: FILES.png() });
        assert.deepEqual([r.status, r.body], [500, { success: false, error: 'fetch failed (mock network error)' }]);
        assert.deepEqual(stagingFiles(), staged);
    });
    it('every key rejected → 503 with the last upstream text', async () => {
        srv.mock.rules([1, 2, 3].map(() => ({ match: 'POST https://ark', response: { status: 429, text: 'slow down' } })));
        const r = await create({ userMessage: 'p', refVideoUrl: 'https://x/y.mp4' });
        assert.deepEqual([r.status, r.body], [503, { success: false, error: 'slow down', raw: 'slow down' }]);
        assert.deepEqual(srv.mock.ark().map(x => x.keyIndex), [0, 1, 2]);
    });
});

describe('polling and finalize', () => {
    it('running → status persisted; the GET is a plain authenticated poll', async () => {
        const c = await create({ userMessage: 'poll me', refVideoUrl: 'https://x/y.mp4' });
        srv.mock.clear();
        const r = await poll(c.body.taskId);
        assert.equal(r.status, 200);
        assert.deepEqual(Object.keys(r.body), ['success', 'status', 'task', 'record']);
        assert.equal(r.body.status, 'running');
        expectUpstream('video-poll', { ...lastArk(), url: lastArk().url.replace(c.body.taskId, '<task>') });
        assert.equal(manifest().items.find(i => i.id === c.body.taskId).status, 'running');
    });

    it('unknown upstream statuses map to queued; cancelled maps to failed', async () => {
        const c = await create({ userMessage: 'q', refVideoUrl: 'https://x/y.mp4' });
        srv.mock.rules([
            { match: 'GET https://ark', response: { status: 200, json: { id: c.body.taskId, status: 'pending' } } },
            { match: 'GET https://ark', response: { status: 200, json: { id: c.body.taskId, status: 'cancelled' } } }
        ]);
        assert.equal((await poll(c.body.taskId)).body.status, 'queued');
        const r = await poll(c.body.taskId);
        assert.equal(r.body.status, 'failed');
        assert.equal(r.body.record.error, undefined);
    });

    it('succeeded → downloads clip and keyframes, learns ratio/duration, unstages inputs', async () => {
        const c = await create({ userMessage: 'finish', video: FILES.mp4(), image: FILES.png() });
        const staged = c.body.record.stagedPaths;
        const id = c.body.taskId;
        srv.mock.rules([{
            match: 'GET https://ark',
            response: {
                status: 200, json: {
                    id, status: 'succeeded', duration: 7, ratio: '16:9',
                    content: {
                        video_url: 'https://mock.cdn/out.mp4',
                        first_frame_image_url: 'https://mock.cdn/f.jpeg',
                        last_frame_image_url: 'https://mock.cdn/l.jpeg'
                    }
                }
            }
        }]);
        const r = await poll(id);
        assert.equal(r.body.status, 'succeeded');
        const rec = r.body.record;
        assert.equal(rec.fullVideo, `/videos/${id}.mp4`);
        assert.equal(rec.firstFrame, `/videos/${id}_first.jpg`);
        assert.equal(rec.lastFrame, `/videos/${id}_last.jpg`);
        assert.equal(rec.duration, 7);
        assert.equal(rec.videoRatio, '16:9');
        assert.equal(rec.stagedPaths, undefined);
        for (const p of staged) assert.ok(!fs.existsSync(p));
        for (const rel of [rec.fullVideo, rec.firstFrame, rec.lastFrame]) assert.ok(fs.existsSync(path.join(srv.dataDir, rel)));
        assert.deepEqual(manifest().items.find(i => i.id === id), rec);

        // A later poll of a finished task does not download again.
        srv.mock.clear();
        srv.mock.rules([{ match: 'GET https://ark', response: { status: 200, json: { id, status: 'succeeded', content: { video_url: 'https://mock.cdn/out.mp4' } } } }]);
        await poll(id);
        assert.equal(srv.mock.log().filter(l => l.url.startsWith('https://mock.cdn')).length, 0);
    });

    it('succeeded without top-level duration/ratio falls back to usage', async () => {
        const c = await create({ userMessage: 'usage', refVideoUrl: 'https://x/y.mp4' });
        srv.mock.rules([{ match: 'GET https://ark', response: { status: 200, json: { status: 'succeeded', usage: { duration: 12, ratio: '1:1' }, content: { video_url: 'https://mock.cdn/u.mp4' } } } }]);
        const rec = (await poll(c.body.taskId)).body.record;
        assert.deepEqual([rec.duration, rec.videoRatio], [12, '1:1']);
    });

    it('failed → error mirrored onto the record, staging cleaned', async () => {
        const c = await create({ userMessage: 'fail', image: FILES.png() });
        srv.mock.rules([{ match: 'GET https://ark', response: { status: 200, json: { status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'blocked' } } } }]);
        const r = await poll(c.body.taskId);
        assert.equal(r.body.status, 'failed');
        assert.equal(r.body.record.error, 'blocked');
        for (const p of c.body.record.stagedPaths) assert.ok(!fs.existsSync(p));
        assert.equal(r.body.record.stagedPaths, undefined);
    });

    it('poll rejected upstream → 502 with message and raw', async () => {
        const data = { error: { message: 'task not found' } };
        srv.mock.rules([{ match: 'GET https://ark', response: { status: 404, json: data } }]);
        const r = await poll('cgt-missing');
        assert.deepEqual([r.status, r.body], [502, { success: false, error: 'task not found', raw: JSON.stringify(data) }]);
    });

    it('poll with every key rejected → 503', async () => {
        srv.mock.rules([1, 2, 3].map(() => ({ match: 'GET https://ark', response: { status: 429, text: 'q' } })));
        const r = await poll('cgt-any');
        assert.deepEqual([r.status, r.body], [503, { success: false, error: 'All API keys exhausted.', raw: 'All API keys exhausted.' }]);
    });

    it('a task unknown locally but known upstream gets a stub record', async () => {
        srv.mock.rules([{ match: 'GET https://ark', response: { status: 200, json: { id: 'cgt-elsewhere', status: 'running', created_at: 1700000000 } } }]);
        const r = await poll('cgt-elsewhere');
        if (srv.target === 'legacy') {
            // Legacy bug: a non-queued status replaces the stub with { status, updatedAt },
            // so the manifest gains a record with no id. Fixed in core (intentional change).
            assert.deepEqual(Object.keys(r.body.record), ['status', 'updatedAt']);
            assert.equal(manifest().items[0].id, undefined);
            return;
        }
        assert.equal(r.body.record.id, 'cgt-elsewhere');
        assert.deepEqual(Object.keys(r.body.record), ['id', 'status', 'prompt', 'model', 'createdAt', 'updatedAt']);
        assert.equal(r.body.record.createdAt, 1700000000);
        assert.equal(manifest().items[0].id, 'cgt-elsewhere');
    });
});

describe('video gallery', () => {
    it('lists newest first, gets one, 404s', async () => {
        const c = await create({ userMessage: 'listed', refVideoUrl: 'https://x/y.mp4' });
        const list = await call(srv, 'GET', '/api/video/gallery');
        assert.equal(list.body.success, true);
        assert.equal(list.body.items[0].id, c.body.taskId);
        const one = await call(srv, 'GET', `/api/video/${c.body.taskId}`);
        assert.equal(one.body.item.id, c.body.taskId);
        const miss = await call(srv, 'GET', '/api/video/nope');
        assert.deepEqual([miss.status, miss.body], [404, { success: false, error: 'Not found.' }]);
    });

    it('delete removes the record and every file it names', async () => {
        const c = await create({ mode: 'firstLast', userMessage: 'del', firstFrame: FILES.png(), lastFrame: FILES.png() });
        const id = c.body.taskId;
        srv.mock.rules([{ match: 'GET https://ark', response: { status: 200, json: { status: 'succeeded', content: { video_url: 'https://mock.cdn/d.mp4', first_frame_image_url: 'https://mock.cdn/f.jpeg' } } } }]);
        const rec = (await poll(id)).body.record;
        const files = [rec.fullVideo, rec.firstFrame, rec.inputFirstFrame, rec.inputLastFrame].map(p => path.join(srv.dataDir, p));
        for (const f of files) assert.ok(fs.existsSync(f));
        const d = await call(srv, 'DELETE', `/api/video/${id}`);
        assert.deepEqual(d.body, { success: true });
        for (const f of files) assert.ok(!fs.existsSync(f));
        assert.equal(manifest().items.find(i => i.id === id), undefined);
        const again = await call(srv, 'DELETE', `/api/video/${id}`);
        assert.equal(again.status, 404);
    });
});
