// Seedream image generation and the image gallery.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { StudioError } = require('./errors');
const { IMAGE_URL, rotatingFetch } = require('./ark');
const { withLock } = require('./stores/lock');
const { mask } = require('./config');
const { downloadBuffer, detectImageExt, mimeFromName, renameRetry } = require('./files');
const { compilePrompt } = require('./slots');
const {
    resolveImageSize, resolveOutputFormat, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, MAX_IMAGES_PER_REQUEST,
    imageCost, modelAcceptsSeed, modelSupportsGroup, PRICE_SOURCE
} = require('./models');

// Not every Seedream model accepts the same request body, and ModelArk rejects
// the whole call on an unsupported key rather than ignoring it. Seedream 5.0 Pro
// drops both `sequential_image_generation` and `stream` (5.0 Lite and 4.x keep
// them), so those are only sent to models known to take them. Matching on the ID
// rather than an exact string keeps pass-through model IDs working.
function modelSupportsSequentialAndStream(modelId) {
    return !/seedream-5-0-pro/i.test(modelId || '');
}

function bufferToDataUri(buffer, mimetype, fallback = 'image/png') {
    const mime = (mimetype || fallback).toLowerCase();
    return `data:${mime};base64,${buffer.toString('base64')}`;
}

// --- TIMESTAMP-BASED GALLERY ID ---
// Format: YYYYMMDD_HHmmss_sss, with _<N> suffix on collision (N >= 2).
function pad(n, len = 2) { return String(n).padStart(len, '0'); }
function formatTimestamp(date = new Date()) {
    return (
        date.getFullYear() +
        pad(date.getMonth() + 1) +
        pad(date.getDate()) +
        '_' +
        pad(date.getHours()) +
        pad(date.getMinutes()) +
        pad(date.getSeconds()) +
        '_' +
        pad(date.getMilliseconds(), 3)
    );
}
function nextGalleryId(galleryDir, date = new Date()) {
    const base = formatTimestamp(date);
    let id = base;
    let n = 2;
    while (
        fs.existsSync(path.join(galleryDir, `${id}.jpeg`)) ||
        fs.readdirSync(galleryDir).some(f => f.startsWith(id + '_in_') || f.startsWith(id + '.'))
    ) {
        id = `${base}_${n++}`;
    }
    return id;
}

// Another process may be choosing an id at the same moment, so the choice and the
// reservation happen under one lock: `<id>.part` (which the collision check above
// already treats as taken) is created exclusively and later renamed to the image.
async function reserveGalleryId(config) {
    await fsp.mkdir(config.galleryDir, { recursive: true });
    return withLock(config.locksDir, 'gallery-id', async () => {
        const id = nextGalleryId(config.galleryDir);
        await fsp.writeFile(path.join(config.galleryDir, `${id}.part`), '', { flag: 'wx' });
        return id;
    });
}

// "Image 1 is the garment; images 2–3 are the character." Prepended to the prompt when
// references are named (`--image garment=a.jpg`), so the model is told which image
// plays which part instead of the caller writing "the FIRST reference image…" by hand.
function referenceLegend(roles) {
    const byRole = new Map();
    roles.forEach((role, i) => {
        if (!role) return;
        if (!byRole.has(role)) byRole.set(role, []);
        byRole.get(role).push(i + 1);
    });
    if (!byRole.size) return '';
    const ranges = (nums) => {
        const out = [];
        for (let i = 0; i < nums.length; i++) {
            let j = i;
            while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
            if (j - i >= 2) out.push(`${nums[i]}–${nums[j]}`);
            else for (let k = i; k <= j; k++) out.push(`${nums[k]}`);
            i = j;
        }
        return out.length > 1 ? `${out.slice(0, -1).join(', ')} and ${out.at(-1)}` : out[0];
    };
    const parts = [...byRole].map(([role, nums]) =>
        `${nums.length > 1 ? 'images' : 'image'} ${ranges(nums)} ${nums.length > 1 ? 'are' : 'is'} the ${role.replace(/[-_]+/g, ' ')}`);
    const text = parts.join('; ') + '.';
    return text.charAt(0).toUpperCase() + text.slice(1);
}

const isBlankValue = (v) => v === undefined || v === null || v === '';

/** The model id a request is priced as ("endpoint" → the model the endpoint serves). */
function priceModelFor(ctx, modelId, usesEndpoint) {
    return usesEndpoint ? ctx.config.endpointBaseModel : modelId;
}

