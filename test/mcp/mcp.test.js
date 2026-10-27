// The MCP server, driven by the SDK's own stdio client: tool list and annotations,
// results identical to the CLI, image previews, the path allow-list, and no secrets.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { TEST_ENV, REPO, makeTmp, FILES } = require('../helpers/server');
const { runCli } = require('../helpers/cli');

let client, dataDir, mockDir, outside;
let hasSharp = true;
try { require('sharp'); } catch { hasSharp = false; }

const mockRules = (list) => {
    const f = path.join(mockDir, 'rules.json');
    fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf-8')).concat(list)));
};
async function callTool(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, json: JSON.parse(r.content[0].text) };
}

before(async () => {
    dataDir = makeTmp('ams-mcp-');
    mockDir = makeTmp('ams-mock-');
    outside = makeTmp('ams-outside-');
    fs.writeFileSync(path.join(mockDir, 'rules.json'), '[]');
    fs.mkdirSync(path.join(dataDir, 'inputs'));
    fs.writeFileSync(path.join(dataDir, 'inputs', 'a.png'), FILES.png().bytes);
    fs.writeFileSync(path.join(outside, 'b.png'), FILES.png().bytes);
    fs.writeFileSync(path.join(dataDir, '.env'), 'ENDPOINT_ID=ep-from-file\n');
    const env = {
        ...process.env, ...TEST_ENV,
        AI_MEDIA_STUDIO_DATA_DIR: dataDir,
        AI_MEDIA_STUDIO_ENV_FILE: path.join(dataDir, '.env'),
        AI_MEDIA_STUDIO_ALLOWED_DIRS: dataDir,
        MOCK_FETCH_DIR: mockDir,
        NODE_OPTIONS: `--require ${path.join(REPO, 'test', 'helpers', 'mock-fetch.js')}`
    };
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [path.join(REPO, 'cli', 'ai-media-studio.js'), 'mcp'],
        env,
        cwd: dataDir,
        stderr: 'pipe'
    }));
});
after(async () => { await client?.close(); });

