// Seedream image generation and the image gallery.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { StudioError } = require('./errors');
const { IMAGE_URL, rotatingFetch } = require('./ark');
const { withLock } = require('./stores/lock');
const { mask } = require('./config');
const { downloadBuffer, detectImageExt, mimeFromName } = require('./files');
const { compilePrompt } = require('./slots');
const {
    resolveImageSize, resolveOutputFormat, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES
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

/**
 * Validates and builds the upstream request. Pure apart from reading config.
 * @returns {{ body: object, modelId: string, prompt: string, images: object[] }}
 */
function prepareImageRequest(ctx, input) {
    const images = input.images || [];
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

    // Build base64 data URIs from uploaded files
    const inputImages = images.map(f => bufferToDataUri(f.buffer, f.mimetype || mimeFromName(f.originalname)));

    const body = {
        model: modelId,
        prompt: prompt.trim(),
        response_format: 'url',
        size: resolveImageSize({ model, size: input.size, resolution: input.resolution, ratio: input.ratio }),
        watermark: input.watermark === 'true' || input.watermark === true
    };
    if (modelSupportsSequentialAndStream(modelId)) {
        body.sequential_image_generation = 'disabled';
        body.stream = false;
    }
    // Seedream 5.0 Pro lets the caller pick png/jpeg; default behaviour for the
    // 4.5 endpoint is jpeg only, so we only override when explicitly requested
    // (or when the catalogue pins a format for the model).
    const outputFormat = resolveOutputFormat(model, input.outputFormat);
    if (outputFormat) body.output_format = outputFormat;
    if (inputImages.length === 1) body.image = inputImages[0];
    else if (inputImages.length > 1) body.image = inputImages;
    return { body, modelId, usesEndpoint, images };
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

/**
 * Generate one image, save it (and its inputs) into the gallery, record it.
 * input: { prompt, slots?, model?, size?, resolution?, ratio?, outputFormat?, watermark?,
 *          images?: [{ buffer, mimetype?, originalname }], out?: dir }
 */
async function generateImage(ctx, input, { dryRun = false } = {}) {
    const req = prepareImageRequest(ctx, input);
    if (dryRun) return { success: true, dryRun: true, request: redactImageRequest(ctx, req) };

    const { config, log } = ctx;
    const { body, modelId, images } = req;
    try {
        const outcome = await rotatingFetch(ctx.keys, {
            url: IMAGE_URL,
            method: 'POST',
            body: JSON.stringify(body),
            onRotate: (status) => log.log(`[KEY] Status ${status}, rotating.`)
        });

        if (outcome.type === 'ok') {
            const data = await outcome.res.json();
            const item = data.data && data.data[0];
            if (!item || !item.url) {
                throw new StudioError('UPSTREAM_BAD_RESPONSE', 'No image returned by upstream.');
            }

            // Persist image locally
            const id = await reserveGalleryId(config);
            const partPath = path.join(config.galleryDir, `${id}.part`);
            let filename;
            try {
                const buf = await downloadBuffer(item.url);
                await fsp.writeFile(partPath, buf);
                filename = `${id}.${detectImageExt(buf)}`;
                await fsp.rename(partPath, path.join(config.galleryDir, filename));
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
            await ctx.stores.gallery.add(record);

            const result = { success: true, item: record };
            if (input.out) {
                await fsp.mkdir(input.out, { recursive: true });
                const dest = path.join(path.resolve(input.out), filename);
                await fsp.copyFile(path.join(config.galleryDir, filename), dest);
                result.copiedTo = dest;
            }
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
async function listGallery(ctx, { search, limit } = {}) {
    let items = await ctx.stores.gallery.list();
    const q = (search || '').toLowerCase().trim();
    if (q) items = items.filter(it => (it.prompt || '').toLowerCase().includes(q));
    if (limit) items = items.slice(0, Number(limit));
    return { success: true, items };
}

async function getGalleryItem(ctx, id) {
    const item = await ctx.stores.gallery.get(id);
    if (!item) throw new StudioError('NOT_FOUND', 'Not found.');
    return { success: true, item };
}

async function deleteGalleryItem(ctx, id) {
    const removed = await ctx.stores.gallery.remove(id);
    if (!removed) throw new StudioError('NOT_FOUND', 'Not found.');

    // Delete output + input thumbs from disk
    const toDelete = [removed.outputPath, ...(removed.inputThumbs || [])];
    for (const rel of toDelete) {
        const abs = path.join(ctx.config.dataDir, rel.replace(/^\//, ''));
        await fsp.unlink(abs).catch(() => {});
    }
    return { success: true };
}

module.exports = {
    generateImage, prepareImageRequest, listGallery, getGalleryItem, deleteGalleryItem,
    nextGalleryId, formatTimestamp, modelSupportsSequentialAndStream
};