/**
 * Validates and builds the upstream request. Pure apart from reading config.
 * @returns {{ body: object, modelId: string, prompt: string, images: object[], ... }}
 */
function prepareImageRequest(ctx, input) {
    const images = input.images || [];
    const roles = images.map((f, i) => (input.imageRoles && input.imageRoles[i]) || f.role || null);
    const prompt = input.slots ? compilePrompt(input.prompt || '', input.slots) : input.prompt;
    if (!prompt || !prompt.trim()) {
        throw new StudioError('VALIDATION', 'Prompt is required.');
    }
    if (images.length > MAX_REFERENCE_IMAGES) {
        throw new StudioError('VALIDATION', `Maximum ${MAX_REFERENCE_IMAGES} reference images.`);
    }
    for (const f of images) {
        if (f.buffer.length > MAX_REFERENCE_IMAGE_BYTES) {
            throw new StudioError('VALIDATION', `Reference image too large — the limit is ${MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024} MB each.`);
        }
    }

    // Model selection: "endpoint" (or empty) resolves to the configured Seedream
    // endpoint ID; anything else is treated as a ModelArk model ID (e.g.
    // "dola-seedream-5-0-pro-260628") and forwarded verbatim.
    const model = input.model;
    const usesEndpoint = !model || model === 'endpoint';
    if (usesEndpoint && !ctx.config.endpointId) {
        throw new StudioError('CONFIG', 'Missing ENDPOINT_ID in .env file (needed for the "endpoint" model).');
    }
    const modelId = usesEndpoint ? ctx.config.endpointId : model;
    const priceModel = priceModelFor(ctx, modelId, usesEndpoint);
    const modelName = usesEndpoint ? `The endpoint model (${ctx.config.endpointBaseModel})` : modelId;

    let seed = null;
    if (!isBlankValue(input.seed)) {
        seed = Number(input.seed);
        if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
            throw new StudioError('VALIDATION', 'Seed must be a whole number from 0 to 2147483647.');
        }
        if (!modelAcceptsSeed(priceModel)) {
            throw new StudioError('VALIDATION',
                `${modelName} does not accept a seed: no current Seedream image model (5.0, 4.5, 4.0) has a seed ` +
                'parameter in the BytePlus API reference. Only the 3.0 generation did.');
        }
    }

    let group = null;
    if (!isBlankValue(input.group)) {
        group = Number(input.group);
        if (!Number.isInteger(group) || group < 1) throw new StudioError('VALIDATION', 'Group size must be a whole number of at least 1.');
        if (!modelSupportsGroup(priceModel) || !modelSupportsSequentialAndStream(modelId)) {
            throw new StudioError('VALIDATION', `${modelName} does not support group generation (Seedream 5.0 Pro and Flash don't; 4.5, 4.0 and 5.0 Lite do).`);
        }
        if (images.length + group > MAX_IMAGES_PER_REQUEST) {
            throw new StudioError('VALIDATION',
                `Reference images plus generated images can't exceed ${MAX_IMAGES_PER_REQUEST} (${images.length} + ${group}).`);
        }
    }

    // Build base64 data URIs from uploaded files
    const inputImages = images.map(f => bufferToDataUri(f.buffer, f.mimetype || mimeFromName(f.originalname)));
    const legend = input.legend === false ? '' : referenceLegend(roles);

    const body = {
        model: modelId,
        prompt: legend ? `${legend} ${prompt.trim()}` : prompt.trim(),
        response_format: 'url',
        size: resolveImageSize({ model, size: input.size, resolution: input.resolution, ratio: input.ratio }),
        watermark: input.watermark === 'true' || input.watermark === true
    };
    if (modelSupportsSequentialAndStream(modelId)) {
        // A group asks the model for up to `group` related images in one call; "auto"
        // lets it return fewer, and only generated images are billed.
        body.sequential_image_generation = group ? 'auto' : 'disabled';
        if (group) body.sequential_image_generation_options = { max_images: group };
        body.stream = false;
    }
    // Seedream 5.0 Pro lets the caller pick png/jpeg; default behaviour for the
    // 4.5 endpoint is jpeg only, so we only override when explicitly requested
    // (or when the catalogue pins a format for the model).
    const outputFormat = resolveOutputFormat(model, input.outputFormat);
    if (outputFormat) body.output_format = outputFormat;
    if (seed !== null) body.seed = seed;
    if (inputImages.length === 1) body.image = inputImages[0];
    else if (inputImages.length > 1) body.image = inputImages;

    const estimatedCost = imageCost(priceModel, { outputs: group || 1, inputs: images.length, sizes: [body.size] });
    return { body, modelId, usesEndpoint, priceModel, images, roles, seed, group, estimatedCost };
}

