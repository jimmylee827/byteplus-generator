// Parity: every HTTP route and its CLI command, given the same input on the same data
// folder, return the same JSON (ids and timestamps aside) and send the same bytes to
// BytePlus.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, call, FILES } = require('../helpers/server');
const { runCli } = require('../helpers/cli');
const { normalizeRaw } = require('../helpers/golden');

let srv;
let inputs;
before(async () => {
    srv = await startServer();
    inputs = path.join(srv.dataDir, 'inputs');
    fs.mkdirSync(inputs);
    for (const f of [FILES.png('a.png'), FILES.jpeg('b.jpg'), FILES.mp4('clip.mp4')]) fs.writeFileSync(path.join(inputs, f.name), f.bytes);
});
after(async () => { await srv?.stop(); });

const cli = async (...args) => {
    const r = await runCli([...args, '--json'], { dataDir: srv.dataDir, mockDir: srv.mockDir });
    assert.ok(r.json, `no JSON from \`${args.join(' ')}\`:\n${r.stdout}\n${r.stderr}`);
    return r;
};
const http = async (method, route, opts) => (await call(srv, method, route, opts)).full;
const inp = (name) => path.join(inputs, name);

// Ids and timestamps differ by construction; everything else must match.
const ID_PATTERNS = [
    /\d{8}_\d{6}_\d{3}(_\d+)?/g,                                   // gallery ids
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, // prompt ids
    /cgt-mock-\d+/g,                                                // task ids
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,                 // timestamps
    /\/videos\/staging\/\d+_[0-9a-f]{8}/g                           // staged names
];
function norm(v) {
    let s = JSON.stringify(v);
    for (const re of ID_PATTERNS) s = s.replace(re, '<x>');
    return JSON.parse(s);
}
const same = (a, b, label) => assert.deepEqual(norm(a), norm(b), label);
const lastTwoArkBodies = () => srv.mock.ark().slice(-2).map(r => normalizeRaw(r.raw));

