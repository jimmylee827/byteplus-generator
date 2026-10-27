// Features added after the EC shop's production run: cost, seed and group handling,
// named references, tags and metadata, usage, prune, batch, and the image utilities.
// BytePlus is mocked throughout; nothing here makes a network call.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, FILES, startServer, call } = require('../helpers/server');
const { runCli } = require('../helpers/cli');
const { imageCost } = require('../../core/models');

let dataDir, mockDir, inputs;
const run = (args, opts = {}) => runCli(args, { dataDir, mockDir, ...opts });
const json = async (...args) => {
    const r = await run([...args, '--json']);
    assert.ok(r.json, `no JSON from ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    return r;
};
const rules = (list) => {
    const f = path.join(mockDir, 'rules.json');
    fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf-8')).concat(list)));
};
const clearRules = () => fs.writeFileSync(path.join(mockDir, 'rules.json'), '[]');
const ark = () => fs.readFileSync(path.join(mockDir, 'log.jsonl'), 'utf-8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(r => r.url.startsWith('https://ark.'));
const lastBody = () => JSON.parse(ark().at(-1).raw);
const inp = (n) => path.join(inputs, n);
const PRO = 'dola-seedream-5-0-pro-260628';
const manifest = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'gallery', 'manifest.json'), 'utf-8'));

before(() => {
    dataDir = makeTmp('ams-prod-');
    mockDir = makeTmp('ams-mock-');
    fs.writeFileSync(path.join(mockDir, 'rules.json'), '[]');
    fs.writeFileSync(path.join(mockDir, 'log.jsonl'), '');
    inputs = path.join(dataDir, 'inputs');
    fs.mkdirSync(inputs);
    for (const n of ['garment.png', 'face.png', 'body.png']) fs.writeFileSync(inp(n), FILES.png().bytes);
});

describe('cost', () => {
    it('price table: Seedream 5.0 Pro tiers by pixels and charges inputs after the first', () => {
        assert.equal(imageCost(PRO, { outputs: 1, inputs: 1, sizes: ['1344x1792'] }).usd, 0.045);   // 1.5K 3:4, 2.41 MP
        assert.equal(imageCost(PRO, { outputs: 1, inputs: 1, sizes: ['1776x2368'] }).usd, 0.09);    // 2K 3:4, 4.2 MP
        assert.equal(imageCost(PRO, { outputs: 1, inputs: 4, sizes: ['1776x2368'] }).usd, 0.099);   // + 3 × 0.003
        assert.equal(imageCost(PRO, { outputs: 1, inputs: 0, sizes: ['2K'] }).usd, 0.09);           // nominal 2048²
        assert.equal(imageCost('seedream-4-5-251128', { outputs: 3, inputs: 5, sizes: ['4K'] }).usd, 0.12);
        assert.equal(imageCost('some-unpriced-model', { outputs: 1, inputs: 0, sizes: [] }), null);
    });

    it('every generate result and record carries its cost; unknown models report null and say so', async () => {
        const r = await json('image', 'generate', '-p', 'x', '--model', PRO, '--resolution', '2K', '--ratio', '3:4', '--image', inp('garment.png'), '--image', inp('face.png'));
        assert.equal(r.json.cost.usd, 0.093);
        assert.deepEqual(r.json.item.cost, { usd: 0.093, model: PRO, priceRead: '2026-10-28' });
        const unknown = await json('image', 'generate', '-p', 'x', '--model', 'seedream-9-9-unknown');
        assert.equal(unknown.json.cost, null);
        assert.match(unknown.json.costNote, /No price is known for seedream-9-9-unknown/);
        assert.equal(unknown.json.item.cost, undefined);
        const dry = await json('image', 'generate', '-p', 'x', '--model', PRO, '--resolution', '1.5K', '--ratio', '3:4', '--dry-run');
        assert.equal(dry.json.estimatedCost.usd, 0.045);
    });

    it('models lists prices, capabilities and the price source', async () => {
        const m = (await json('models')).json.image;
        assert.equal(m.prices.source, 'https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing');
        const pro = m.models.find(x => x.id === PRO);
        assert.deepEqual(pro.accepts, { seed: false, group: false });
        assert.equal(m.models.find(x => x.id === 'endpoint').accepts.group, true);
    });
});

describe('seed and group', () => {
    it('--seed is refused, without a call, for models that have no seed', async () => {
        const before = ark().length;
        for (const model of [PRO, 'endpoint', 'seedream-4-0-250828']) {
            const r = await json('image', 'generate', '-p', 'x', '--model', model, '--seed', '7');
            assert.deepEqual([r.code, r.json.code], [2, 'VALIDATION']);
            assert.match(r.json.error, /does not accept a seed/);
        }
        assert.equal(ark().length, before);
    });

    it('--seed is sent and recorded for a model that takes one', async () => {
        const r = await json('image', 'generate', '-p', 'x', '--model', 'seedream-3-0-t2i-250415', '--seed', '42');
        assert.equal(r.code, 0);
        assert.equal(lastBody().seed, 42);
        assert.equal(r.json.item.seed, 42);
    });

    it('--group is refused for 5.0 Pro and when references + images pass 15', async () => {
        const pro = await json('image', 'generate', '-p', 'x', '--model', PRO, '--group', '4');
        assert.deepEqual([pro.code, pro.json.code], [2, 'VALIDATION']);
        const many = await json('image', 'generate', '-p', 'x', '--group', '13', '--image', inp('garment.png'), '--image', inp('face.png'), '--image', inp('body.png'));
        assert.match(many.json.error, /can't exceed 15 \(3 \+ 13\)/);
    });

    it('a group returns every image, linked, with per-image cost and partial failures', async () => {
        rules([{ match: 'POST https://ark', response: { status: 200, json: { data: [
            { url: 'https://mock.cdn/g1.jpeg', size: '3520x4704' },
            { url: 'https://mock.cdn/g2.jpeg', size: '3520x4704' },
            { error: { code: 'OutputImageSensitiveContentDetected', message: 'blocked' } },
            { url: 'https://mock.cdn/g4.jpeg', size: '3520x4704' }
        ], usage: { generated_images: 3 } } } }]);
        const out = path.join(dataDir, 'exports', 'set.jpeg');
        const r = await json('image', 'generate', '-p', 'four views of one garment', '--group', '4', '--image', inp('garment.png'), '--out', out);
        assert.equal(r.code, 0, r.stdout);
        const body = lastBody();
        assert.equal(body.sequential_image_generation, 'auto');
        assert.deepEqual(body.sequential_image_generation_options, { max_images: 4 });
        assert.deepEqual([r.json.requested, r.json.returned], [4, 3]);
        assert.deepEqual(r.json.items.map(i => i.groupIndex), [0, 1, 3]);
        assert.ok(r.json.items.every(i => i.groupId === r.json.groupId && i.groupSize === 3));
        assert.deepEqual(r.json.failures, [{ index: 2, error: 'blocked' }]);
        assert.equal(r.json.cost.usd, 0.12); // 3 × 4.5 at $0.04; inputs are free
        assert.deepEqual(r.json.copiedTo, [1, 2, 3].map(n => path.join(dataDir, 'exports', `set-${n}.jpeg`)));
        for (const f of r.json.copiedTo) assert.ok(fs.existsSync(f));
    });

    it('requests without a group still send exactly what they always did', async () => {
        await json('image', 'generate', '-p', 'plain');
        const body = lastBody();
        assert.equal(body.sequential_image_generation, 'disabled');
        assert.equal(body.sequential_image_generation_options, undefined);
        assert.equal(body.seed, undefined);
    });
});

describe('named references', () => {
    it('role=path keeps the order, adds a legend and records the roles', async () => {
        const r = await json('image', 'generate', '-p', 'Dress the model.',
            '--image', `garment=${inp('garment.png')}`, '--image', `character=${inp('face.png')}`, '--image', `character=${inp('body.png')}`);
        const body = lastBody();
        assert.equal(body.prompt, 'Image 1 is the garment; images 2 and 3 are the character. Dress the model.');
        assert.equal(body.image.length, 3);
        assert.deepEqual(r.json.item.inputRoles, ['garment', 'character', 'character']);
        assert.equal(r.json.item.inputThumbs.length, 3);
    });
    it('--no-legend keeps the prompt as written; plain paths record no roles', async () => {
        await json('image', 'generate', '-p', 'As written.', '--image', `garment=${inp('garment.png')}`, '--no-legend');
        assert.equal(lastBody().prompt, 'As written.');
        const plain = await json('image', 'generate', '-p', 'Plain.', '--image', inp('garment.png'));
        assert.equal(lastBody().prompt, 'Plain.');
        assert.equal(plain.json.item.inputRoles, undefined);
    });
});

describe('tags, metadata, usage and prune', () => {
    it('tags and meta are saved and filterable', async () => {
        const a = await json('image', 'generate', '-p', 'tagged', '--tag', 'ec', '--tag', 'sweater', '--meta', 'sku=men-sweat-01', '--meta', 'shot=front');
        assert.deepEqual(a.json.item.tags, ['ec', 'sweater']);
        assert.deepEqual(a.json.item.meta, { sku: 'men-sweat-01', shot: 'front' });
        await json('image', 'generate', '-p', 'tagged 2', '--tag', 'ec');
        assert.equal((await json('gallery', 'list', '--tag', 'ec')).json.items.length, 2);
        assert.equal((await json('gallery', 'list', '--tag', 'ec', '--tag', 'sweater')).json.items.length, 1);
    });

    it('usage totals recorded costs and estimates older records', async () => {
        // A record from before costs were kept: priced from its model, size and inputs.
        const m = manifest();
        m.items.push({ id: '20250101_000000_000', prompt: 'old', model: 'ep-test-endpoint-0001', size: '3520x4704', requestedSize: '4K', watermark: false, inputCount: 2, inputThumbs: [], outputPath: '/gallery/none.jpeg', createdAt: '2025-01-01T00:00:00.000Z' });
        fs.writeFileSync(path.join(dataDir, 'gallery', 'manifest.json'), JSON.stringify(m, null, 2));
        const all = (await json('usage')).json;
        assert.ok(all.estimatedUsd >= 0.04);
        assert.ok(all.unpriced >= 1, 'the unknown model is counted as unpriced');
        const old = (await json('usage', '--until', '2025-06-01')).json;
        assert.deepEqual([old.images, old.spendUsd, old.estimatedUsd], [1, 0.04, 0.04]);
        const ec = (await json('usage', '--tag', 'ec')).json;
        assert.equal(ec.images, 2);
    });

    it('prune is a dry run by default, needs a filter, and deletes with --yes', async () => {
        const none = await json('gallery', 'prune');
        assert.deepEqual([none.code, none.json.code], [2, 'USAGE']);
        const dry = await json('gallery', 'prune', '--tag', 'ec');
        assert.deepEqual([dry.json.dryRun, dry.json.matched], [true, 2]);
        assert.equal((await json('gallery', 'list', '--tag', 'ec')).json.items.length, 2, 'dry run deleted nothing');
        const files = (await json('gallery', 'list', '--tag', 'ec')).json.items.map(i => i.paths.output);
        const real = await json('gallery', 'prune', '--tag', 'ec', '--yes');
        assert.deepEqual([real.json.dryRun, real.json.deleted], [false, 2]);
        for (const f of files) assert.ok(!fs.existsSync(f));
        const old = await json('gallery', 'prune', '--older-than', '365d');
        assert.deepEqual(old.json.ids, ['20250101_000000_000']);
    });
});

describe('image batch', () => {
    let jobsDir;
    const writeJobs = (name, jobs) => {
        const f = path.join(jobsDir, name);
        fs.writeFileSync(f, jobs.map(j => JSON.stringify(j)).join('\n') + '\n# a comment line\n');
        return f;
    };
    before(() => {
        jobsDir = makeTmp('ams-jobs-');
        fs.copyFileSync(inp('garment.png'), path.join(jobsDir, 'garment.png'));
    });

    it('dry run: validates every job and totals the estimated spend', async () => {
        const f = writeJobs('dry.jsonl', [
            { id: 'a', prompt: 'x', model: PRO, resolution: '2K', ratio: '3:4', images: ['garment=garment.png'] },
            { id: 'b', prompt: 'y', model: PRO, resolution: '1.5K', ratio: '3:4' }
        ]);
        const r = await json('image', 'batch', f, '--dry-run', '--max-spend', '0.1');
        assert.deepEqual([r.json.total, r.json.estimatedSpendUsd, r.json.withinMaxSpend], [2, 0.135, false]);
        assert.ok(!fs.existsSync(`${f}.status.json`), 'a dry run writes no status');
        const bad = writeJobs('bad.jsonl', [{ id: 'a', prompt: 'x' }, { id: 'b', prompt: 'y', bogus: 1 }]);
        const rb = await json('image', 'batch', bad, '--dry-run');
        assert.deepEqual([rb.code, rb.json.code], [2, 'USAGE']);
        assert.match(rb.json.error, /Job "b".*Unknown field "bogus"/);
    });

    it('stops before --max-spend, then --resume finishes without paying twice', async () => {
        clearRules();
        const jobs = [1, 2, 3, 4].map(n => ({ id: `shot-${n}`, prompt: `shot ${n}`, model: PRO, resolution: '2K', ratio: '3:4', out: `out/shot-${n}.jpeg`, tags: ['set'] }));
        const f = writeJobs('set.jsonl', jobs);
        const before = ark().length;
        const first = await json('image', 'batch', f, '--max-spend', '0.2', '--concurrency', '2');
        assert.deepEqual([first.code, first.json.code], [8, 'BATCH_INCOMPLETE']);
        const s1 = first.json.summary;
        assert.deepEqual([s1.done, s1.skipped, s1.spendUsd], [2, 2, 0.18]);
        assert.match(s1.results.find(r => r.state === 'skipped').reason, /max-spend/);
        assert.equal(ark().length - before, 2);
        assert.ok(fs.existsSync(path.join(jobsDir, 'out', 'shot-1.jpeg')));

        const again = await json('image', 'batch', f);
        assert.deepEqual([again.code, again.json.code], [2, 'USAGE'], 'a recorded batch is never silently re-run');

        const resumed = await json('image', 'batch', f, '--resume', '--tag', 'resumed');
        assert.equal(resumed.code, 0, resumed.stdout);
        assert.deepEqual([resumed.json.done, resumed.json.alreadyDone, resumed.json.spendUsd, resumed.json.totalSpendUsd], [2, 2, 0.18, 0.36]);
        assert.equal(ark().length - before, 4, 'four paid calls in total');
        const status = JSON.parse(fs.readFileSync(`${f}.status.json`, 'utf-8'));
        assert.ok(Object.values(status.jobs).every(j => j.state === 'done'));
        const set = (await json('gallery', 'list', '--tag', 'set')).json.items;
        assert.equal(set.length, 4);
        assert.deepEqual(set.find(i => i.meta.job === 'shot-4').meta, { batch: 'set.jsonl', job: 'shot-4' });
        assert.ok(set.find(i => i.meta.job === 'shot-4').tags.includes('resumed'));
    });

    it('a failed job does not stop the others; --jsonl streams one line per job then the summary', async () => {
        clearRules();
        rules([{ match: 'POST https://ark', response: { status: 400, json: { error: { message: 'bad prompt' } } } }]);
        const f = writeJobs('mixed.jsonl', [{ id: 'one', prompt: 'a' }, { id: 'two', prompt: 'b' }, { id: 'three', prompt: 'c' }]);
        const r = await run(['image', 'batch', f, '--concurrency', '1', '--jsonl']);
        assert.equal(r.code, 8);
        const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l));
        assert.equal(lines.length, 4);
        assert.deepEqual(lines.slice(0, 3).map(l => [l.id, l.state]), [['one', 'failed'], ['two', 'done'], ['three', 'done']]);
        assert.equal(lines[0].error, 'bad prompt');
        assert.equal(lines[3].code, 'BATCH_INCOMPLETE');
        assert.equal(lines[3].summary.failed, 1);
    });

    it('jobs with no known price are skipped under --max-spend; --resume skips existing outputs', async () => {
        clearRules();
        fs.mkdirSync(path.join(jobsDir, 'have'), { recursive: true });
        fs.writeFileSync(path.join(jobsDir, 'have', 'x.jpeg'), 'already made');
        const f = writeJobs('misc.jsonl', [
            { id: 'unpriced', prompt: 'a', model: 'seedream-9-9-unknown' },
            { id: 'exists', prompt: 'b', out: 'have/x.jpeg' }
        ]);
        const r = await json('image', 'batch', f, '--resume', '--max-spend', '5');
        assert.equal(r.json.code, 'BATCH_INCOMPLETE');
        const res = Object.fromEntries(r.json.summary.results.map(x => [x.id, x]));
        assert.match(res.unpriced.reason, /no known price/);
        assert.equal(res.exists.reason, 'output exists');
    });

    it('a .json file with defaults works the same', async () => {
        clearRules();
        const f = path.join(jobsDir, 'set.json');
        fs.writeFileSync(f, JSON.stringify({ defaults: { model: PRO, resolution: '1.5K', ratio: '3:4' }, jobs: [{ prompt: 'p1' }, { prompt: 'p2' }] }));
        const r = await json('image', 'batch', f);
        assert.deepEqual([r.code, r.json.done, r.json.spendUsd], [0, 2, 0.09]);
        assert.deepEqual(r.json.results.map(x => x.id), ['job-1', 'job-2']);
    });
});

describe('image utilities', () => {
    let sharp;
    try { sharp = require('sharp'); } catch { sharp = null; }

        it('trim crops the empty margin and keeps a small halo around the subject', { skip: !sharp && 'sharp not installed' }, async () => {
        const dir = makeTmp('ams-tools-');
        const block = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#cc0000' } }).png().toBuffer();
        await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } })
            .composite([{ input: block, left: 30, top: 50 }]).png().toFile(path.join(dir, 'a.png'));

        const t = await json('image', 'trim', path.join(dir, 'a.png'), '--margin', '0');
        assert.equal(t.json.output, path.join(dir, 'a-trim.png'));
        // The subject is 40×60 at (30,50); edge detection may reach 1–2px further out.
        assert.ok(t.json.width >= 40 && t.json.width <= 44, `width ${t.json.width}`);
        assert.ok(t.json.height >= 60 && t.json.height <= 64, `height ${t.json.height}`);
        assert.ok(t.json.trimmed.left >= 26 && t.json.trimmed.left <= 30, `left ${t.json.trimmed.left}`);
        assert.ok(t.json.trimmed.top >= 46 && t.json.trimmed.top <= 50, `top ${t.json.trimmed.top}`);

        const padded = await json('image', 'trim', path.join(dir, 'a.png'), '--margin', '0', '--pad', '5', '--out', path.join(dir, 'p.png'));
        assert.deepEqual([padded.json.width, padded.json.height], [t.json.width + 10, t.json.height + 10]);

        const withMargin = await json('image', 'trim', path.join(dir, 'a.png'), '--out', path.join(dir, 'm.png'));
        assert.ok(withMargin.json.width > t.json.width, 'the default margin keeps some breathing room');
        assert.ok(withMargin.json.width <= t.json.width + 8);
    });

    it('trim works on a studio backdrop with a gradient and a soft shadow (sharp.trim cannot)', { skip: !sharp && 'sharp not installed' }, async () => {
        // The regression: a backdrop that is light at the top and darker at the bottom,
        // plus a blurred shadow. sharp's own trim (one corner colour) finds nothing here.
        const dir = makeTmp('ams-gradient-');
        const W = 400, H = 400;
        const rows = [];
        for (let y = 0; y < H; y++) {
            const shade = Math.round(255 - (y / H) * 55);
            rows.push(await sharp({ create: { width: W, height: 2, channels: 3, background: { r: shade, g: shade, b: shade } } }).png().toBuffer());
        }
        const backdrop = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
            .composite(rows.map((input, i) => ({ input, left: 0, top: i * 2 }))).png().toBuffer();
        const shadow = await sharp({ create: { width: 120, height: 180, channels: 3, background: '#b8b4ae' } }).blur(16).png().toBuffer();
        const subject = await sharp({ create: { width: 90, height: 150, channels: 3, background: '#3a3f4a' } }).png().toBuffer();
        const file = path.join(dir, 'shot.png');
        await sharp(backdrop).composite([{ input: shadow, left: 150, top: 170 }, { input: subject, left: 160, top: 180 }]).png().toFile(file);

        const before = await sharp(file).metadata();
        const r = await json('image', 'trim', file, '--out', path.join(dir, 'trimmed.png'));
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.ok(!r.json.unchanged, 'a gradient backdrop must still be trimmed');
        assert.ok(r.json.width < before.width - 100, `trimmed width ${r.json.width} of ${before.width}`);
        assert.ok(r.json.height < before.height - 100, `trimmed height ${r.json.height} of ${before.height}`);
        // The subject sits at (160,180)–(249,329); the crop must cover it.
        assert.ok(r.json.trimmed.left <= 160 && r.json.trimmed.left >= 100, `left ${r.json.trimmed.left}`);
        assert.ok(r.json.trimmed.top <= 180 && r.json.trimmed.top >= 120, `top ${r.json.trimmed.top}`);
        assert.ok(r.json.trimmed.left + r.json.width > 249, 'the subject must still be inside the crop');
        assert.ok(r.json.trimmed.top + r.json.height > 329, 'the subject must still be inside the crop');
    });

    it('trim reports unchanged when there is nothing to separate', { skip: !sharp && 'sharp not installed' }, async () => {
        const dir = makeTmp('ams-flat-');
        const flat = path.join(dir, 'flat.png');
        await sharp({ create: { width: 120, height: 120, channels: 3, background: '#dddddd' } }).png().toFile(flat);
        const r = await json('image', 'trim', flat, '--out', path.join(dir, 'out.png'));
        assert.deepEqual([r.json.unchanged, r.json.width, r.json.height], [true, 120, 120]);
        assert.match(r.json.reason, /no background could be separated/);
        assert.ok(fs.existsSync(path.join(dir, 'out.png')), 'the copy is still written');

        // Subject spans the full height: left/right are trimmed, top/bottom are not.
        const band = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ffffff' } })
            .composite([{ input: await sharp({ create: { width: 80, height: 200, channels: 3, background: '#222222' } }).png().toBuffer(), left: 110, top: 0 }])
            .png().toFile(path.join(dir, 'band.png'));
        void band;
        const b = await json('image', 'trim', path.join(dir, 'band.png'), '--margin', '0', '--out', path.join(dir, 'band-out.png'));
        assert.ok(b.json.width < 300, 'the white margins are cropped');
        assert.deepEqual([b.json.trimmed.top, b.json.trimmed.bottom], [0, 0], 'content reaching the top and bottom is kept');
    });

    it('tile and compare work locally', { skip: !sharp && 'sharp not installed' }, async () => {
        const dir = makeTmp('ams-tools-');
        const block = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#cc0000' } }).png().toBuffer();
        await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } })
            .composite([{ input: block, left: 30, top: 50 }]).png().toFile(path.join(dir, 'a.png'));
        const t = await json('image', 'trim', path.join(dir, 'a.png'), '--margin', '0', '--out', path.join(dir, 't.png'));

        const tile = await json('image', 'tile', t.json.output, t.json.output, t.json.output, '--columns', '2', '--cell', '80x60', '--out', path.join(dir, 'sheet.png'));
        assert.deepEqual([tile.json.width, tile.json.height, tile.json.rows], [160, 120, 2]);
        const meta = await sharp(path.join(dir, 'sheet.png')).metadata();
        assert.deepEqual([meta.width, meta.height], [160, 120]);

        const cmp = await json('image', 'compare', path.join(dir, 'a.png'), t.json.output, '--label', 'before', '--label', 'after', '--height', '100', '--out', path.join(dir, 'cmp.jpg'));
        assert.equal(cmp.code, 0, cmp.stdout);
        assert.ok(fs.existsSync(path.join(dir, 'cmp.jpg')));
        const wrongLabels = await json('image', 'compare', path.join(dir, 'a.png'), t.json.output, '--label', 'one', '--out', path.join(dir, 'x.png'));
        assert.equal(wrongLabels.json.code, 'USAGE');
    });
});

describe('HTTP surface', () => {
    it('roles, tags, usage, prune and batch work over HTTP too', async () => {
        const srv = await startServer({ dataDir: makeTmp('ams-http-') });
        try {
            const r = await call(srv, 'POST', '/api/generate', {
                form: { prompt: 'Dress the model.', imageRoles: JSON.stringify(['garment', 'character']), tags: ['http', 'ec'], meta: JSON.stringify({ sku: 'x' }), images: [FILES.png('g.png'), FILES.png('c.png')] }
            });
            assert.equal(r.status, 200, JSON.stringify(r.full));
            assert.deepEqual(r.full.item.inputRoles, ['garment', 'character']);
            assert.deepEqual(r.full.item.tags, ['http', 'ec']);
            assert.ok(r.full.cost);
            assert.match(JSON.parse(srv.mock.ark().at(-1).raw).prompt, /^Image 1 is the garment; image 2 is the character\. /);
            assert.equal((await call(srv, 'GET', '/api/gallery?tag=http')).full.items.length, 1);
            const u = await call(srv, 'GET', '/api/usage?tag=http');
            assert.deepEqual([u.full.images, u.full.spendUsd], [1, 0.04]);
            const seed = await call(srv, 'POST', '/api/generate', { form: { prompt: 'x', seed: '5' } });
            assert.deepEqual([seed.status, seed.full.code], [400, 'VALIDATION']);
            const dry = await call(srv, 'POST', '/api/gallery/prune', { json: { tag: 'http' } });
            assert.deepEqual([dry.full.dryRun, dry.full.matched], [true, 1]);
            const jobs = path.join(srv.dataDir, 'jobs.jsonl');
            fs.writeFileSync(jobs, '{"prompt":"via http"}\n');
            const b = await call(srv, 'POST', '/api/image/batch', { json: { file: jobs } });
            assert.deepEqual([b.status, b.full.done], [200, 1]);
            const bad = await call(srv, 'POST', '/api/image/batch', { json: { file: jobs, nonsense: true } });
            assert.deepEqual([bad.status, bad.full.code], [400, 'USAGE']);
        } finally {
            await srv.stop();
        }
    });
});
