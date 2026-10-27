// Pins the gallery read/delete routes and the prompt library's versioning rules.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, call, FILES } = require('../helpers/server');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

describe('gallery', () => {
    it('list, get, 404', async () => {
        const g = await call(srv, 'POST', '/api/generate', { form: { prompt: 'kept', images: FILES.png() } });
        const id = g.body.item.id;
        const list = await call(srv, 'GET', '/api/gallery');
        assert.equal(list.body.success, true);
        assert.equal(list.body.items[0].id, id);
        const one = await call(srv, 'GET', `/api/gallery/${id}`);
        assert.equal(one.body.item.prompt, 'kept');
        const miss = await call(srv, 'GET', '/api/gallery/nope');
        assert.deepEqual([miss.status, miss.body], [404, { success: false, error: 'Not found.' }]);
    });

    it('delete removes the output, the input thumbs and the record', async () => {
        const g = await call(srv, 'POST', '/api/generate', { form: { prompt: 'gone', images: [FILES.png(), FILES.jpeg()] } });
        const item = g.body.item;
        const files = [item.outputPath, ...item.inputThumbs].map(p => path.join(srv.dataDir, p));
        for (const f of files) assert.ok(fs.existsSync(f));
        const d = await call(srv, 'DELETE', `/api/gallery/${item.id}`);
        assert.deepEqual(d.body, { success: true });
        for (const f of files) assert.ok(!fs.existsSync(f));
        assert.equal((await call(srv, 'GET', `/api/gallery/${item.id}`)).status, 404);
        assert.equal((await call(srv, 'DELETE', `/api/gallery/${item.id}`)).status, 404);
    });
});

describe('prompt library', () => {
    let id;

    it('create validates title and body type', async () => {
        const noTitle = await call(srv, 'POST', '/api/prompts', { json: { title: '  ', body: 'x' } });
        assert.deepEqual([noTitle.status, noTitle.body], [400, { success: false, error: 'Title is required.' }]);
        const noBody = await call(srv, 'POST', '/api/prompts', { json: { title: 't' } });
        assert.deepEqual([noBody.status, noBody.body], [400, { success: false, error: 'Body is required.' }]);
    });

    it('create → v1 summary with a trimmed title', async () => {
        const r = await call(srv, 'POST', '/api/prompts', { json: { title: '  City  ', body: 'A {{style:cyberpunk}} city' } });
        assert.equal(r.status, 200);
        const it = r.body.item;
        assert.deepEqual(Object.keys(it), ['id', 'title', 'body', 'currentVersion', 'versionCount', 'createdAt', 'updatedAt']);
        assert.equal(it.title, 'City');
        assert.equal(it.currentVersion, 1);
        assert.equal(it.versionCount, 1);
        assert.match(it.id, /^[0-9a-f-]{36}$/);
        id = it.id;
    });

    it('list returns summaries newest first; get returns versions', async () => {
        await call(srv, 'POST', '/api/prompts', { json: { title: 'Second', body: 'b' } });
        const list = await call(srv, 'GET', '/api/prompts');
        assert.equal(list.body.items[0].title, 'Second');
        assert.equal(list.body.items[1].id, id);
        assert.equal(list.body.items[1].body, 'A {{style:cyberpunk}} city');
        const full = await call(srv, 'GET', `/api/prompts/${id}`);
        assert.deepEqual(Object.keys(full.body.item), ['id', 'title', 'currentVersion', 'versions', 'createdAt', 'updatedAt']);
        assert.deepEqual(Object.keys(full.body.item.versions[0]), ['version', 'body', 'createdAt']);
        assert.equal((await call(srv, 'GET', '/api/prompts/nope')).status, 404);
    });

    it('update: a new body bumps the version; the same body does not', async () => {
        const a = await call(srv, 'PUT', `/api/prompts/${id}`, { json: { body: 'A {{style:noir}} city' } });
        assert.equal(a.body.item.currentVersion, 2);
        const b = await call(srv, 'PUT', `/api/prompts/${id}`, { json: { body: 'A {{style:noir}} city' } });
        assert.equal(b.body.item.currentVersion, 2);
        assert.equal(b.body.item.updatedAt, a.body.item.updatedAt);
    });

    it('update: a title-only change touches updatedAt but adds no version; blank titles are ignored', async () => {
        const before = (await call(srv, 'GET', `/api/prompts/${id}`)).body.item;
        await new Promise(r => setTimeout(r, 5));
        const r = await call(srv, 'PUT', `/api/prompts/${id}`, { json: { title: ' Noir City ' } });
        assert.equal(r.body.item.title, 'Noir City');
        assert.equal(r.body.item.currentVersion, 2);
        assert.notEqual(r.body.item.updatedAt, before.updatedAt);
        const blank = await call(srv, 'PUT', `/api/prompts/${id}`, { json: { title: '   ' } });
        assert.equal(blank.body.item.title, 'Noir City');
        assert.equal((await call(srv, 'PUT', '/api/prompts/nope', { json: { body: 'x' } })).status, 404);
    });

    it('restore copies an old version forward as a new version', async () => {
        const r = await call(srv, 'POST', `/api/prompts/${id}/restore/1`);
        assert.equal(r.body.item.currentVersion, 3);
        assert.equal(r.body.item.body, 'A {{style:cyberpunk}} city');
        const full = (await call(srv, 'GET', `/api/prompts/${id}`)).body.item;
        assert.deepEqual(full.versions.map(v => v.version), [1, 2, 3]);
        assert.equal(full.versions[2].restoredFrom, 1);
        assert.deepEqual(Object.keys(full.versions[2]), ['version', 'body', 'createdAt', 'restoredFrom']);
        const miss = await call(srv, 'POST', `/api/prompts/${id}/restore/99`);
        assert.deepEqual([miss.status, miss.body], [404, { success: false, error: 'Version not found.' }]);
        assert.equal((await call(srv, 'POST', '/api/prompts/nope/restore/1')).status, 404);
    });

    it('blank bodies and restoring the current version (UI blocks both)', async () => {
        const blank = await call(srv, 'POST', '/api/prompts', { json: { title: 'Blank', body: '   ' } });
        const cur = await call(srv, 'POST', `/api/prompts/${id}/restore/3`);
        if (srv.target === 'legacy') {
            // Legacy accepts both; core rejects them (intentional change, plan §11.4).
            assert.equal(blank.status, 200);
            assert.equal(cur.body.item.currentVersion, 4);
            await call(srv, 'DELETE', `/api/prompts/${blank.body.item.id}`);
            return;
        }
        assert.deepEqual([blank.status, blank.body.code], [400, 'VALIDATION']);
        assert.equal(blank.body.error, 'Body is required.');
        assert.deepEqual([cur.status, cur.body.code], [400, 'VALIDATION']);
        assert.equal(cur.body.error, 'That is already the current version.');
    });

    it('delete removes the prompt and all versions', async () => {
        const d = await call(srv, 'DELETE', `/api/prompts/${id}`);
        assert.deepEqual(d.body, { success: true });
        assert.equal((await call(srv, 'GET', `/api/prompts/${id}`)).status, 404);
        assert.equal((await call(srv, 'DELETE', `/api/prompts/${id}`)).status, 404);
    });

    it('library.json keeps its on-disk shape and formatting', async () => {
        const raw = fs.readFileSync(path.join(srv.dataDir, 'prompts', 'library.json'), 'utf-8');
        assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2));
        assert.deepEqual(Object.keys(JSON.parse(raw)), ['items']);
    });
});