describe('HTTP ↔ CLI parity', () => {
    it('health and models', async () => {
        same(await http('GET', '/api/health'), (await cli('health')).json, 'health');
        same(await http('GET', '/api/models'), (await cli('models')).json, 'models');
        same(await http('GET', '/api/video/modes'), (await cli('video', 'modes')).json, 'video modes');
    });

    it('image generate: same record, same upstream bytes', async () => {
        const h = await http('POST', '/api/generate', {
            form: { prompt: 'parity {{s:x}}', slots: JSON.stringify({ s: 'y' }), model: 'dola-seedream-5-0-pro-260628', resolution: '1.5K', ratio: '2:3', images: [FILES.png('a.png'), FILES.jpeg('b.jpg')] }
        });
        const c = await cli('image', 'generate', '-p', 'parity {{s:x}}', '--slot', 's=y', '--model', 'dola-seedream-5-0-pro-260628',
            '--resolution', '1.5K', '--ratio', '2:3', '--image', inp('a.png'), '--image', inp('b.jpg'));
        same(h, c.json, 'generate result');
        const [hb, cb] = lastTwoArkBodies();
        assert.equal(cb, hb, 'upstream request bodies differ');
    });

    it('image generate errors', async () => {
        const h = await call(srv, 'POST', '/api/generate', { form: { prompt: '  ' } });
        const c = await runCli(['image', 'generate', '-p', '  ', '--json'], { dataDir: srv.dataDir, mockDir: srv.mockDir });
        same(h.full, c.json);
        assert.deepEqual([h.status, c.code], [400, 2]);
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 400, json: { error: { message: 'bad' } } } }]);
        const h2 = await call(srv, 'POST', '/api/generate', { form: { prompt: 'x' } });
        srv.mock.rules([{ match: 'POST https://ark', response: { status: 400, json: { error: { message: 'bad' } } } }]);
        const c2 = await runCli(['image', 'generate', '-p', 'x', '--json'], { dataDir: srv.dataDir, mockDir: srv.mockDir });
        same(h2.full, c2.json);
        assert.deepEqual([h2.status, c2.code], [400, 3]);
    });

    it('gallery list / show / delete', async () => {
        same(await http('GET', '/api/gallery'), (await cli('gallery', 'list')).json, 'list');
        same(await http('GET', '/api/gallery?search=PARITY&limit=1'), (await cli('gallery', 'list', '--search', 'PARITY', '--limit', '1')).json, 'search');
        const [first, second] = (await http('GET', '/api/gallery')).items;
        same(await http('GET', `/api/gallery/${first.id}`), (await cli('gallery', 'show', first.id)).json, 'show');
        same(await http('GET', '/api/gallery/nope'), (await runCli(['gallery', 'show', 'nope', '--json'], { dataDir: srv.dataDir, mockDir: srv.mockDir })).json, '404');
        same(await http('DELETE', `/api/gallery/${first.id}`), (await runCli(['gallery', 'delete', second.id, '--yes', '--json'], { dataDir: srv.dataDir, mockDir: srv.mockDir })).json, 'delete');
    });

    it('prompt library', async () => {
        const hc = await http('POST', '/api/prompts', { json: { title: 'Parity', body: 'A {{a:1}} {{b}}' } });
        const cc = (await cli('prompts', 'create', '--title', 'Parity', '--body', 'A {{a:1}} {{b}}')).json;
        same(hc, cc, 'create');
        same(await http('GET', '/api/prompts'), (await cli('prompts', 'list')).json, 'list');
        same(await http('GET', '/api/prompts?search=parity'), (await cli('prompts', 'list', '--search', 'parity')).json, 'search');
        same(await http('GET', `/api/prompts/${hc.item.id}`), (await cli('prompts', 'show', cc.item.id)).json, 'show');
        same(await http('PUT', `/api/prompts/${hc.item.id}`, { json: { body: 'B {{a:2}}' } }), (await cli('prompts', 'update', cc.item.id, '--body', 'B {{a:2}}')).json, 'update');
        same(await http('POST', `/api/prompts/${hc.item.id}/restore/1`), (await cli('prompts', 'restore', cc.item.id, '1')).json, 'restore');
        same(await http('POST', '/api/prompts/slots', { json: { id: hc.item.id } }), (await cli('prompts', 'slots', cc.item.id)).json, 'slots');
        same(await http('POST', '/api/prompts/compile', { json: { text: 'X {{a:1}} {{b}}', values: { b: 'q' } } }),
            (await cli('prompts', 'compile', '--text', 'X {{a:1}} {{b}}', '--slot', 'b=q')).json, 'compile');
        same(await http('DELETE', `/api/prompts/${hc.item.id}`), (await cli('prompts', 'delete', cc.item.id, '--yes')).json, 'delete');
    });

    it('video plan, create, status, list, show, delete', async () => {
        same(await http('POST', '/api/video/plan', { json: { mode: 'edit', prompt: 'p', hasImage: true, duration: 8 } }),
            (await cli('video', 'plan', '-p', 'p', '--image', inp('a.png'), '--duration', '8')).json, 'plan');

        const h = await http('POST', '/api/video/generate', { form: { userMessage: 'clip', video: FILES.mp4('clip.mp4'), image: FILES.png('a.png'), generateAudio: 'true', resolution: '720p' } });
        const c = await cli('video', 'create', '-p', 'clip', '--video', inp('clip.mp4'), '--image', inp('a.png'), '--audio', '--resolution', '720p');
        same(h, c.json, 'create');
        const [hb, cb] = lastTwoArkBodies();
        assert.equal(cb.replace(/\/videos\/staging\/<staged>/g, ''), hb.replace(/\/videos\/staging\/<staged>/g, ''), 'upstream task bodies differ');

        const hf = await http('POST', '/api/video/generate', { form: { mode: 'firstLast', userMessage: 'f', firstFrame: FILES.png('a.png'), lastFrame: FILES.jpeg('b.jpg'), duration: '6' } });
        const cf = await cli('video', 'create', '--mode', 'first-last', '-p', 'f', '--first-frame', inp('a.png'), '--last-frame', inp('b.jpg'), '--duration', '6');
        same(hf, cf.json, 'create first-last');

        const done = (id) => ({ match: `tasks/${id}`, response: { status: 200, json: { id, status: 'succeeded', duration: 5, ratio: '16:9', content: { video_url: 'https://mock.cdn/v.mp4' } } } });
        srv.mock.rules([done(h.taskId), done(c.json.taskId)]);
        same(await http('GET', `/api/video/tasks/${h.taskId}`), (await cli('video', 'status', c.json.taskId)).json, 'status');
        same(await http('GET', '/api/video/gallery'), (await cli('video', 'list')).json, 'list');
        same(await http('GET', `/api/video/${h.taskId}`), (await cli('video', 'show', c.json.taskId)).json, 'show');
        same(await http('DELETE', `/api/video/${h.taskId}`), (await cli('video', 'delete', c.json.taskId, '--yes')).json, 'delete');
    });
});