/** The request as --dry-run shows it: no key, endpoint id masked, images summarised. */
function redactImageRequest(ctx, { body, usesEndpoint, images }) {
    const shown = { ...body };
    if (usesEndpoint) shown.model = mask(ctx.config.endpointId);
    const summary = (f) => `<data-uri: ${f.buffer.length} bytes>`;
    if (images.length === 1) shown.image = summary(images[0]);
    else if (images.length > 1) shown.image = images.map(summary);
    return { method: 'POST', url: IMAGE_URL, body: shown };
}

const costNote = (req) => `No price is known for ${req.priceModel}, so this cost is not reported.`;

// --out: a path ending in an image extension is the exact file to write; anything else
// is a folder the result is copied into under its gallery name.
async function copyOut(out, galleryFile, filename, index, count) {
    if (!out) return null;
    const target = path.resolve(out);
    let dest;
    if (/\.(jpe?g|png|webp)$/i.test(target)) {
        const ext = path.extname(target);
        dest = count > 1 ? `${target.slice(0, -ext.length)}-${index + 1}${ext}` : target;
    } else {
        dest = path.join(target, filename);
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(galleryFile, dest);
    return dest;
}

/**
 * Generate one image (or a group of related images), save each into the gallery with
 * its inputs, record it.
 * input: { prompt, slots?, model?, size?, resolution?, ratio?, outputFormat?, watermark?,
 *          seed?, group?, images?: [{ buffer, mimetype?, originalname, role? }],
 *          imageRoles?, legend?, tags?, meta?, out?: file or folder }
 */
async function generateImage(ctx, input, { dryRun = false } = {}) {
    const req = prepareImageRequest(ctx, input);
    if (dryRun) {
        const out = { success: true, dryRun: true, request: redactImageRequest(ctx, req), estimatedCost: req.estimatedCost };
        if (!req.estimatedCost) out.costNote = costNote(req);
        return out;
    }

    const { config, log } = ctx;
    const { body, modelId, images, roles } = req;
    try {
        const outcome = await rotatingFetch(ctx.keys, {
            url: IMAGE_URL,
            method: 'POST',
            body: JSON.stringify(body),
            onRotate: (status) => log.log(`[KEY] Status ${status}, rotating.`)
        });

        if (outcome.type === 'ok') {
            const data = await outcome.res.json();
            const produced = (data.data || []).map((d, index) => ({ ...d, index }));
            const ok = produced.filter(d => d && d.url);
            if (!ok.length || (!req.group && !(data.data[0] && data.data[0].url))) {
                throw new StudioError('UPSTREAM_BAD_RESPONSE', 'No image returned by upstream.');
            }
            const cost = imageCost(req.priceModel, { outputs: ok.length, inputs: images.length, sizes: ok.map(d => d.size || body.size) });
            const tags = Array.isArray(input.tags) && input.tags.length ? [...new Set(input.tags.map(String))] : null;
            const meta = input.meta && Object.keys(input.meta).length ? input.meta : null;

            const records = [];
            const copied = [];
            let groupId = null;
            for (let n = 0; n < ok.length; n++) {
                const item = ok[n];
                // Persist image locally
                const id = await reserveGalleryId(config);
                if (req.group && !groupId) groupId = `g_${id}`;
                const partPath = path.join(config.galleryDir, `${id}.part`);
                let filename;
                try {
                    const buf = await downloadBuffer(item.url);
                    await fsp.writeFile(partPath, buf);
                    filename = `${id}.${detectImageExt(buf)}`;
                    await renameRetry(partPath, path.join(config.galleryDir, filename));
                } catch (e) {
                    await fsp.unlink(partPath).catch(() => {});
                    log.error('[GALLERY] Download failed:', e.message);
                    throw new StudioError('DOWNLOAD_FAILED', 'Failed to save image locally.');
                }

                // Save input thumbnails alongside (small, base64-truncated to avoid bloat)
                const inputThumbs = [];
                for (let i = 0; i < images.length; i++) {
                    const f = images[i];
                    const thumbName = `${id}_in_${i}${path.extname(f.originalname || '') || '.png'}`;
                    await fsp.writeFile(path.join(config.galleryDir, thumbName), f.buffer);
                    inputThumbs.push(`/gallery/${thumbName}`);
                }

                const record = {
                    id,
                    prompt: body.prompt,
                    model: modelId,
                    size: item.size || body.size,
                    requestedSize: body.size,
                    watermark: body.watermark,
                    inputCount: images.length,
                    inputThumbs,
                    outputPath: `/gallery/${filename}`,
                    createdAt: new Date().toISOString()
                };
                // Fields added after the original format; only written when they apply.
                if (roles.some(Boolean)) record.inputRoles = roles;
                if (req.seed !== null) record.seed = req.seed;
                if (req.group) Object.assign(record, { groupId, groupIndex: item.index, groupSize: ok.length });
                if (tags) record.tags = tags;
                if (meta) record.meta = meta;
                if (cost) {
                    // Each image carries its own output price; the request's input charge
                    // is booked on the first image.
                    const own = imageCost(req.priceModel, { outputs: 1, inputs: n === 0 ? images.length : 1, sizes: [record.size] });
                    record.cost = { usd: own.usd, model: own.model, priceRead: own.priceRead };
                }
                await ctx.stores.gallery.add(record);
                records.push(record);
                const dest = await copyOut(input.out, path.join(config.galleryDir, filename), filename, n, ok.length);
                if (dest) copied.push(dest);
            }

            const failures = produced.filter(d => !d || !d.url).map(d => ({ index: d.index, error: (d.error && (d.error.message || d.error.code)) || 'No image.' }));
            const result = req.group
                ? { success: true, groupId, items: records, requested: req.group, returned: records.length }
                : { success: true, item: records[0] };
            if (failures.length) result.failures = failures;
            if (copied.length) result.copiedTo = req.group ? copied : copied[0];
            result.cost = cost;
            if (!cost) result.costNote = costNote(req);
            return result;
        }

        if (outcome.type === 'error') {
            const errText = await outcome.res.text();
            // Pull the friendly message out of BytePlus's JSON error envelope, if any.
            let friendly = errText;
            try { const j = JSON.parse(errText); friendly = (j.error && (j.error.message || j.error.code)) || errText; } catch {}
            throw new StudioError('UPSTREAM_REJECTED', friendly, { httpStatus: outcome.res.status });
        }

        throw new StudioError('KEYS_EXHAUSTED', 'All API keys exhausted or invalid.');
    } catch (error) {
        if (error instanceof StudioError) throw error;
        log.error('[NET]', error);
        throw new StudioError('NETWORK', error.message || 'Internal server error', { retryable: true });
    }
}

// ---- GALLERY ----
const hasTags = (it, tags) => tags.every(t => (it.tags || []).includes(t));
const asList = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

async function listGallery(ctx, { search, limit, tag } = {}) {
    let items = await ctx.stores.gallery.list();
    const q = (search || '').toLowerCase().trim();
    if (q) items = items.filter(it => (it.prompt || '').toLowerCase().includes(q));
    const tags = asList(tag);
    if (tags.length) items = items.filter(it => hasTags(it, tags));
    if (limit) items = items.slice(0, Number(limit));
    return { success: true, items };
}

async function getGalleryItem(ctx, id) {
    const item = await ctx.stores.gallery.get(id);
    if (!item) throw new StudioError('NOT_FOUND', 'Not found.');
    return { success: true, item };
}

function recordFiles(ctx, rec) {
    return [rec.outputPath, ...(rec.inputThumbs || [])].map(rel => path.join(ctx.config.dataDir, rel.replace(/^\//, '')));
}

async function deleteGalleryItem(ctx, id) {
    const removed = await ctx.stores.gallery.remove(id);
    if (!removed) throw new StudioError('NOT_FOUND', 'Not found.');

    // Delete output + input thumbs from disk
    for (const abs of recordFiles(ctx, removed)) {
        await fsp.unlink(abs).catch(() => {});
    }
    return { success: true };
}

// "30d", "12h", "2w", "90m", or a date/time. Returns the cut-off as a Date.
function parseCutoff(value, name) {
    const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(String(value).trim());
    if (m) {
        const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
        return new Date(Date.now() - Number(m[1]) * ms);
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new StudioError('USAGE', `${name} must be a date or a duration like 30d, 12h, 2w; got "${value}".`);
    return d;
}

/**
 * Remove gallery images by tag and/or age. A dry run unless `yes`: it reports what it
 * would delete. Refuses to run without a filter, so it can never mean "everything".
 */
async function pruneGallery(ctx, { tag, olderThan, yes = false } = {}) {
    const tags = asList(tag);
    if (!tags.length && !olderThan) {
        throw new StudioError('USAGE', 'Give --tag and/or --older-than: prune never deletes the whole gallery.');
    }
    const cutoff = olderThan ? parseCutoff(olderThan, '--older-than') : null;
    const matches = (it) => (!tags.length || hasTags(it, tags)) && (!cutoff || new Date(it.createdAt) < cutoff);
    const candidates = (await ctx.stores.gallery.list()).filter(matches);
    let bytes = 0;
    for (const rec of candidates) {
        for (const f of recordFiles(ctx, rec)) { try { bytes += fs.statSync(f).size; } catch { /* already gone */ } }
    }
    const summary = {
        success: true,
        dryRun: !yes,
        matched: candidates.length,
        bytes,
        filter: { tags, olderThan: olderThan || null, before: cutoff ? cutoff.toISOString() : null },
        ids: candidates.map(c => c.id)
    };
    if (!yes) return summary;
    let deleted = 0;
    for (const rec of candidates) {
        const removed = await ctx.stores.gallery.remove(rec.id);
        if (!removed) continue;
        for (const f of recordFiles(ctx, removed)) await fsp.unlink(f).catch(() => {});
        deleted++;
    }
    return { ...summary, deleted };
}

/** What a stored record cost: its recorded cost, or an estimate for records made before costs were kept. */
function recordCost(ctx, rec) {
    if (rec.cost && typeof rec.cost.usd === 'number') return { usd: rec.cost.usd, model: rec.cost.model, estimated: false };
    const model = rec.model || '';
    // The endpoint id (ep-…) was stored as the model; price it as the endpoint's base model.
    const priceModel = (model === ctx.config.endpointId || /^ep-/.test(model) || !model) ? ctx.config.endpointBaseModel : model;
    const c = imageCost(priceModel, { outputs: 1, inputs: rec.inputCount || 0, sizes: [rec.size || rec.requestedSize] });
    return c ? { usd: c.usd, model: priceModel, estimated: true } : { usd: null, model: priceModel, estimated: true };
}

/** `ai-media-studio usage`: spend totalled from the gallery manifest. */
async function usage(ctx, { since, until, tag } = {}) {
    const from = since ? parseCutoff(since, '--since') : null;
    const to = until ? parseCutoff(until, '--until') : null;
    const tags = asList(tag);
    const items = (await ctx.stores.gallery.list()).filter(it =>
        (!from || new Date(it.createdAt) >= from) && (!to || new Date(it.createdAt) < to) && (!tags.length || hasTags(it, tags)));
    const byModel = new Map();
    let total = 0;
    let estimatedUsd = 0;
    let unpriced = 0;
    for (const it of items) {
        const c = recordCost(ctx, it);
        const row = byModel.get(c.model) || { model: c.model, images: 0, usd: 0, unpriced: 0 };
        row.images++;
        if (c.usd === null) { row.unpriced++; unpriced++; } else {
            row.usd += c.usd; total += c.usd;
            if (c.estimated) estimatedUsd += c.usd;
        }
        byModel.set(c.model, row);
    }
    const r = (n) => Math.round(n * 1000) / 1000;
    return {
        success: true,
        images: items.length,
        spendUsd: r(total),
        // Part of spendUsd worked out afterwards from model, size and inputs, for images
        // generated before costs were recorded.
        estimatedUsd: r(estimatedUsd),
        unpriced,
        byModel: [...byModel.values()].map(x => ({ ...x, usd: r(x.usd) })).sort((a, b) => b.usd - a.usd),
        filter: { since: from ? from.toISOString() : null, until: to ? to.toISOString() : null, tags },
        prices: { source: PRICE_SOURCE.url, read: PRICE_SOURCE.read }
    };
}

module.exports = {
    generateImage, prepareImageRequest, listGallery, getGalleryItem, deleteGalleryItem, pruneGallery, usage,
    nextGalleryId, formatTimestamp, modelSupportsSequentialAndStream, referenceLegend, parseCutoff, recordCost
};
