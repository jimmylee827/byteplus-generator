// CLI conventions: exit codes, --json discipline, stdin, confirmations, dry runs,
// uploads without a public URL, and waiting on video tasks without the browser.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, FILES } = require('../helpers/server');
const { runCli } = require('../helpers/cli');

let dataDir, mockDir, inputs;
const mockRules = (list) => {
    const f = path.join(mockDir, 'rules.json');
    const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : [];
    fs.writeFileSync(f, JSON.stringify(cur.concat(list)));
};
const mockLog = () => (fs.existsSync(path.join(mockDir, 'log.jsonl'))
    ? fs.readFileSync(path.join(mockDir, 'log.jsonl'), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const ark = () => mockLog().filter(r => r.url.startsWith('https://ark.'));
const run = (args, opts = {}) => runCli(args, { dataDir, mockDir, ...opts });

before(() => {
    dataDir = makeTmp('ams-cli-');
    mockDir = makeTmp('ams-mock-');
    fs.writeFileSync(path.join(mockDir, 'rules.json'), '[]');
    inputs = path.join(dataDir, 'inputs');
    fs.mkdirSync(inputs);
    fs.writeFileSync(path.join(inputs, 'a.png'), FILES.png().bytes);
    fs.writeFileSync(path.join(inputs, 'clip.mp4'), FILES.mp4().bytes);
    fs.writeFileSync(path.join(inputs, 'prompt.txt'), 'from a {{kind:file}}\n');
});

describe('output and exit codes', () => {
    it('--json prints exactly one document on stdout, logs go to stderr', async () => {
        const r = await run(['image', 'generate', '-p', 'one doc', '--json', '--verbose']);
        assert.equal(r.code, 0);
        assert.equal(r.json.success, true);
        assert.match(r.stderr, /\[KEY\] index=0 uses=1/);
        assert.ok(path.isAbsolute(r.json.item.paths.output));
        assert.ok(fs.existsSync(r.json.item.paths.output));
    });

    it('text output: gallery path prints the absolute file path', async () => {
        const list = await run(['gallery', 'list', '--json']);
        const r = await run(['gallery', 'path', list.json.items[0].id]);
        assert.equal(r.stdout.trim(), path.join(dataDir, 'gallery', `${list.json.items[0].id}.jpeg`));
    });

    it('usage errors exit 2 with the error envelope', async () => {
        const unknown = await run(['gallery', 'list', '--nope', '--json']);
        assert.equal(unknown.code, 2);
        assert.equal(unknown.json.code, 'USAGE');
        const missing = await run(['gallery', 'show']);
        assert.equal(missing.code, 2);
        assert.match(missing.stderr, /Missing ID/);
        const bad = await run(['video', 'create', '-p', 'x', '--duration', 'soon', '--json']);
        assert.deepEqual([bad.code, bad.json.code], [2, 'USAGE']);
    });

    it('destructive commands need --yes when stdin is not a terminal', async () => {
        const list = await run(['gallery', 'list', '--json']);
        const id = list.json.items[0].id;
        const r = await run(['gallery', 'delete', id, '--json']);
        assert.deepEqual([r.code, r.json.code], [2, 'USAGE']);
        assert.match(r.json.error, /without --yes/);
        assert.equal((await run(['gallery', 'show', id, '--json'])).code, 0, 'nothing was deleted');
        assert.equal((await run(['gallery', 'delete', id, '--yes', '--json'])).code, 0);
        assert.equal((await run(['gallery', 'show', id, '--json'])).code, 5);
    });
});

describe('prompt sources', () => {
    it('-p - reads stdin', async () => {
        const r = await run(['image', 'generate', '-p', '-', '--json'], { stdin: 'piped {{x:in}}\n' });
        assert.equal(r.code, 0);
        assert.equal(JSON.parse(ark().at(-1).raw).prompt, 'piped in');
    });
    it('--prompt-file and --from-prompt (slot defaults apply)', async () => {
        await run(['image', 'generate', '--prompt-file', path.join(inputs, 'prompt.txt'), '--json']);
        assert.equal(JSON.parse(ark().at(-1).raw).prompt, 'from a file');
        const created = await run(['prompts', 'create', '--title', 'Lib', '--body-file', '-', '--json'], { stdin: 'saved {{who:me}}' });
        await run(['image', 'generate', '--from-prompt', created.json.item.id, '--slot', 'who=you', '--json']);
        assert.equal(JSON.parse(ark().at(-1).raw).prompt, 'saved you');
    });
    it('exactly one prompt source', async () => {
        const r = await run(['image', 'generate', '-p', 'a', '--prompt-file', 'x', '--json']);
        assert.deepEqual([r.code, r.json.code], [2, 'USAGE']);
    });
});

describe('dry runs cost nothing and hide secrets', () => {
    it('image: masked endpoint id, images summarised, no call, no record', async () => {
        const before = ark().length;
        const galleryBefore = (await run(['gallery', 'list', '--json'])).json.items.length;
        const r = await run(['image', 'generate', '-p', 'dry', '--image', path.join(inputs, 'a.png'), '--ratio', '3:4', '--dry-run', '--json']);
        assert.equal(r.code, 0);
        assert.deepEqual(r.json.request.body, {
            model: '****0001', prompt: 'dry', response_format: 'url', size: '3520x4704', watermark: false,
            sequential_image_generation: 'disabled', stream: false, image: '<data-uri: 8 bytes>'
        });
        assert.ok(!r.stdout.includes('key-aaaa1111') && !r.stdout.includes('ep-test-endpoint'));
        assert.equal(ark().length, before);
        assert.equal((await run(['gallery', 'list', '--json'])).json.items.length, galleryBefore);
    });
    it('video: staged uploads are described, not staged', async () => {
        const r = await run(['video', 'create', '-p', 'dry', '--video', path.join(inputs, 'clip.mp4'), '--dry-run', '--json']);
        assert.equal(r.code, 0);
        assert.equal(r.json.request.body.content[1].video_url.url, '<staged-upload: clip.mp4, 64 bytes>');
        const staging = path.join(dataDir, 'videos', 'staging');
        assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], []);
    });
    it('config show and keys status never show a key', async () => {
        const c = await run(['config', 'show', '--json']);
        const k = await run(['keys', 'status', '--json']);
        for (const out of [c.stdout, k.stdout]) {
            assert.ok(!/key-(aaaa1111|bbbb2222|cccc3333)/.test(out));
            assert.ok(!out.includes('ep-test-endpoint-0001'));
        }
        assert.deepEqual(c.json.config.apiKeys, ['****1111', '****2222', '****3333']);
        assert.equal(c.json.config.endpointId, '****0001');
    });
});