describe('MCP server', () => {
    it('lists one tool per capability, with cost and safety annotations', async () => {
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map(t => [t.name, t]));
        for (const name of [
            'ai_media_studio_health', 'ai_media_studio_models', 'ai_media_studio_image_generate',
            'ai_media_studio_gallery_list', 'ai_media_studio_gallery_get', 'ai_media_studio_gallery_delete',
            'ai_media_studio_prompts_list', 'ai_media_studio_prompts_compile', 'ai_media_studio_video_create',
            'ai_media_studio_video_status', 'ai_media_studio_video_wait'
        ]) assert.ok(byName[name], `missing tool ${name}`);
        for (const hidden of ['config', 'keys', 'serve', 'mcp', 'tunnel_up']) {
            assert.ok(!tools.some(t => t.name.includes(hidden)), `${hidden} must not be a tool`);
        }
        const gen = byName.ai_media_studio_image_generate;
        assert.match(gen.description, /^BILLED: each call is a paid BytePlus generation/);
        assert.equal(gen.annotations.openWorldHint, true);
        assert.match(byName.ai_media_studio_video_create.description, /^BILLED/);
        assert.equal(byName.ai_media_studio_gallery_delete.annotations.destructiveHint, true);
        assert.equal(byName.ai_media_studio_prompts_delete.annotations.destructiveHint, true);
        assert.equal(byName.ai_media_studio_gallery_list.annotations.readOnlyHint, true);
        assert.ok(!JSON.stringify(tools).includes('"cli"'), 'CLI-only schema hints leak into tool schemas');
        assert.deepEqual(gen.inputSchema.properties.images, { type: 'array', items: { type: 'string' }, maxItems: 9, description: 'Up to 9 local reference image paths.' });
    });

    it('results are the same JSON as the CLI', async () => {
        for (const [tool, cli] of [['ai_media_studio_models', ['models']], ['ai_media_studio_video_modes', ['video', 'modes']], ['ai_media_studio_health', ['health']]]) {
            const m = await callTool(tool);
            const c = await runCli([...cli, '--json'], { dataDir, mockDir });
            assert.deepEqual(m.json, c.json, tool);
        }
    });

    it('image generate returns the record, the absolute path and a ≤1024px preview', { skip: !hasSharp && 'sharp not installed' }, async () => {
        const sharp = require('sharp');
        const big = await sharp({ create: { width: 2048, height: 1536, channels: 3, background: '#3366cc' } }).jpeg().toBuffer();
        mockRules([{ match: 'GET https://mock.cdn', response: { status: 200, base64: big.toString('base64') } }]);
        const r = await callTool('ai_media_studio_image_generate', { prompt: 'blue', images: [path.join(dataDir, 'inputs', 'a.png')] });
        assert.ok(!r.isError, r.content[0].text);
        assert.ok(fs.existsSync(r.json.item.paths.output));
        const img = r.content.find(c => c.type === 'image');
        assert.ok(img, 'no preview');
        assert.equal(img.mimeType, 'image/jpeg');
        const meta = await sharp(Buffer.from(img.data, 'base64')).metadata();
        assert.deepEqual([meta.width, meta.height], [1024, 768]);
    });

    it('an undecodable result still returns the path, without a preview', async () => {
        const r = await callTool('ai_media_studio_image_generate', { prompt: 'stub bytes' });
        assert.ok(!r.isError);
        assert.equal(r.content.filter(c => c.type === 'image').length, 0);
        assert.ok(path.isAbsolute(r.json.item.paths.output));
    });

    it('paths outside the allow-list, relative paths and secrets are refused', async () => {
        const outsideFile = await callTool('ai_media_studio_image_generate', { prompt: 'x', images: [path.join(outside, 'b.png')] });
        assert.equal(outsideFile.isError, true);
        assert.equal(outsideFile.json.code, 'PATH_NOT_ALLOWED');
        const relative = await callTool('ai_media_studio_image_generate', { prompt: 'x', images: ['inputs/a.png'] });
        assert.equal(relative.json.code, 'PATH_NOT_ALLOWED');
        const env = await callTool('ai_media_studio_image_generate', { promptFile: path.join(dataDir, '.env') });
        assert.equal(env.json.code, 'PATH_NOT_ALLOWED');
        const state = await callTool('ai_media_studio_prompts_compile', { textFile: path.join(dataDir, '.state', 'keys.json') });
        assert.equal(state.json.code, 'PATH_NOT_ALLOWED');
        const sneaky = await callTool('ai_media_studio_image_generate', { prompt: 'x', images: [path.join(dataDir, 'inputs', '..', '..', path.basename(outside), 'b.png')] });
        assert.equal(sneaky.json.code, 'PATH_NOT_ALLOWED');
    });

    it('bad arguments are rejected before anything runs', async () => {
        const unknown = await callTool('ai_media_studio_gallery_list', { nope: 1 });
        assert.deepEqual([unknown.isError, unknown.json.code], [true, 'USAGE']);
        const type = await callTool('ai_media_studio_gallery_list', { limit: 'ten' });
        assert.equal(type.json.code, 'USAGE');
        const missing = await callTool('ai_media_studio_gallery_get', {});
        assert.equal(missing.json.code, 'USAGE');
    });

    it('video: create with a URL, then wait to completion', async () => {
        mockRules([{ match: 'GET https://ark', response: { status: 200, json: { status: 'succeeded', content: { video_url: 'https://mock.cdn/m.mp4' } } } }]);
        const c = await callTool('ai_media_studio_video_create', { prompt: 'edit', video: 'https://cdn.example/c.mp4', wait: true, timeout: 60 });
        assert.ok(!c.isError, c.content[0].text);
        assert.equal(c.json.status, 'succeeded');
        assert.ok(fs.existsSync(c.json.record.paths.fullVideo));
    });

    it('never returns an API key, the endpoint id from the dry run, or the key-state file', async () => {
        const dry = await callTool('ai_media_studio_image_generate', { prompt: 'dry', dryRun: true });
        assert.equal(dry.json.request.body.model, '****0001');
        const outputs = [];
        for (const t of ['ai_media_studio_health', 'ai_media_studio_models', 'ai_media_studio_tunnel_status', 'ai_media_studio_gallery_list', 'ai_media_studio_video_list']) {
            outputs.push((await client.callTool({ name: t, arguments: {} })).content[0].text);
        }
        outputs.push(JSON.stringify(dry.json));
        for (const out of outputs) {
            assert.ok(!/key-(aaaa1111|bbbb2222|cccc3333)/.test(out), 'an API key leaked');
            assert.ok(!out.includes('"keys"'), 'key state leaked');
        }
    });
});