describe('uploads and the public URL', () => {
    it('local files without a public URL → exit 6 with what to do', async () => {
        const r = await run(['video', 'create', '-p', 'x', '--video', path.join(inputs, 'clip.mp4'), '--json'], { env: { PUBLIC_BASE_URL: '' } });
        assert.deepEqual([r.code, r.json.code], [6, 'UPLOADS_UNAVAILABLE']);
        assert.match(r.json.error, /ai-media-studio tunnel up/);
        const url = await run(['video', 'create', '-p', 'x', '--video', 'https://cdn.example/c.mp4', '--json'], { env: { PUBLIC_BASE_URL: '' } });
        assert.equal(url.code, 0, 'a public URL needs no tunnel');
    });

    it('uses a live tunnel owned by another process, ignores a dead one', async () => {
        const dir = makeTmp('ams-tunnel-');
        fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
        const state = (pid) => fs.writeFileSync(path.join(dir, '.state', 'tunnel.json'),
            JSON.stringify({ status: 'up', url: 'https://live.trycloudflare.com', mode: 'quick', ownerPid: pid, port: 3000, updatedAt: new Date().toISOString() }));
        fs.mkdirSync(path.join(dir, 'in'));
        fs.writeFileSync(path.join(dir, 'in', 'clip.mp4'), FILES.mp4().bytes);
        const env = { AUTO_TUNNEL: '1', PUBLIC_BASE_URL: 'https://stale.example' };
        state(process.pid);
        const live = await runCli(['video', 'create', '-p', 'x', '--video', path.join(dir, 'in', 'clip.mp4'), '--json'], { dataDir: dir, mockDir, env });
        assert.equal(live.code, 0, live.stdout);
        assert.match(JSON.parse(ark().at(-1).raw).content[1].video_url.url, /^https:\/\/live\.trycloudflare\.com\/videos\/staging\//);
        state(4194311); // not running
        const dead = await runCli(['video', 'create', '-p', 'x', '--video', path.join(dir, 'in', 'clip.mp4'), '--json'], { dataDir: dir, mockDir, env });
        assert.equal(dead.code, 6);
        const status = await runCli(['tunnel', 'status', '--json'], { dataDir: dir, mockDir, env });
        assert.equal(status.json.tunnel.status, 'down');
    });
});

describe('video completion without the browser', () => {
    const FAST = { AI_MEDIA_STUDIO_POLL_SCALE: '0.001' };
    const task = (status, extra = {}) => ({ match: 'GET https://ark', response: { status: 200, json: { status, ...extra } } });

    it('create --wait polls to success, downloads, unstages', async () => {
        mockRules([task('queued'), task('running'), task('succeeded', { duration: 6, content: { video_url: 'https://mock.cdn/w.mp4' } })]);
        const r = await run(['video', 'create', '-p', 'wait', '--image', path.join(inputs, 'a.png'), '--wait', '--json'], { env: FAST });
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.equal(r.json.status, 'succeeded');
        assert.ok(fs.existsSync(r.json.record.paths.fullVideo));
        assert.equal(r.json.record.stagedPaths, undefined);
        assert.match(r.stderr, /queued[\s\S]*running[\s\S]*succeeded/);
    });

    it('a failed task exits 3 with the reason', async () => {
        const c = await run(['video', 'create', '-p', 'f', '--video', 'https://x/y.mp4', '--json']);
        mockRules([task('failed', { error: { message: 'content blocked' } })]);
        const r = await run(['video', 'wait', c.json.taskId, '--json'], { env: FAST });
        assert.deepEqual([r.code, r.json.code, r.json.error], [3, 'TASK_FAILED', 'content blocked']);
        assert.equal(r.json.record.status, 'failed');
    });

    it('network blips are retried; a timeout exits 7 and leaves the task pending', async () => {
        const c = await run(['video', 'create', '-p', 'n', '--video', 'https://x/y.mp4', '--json']);
        mockRules([{ match: 'GET https://ark', response: { networkError: true } }, task('succeeded', { content: { video_url: 'https://mock.cdn/n.mp4' } })]);
        assert.equal((await run(['video', 'wait', c.json.taskId, '--json'], { env: FAST })).code, 0);

        const t = await run(['video', 'create', '-p', 't', '--video', 'https://x/y.mp4', '--json']);
        const r = await run(['video', 'wait', t.json.taskId, '--timeout', '1', '--json']); // real cadence: 5s > 1s
        assert.deepEqual([r.code, r.json.code], [7, 'WAIT_TIMEOUT']);
        assert.match(r.json.error, /video resume/);
    });

    it('resume finishes every pending task', async () => {
        const list = await run(['video', 'list', '--json']);
        const pending = list.json.pendingIds;
        assert.ok(pending.length >= 1);
        mockRules(pending.map(() => task('succeeded', { content: { video_url: 'https://mock.cdn/r.mp4' } })));
        const r = await run(['video', 'resume', '--json'], { env: FAST });
        assert.equal(r.code, 0);
        assert.equal(r.json.resumed, pending.length);
        assert.ok(r.json.results.every(x => x.status === 'succeeded'));
        assert.deepEqual((await run(['video', 'list', '--json'])).json.pendingIds, []);
    });
});
