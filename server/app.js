// The HTTP adapter. Each route reads the request, makes one core call, and sends the
// result through the shared presenter — no rules live here. The same core calls back
// the CLI and the MCP server, so all three return identical JSON.
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { StudioError, asStudioError, errorEnvelope } = require('../core/errors');
const { present } = require('../core/serialize');
const system = require('../core/system');
const images = require('../core/images');
const prompts = require('../core/prompts');
const videos = require('../core/videos');
const { MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES } = require('../core/models');
const { BY_NAME, runOperation, validateInput } = require('../core/operations');

// Requests that arrive through the cloudflared tunnel (Cloudflare adds
// cf-connecting-ip) exist only so BytePlus can fetch staged uploads. Everything else —
// the UI, the API, deletes, billed generation — is for this machine alone.
function tunnelScope(req, res, next) {
    if (!req.headers['cf-connecting-ip']) return next();
    if ((req.method === 'GET' || req.method === 'HEAD') && req.path.startsWith('/videos/staging/')) return next();
    res.status(404).json({ success: false, error: 'Not found.', code: 'NOT_FOUND' });
}

function createApp(ctx) {
    const { config, log } = ctx;
    const app = express();
    app.use((_req, res, next) => {
        res.setHeader('Alt-Svc', 'clear');
        next();
    });
    app.use(tunnelScope);
    app.use(cors());
    app.use(express.json({ limit: '50mb' }));
    app.use(express.static(config.publicDir));
    app.use('/gallery', express.static(config.galleryDir));
    app.use('/videos', express.static(config.videoDir));

    const sendError = (res, e) => {
        const err = asStudioError(e);
        if (!(e instanceof StudioError)) log.error('[HTTP]', e);
        res.status(err.httpStatus).json(errorEnvelope(err));
    };
    const route = (kind, fn) => async (req, res) => {
        try {
            res.json(present[kind](config, await fn(req)));
        } catch (e) {
            sendError(res, e);
        }
    };

    // Multer rejects oversize/extra files by throwing, which Express would otherwise
    // render as an HTML stack trace — unreadable in the video tab's error card. Wrap the
    // middleware so those failures come back as the same JSON shape as every other error.
    const wrapUpload = (mw, messageFor) => (req, res, next) => mw(req, res, (err) => {
        if (!err) return next();
        log.error('[UPLOAD] rejected:', err.code || '', err.message);
        sendError(res, new StudioError('VALIDATION', messageFor(err)));
    });

    const imageUpload = wrapUpload(
        multer({
            storage: multer.memoryStorage(),
            limits: { fileSize: MAX_REFERENCE_IMAGE_BYTES, files: MAX_REFERENCE_IMAGES } // 10MB, max 9 image refs
        }).array('images', MAX_REFERENCE_IMAGES),
        (err) => err.code === 'LIMIT_FILE_SIZE'
            ? `Reference image too large — the limit is ${MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024} MB each.`
            : (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')
                ? `Maximum ${MAX_REFERENCE_IMAGES} reference images.`
                : `Upload rejected: ${err.message}`
    );

    // Video reference clips can be larger; limit one file per field.
    const videoUpload = wrapUpload(
        multer({
            storage: multer.memoryStorage(),
            // Edit mode sends video + optional ref image; frame mode sends first + optional
            // last frame. Two is the real per-request maximum either way; the third slot is
            // headroom so a stray field fails validation with our message, not multer's.
            limits: { fileSize: config.videoUploadLimitMb * 1024 * 1024, files: 3 }
        }).fields([
            { name: 'video', maxCount: 1 },
            { name: 'image', maxCount: 1 },
            { name: 'firstFrame', maxCount: 1 },
            { name: 'lastFrame', maxCount: 1 }
        ]),
        (err) => err.code === 'LIMIT_FILE_SIZE' ? videos.uploadTooLargeMessage(config) : `Upload rejected: ${err.message}`
    );

    const fileOf = (f) => (f ? { buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype } : null);
    const urlOf = (s) => (typeof s === 'string' && s.trim() ? { url: s.trim() } : null);
    const parseJsonField = (v, name) => {
        if (v === undefined || v === '' || typeof v === 'object') return v || undefined;
        try { return JSON.parse(v); } catch { throw new StudioError('VALIDATION', `${name} must be JSON.`); }
    };
    // A list field: repeated multipart fields, a JSON array, or one value.
    const listField = (v) => {
        if (v === undefined || v === '') return undefined;
        if (Array.isArray(v)) return v.map(String);
        if (typeof v === 'string' && v.trim().startsWith('[')) return parseJsonField(v, 'list');
        return [String(v)];
    };
    // Operations whose input is plain JSON (paths, not uploads) run exactly as the CLI
    // runs them: same validation, same operation, same presenter.
    const opRoute = (name, fromReq) => async (req, res) => {
        try {
            const input = fromReq(req);
            for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
            validateInput(BY_NAME.get(name), input);
            res.json(await runOperation(ctx, name, input));
        } catch (e) {
            sendError(res, e);
        }
    };

    // --- ROUTES ---
    app.get('/api/health', route('plain', () => system.health(ctx)));
    app.get('/api/models', route('plain', () => system.models(ctx)));

    app.post('/api/generate', imageUpload, route('image', (req) => {
        const b = req.body || {};
        return images.generateImage(ctx, {
            prompt: b.prompt,
            slots: parseJsonField(b.slots, 'slots'),
            model: b.model,
            size: b.size,
            resolution: b.resolution,
            ratio: b.ratio,
            outputFormat: b.output_format,
            watermark: b.watermark,
            seed: b.seed,
            group: b.group,
            // Optional, aligned with the uploaded images: ["garment", "character", …].
            imageRoles: parseJsonField(b.imageRoles, 'imageRoles'),
            legend: b.legend === undefined ? undefined : !(b.legend === 'false' || b.legend === false),
            tags: listField(b.tags),
            meta: parseJsonField(b.meta, 'meta'),
            images: (req.files || []).map(fileOf)
        });
    }));
    app.post('/api/image/batch', opRoute('image.batch', (req) => ({ ...req.body })));
    app.post('/api/image/trim', opRoute('image.trim', (req) => ({ ...req.body })));
    app.post('/api/image/tile', opRoute('image.tile', (req) => ({ ...req.body })));
    app.post('/api/image/compare', opRoute('image.compare', (req) => ({ ...req.body })));
    app.get('/api/usage', opRoute('usage', (req) => ({ since: req.query.since, until: req.query.until, tag: listField(req.query.tag) })));

    app.get('/api/gallery', route('image', (req) => images.listGallery(ctx, { search: req.query.search, limit: req.query.limit, tag: listField(req.query.tag) })));
    app.post('/api/gallery/prune', opRoute('gallery.prune', (req) => ({ tag: listField((req.body || {}).tag), olderThan: (req.body || {}).olderThan, yes: (req.body || {}).yes })));
    app.get('/api/gallery/:id', route('image', (req) => images.getGalleryItem(ctx, req.params.id)));
    app.delete('/api/gallery/:id', route('plain', (req) => images.deleteGalleryItem(ctx, req.params.id)));

    // ---- PROMPT LIBRARY ROUTES ----
    app.get('/api/prompts', route('plain', (req) => prompts.listPrompts(ctx, { search: req.query.search })));
    app.post('/api/prompts/slots', route('plain', (req) => prompts.promptSlots(ctx, req.body || {})));
    app.post('/api/prompts/compile', route('plain', (req) => prompts.compilePromptTemplate(ctx, req.body || {})));
    app.get('/api/prompts/:id', route('plain', (req) => prompts.getPrompt(ctx, req.params.id)));
    app.post('/api/prompts', route('plain', (req) => prompts.createPrompt(ctx, req.body || {})));
    app.put('/api/prompts/:id', route('plain', (req) => prompts.updatePrompt(ctx, req.params.id, req.body || {})));
    app.post('/api/prompts/:id/restore/:version', route('plain', (req) => prompts.restorePrompt(ctx, req.params.id, req.params.version)));
    app.delete('/api/prompts/:id', route('plain', (req) => prompts.deletePrompt(ctx, req.params.id)));

    // ---- VIDEO ROUTES ----
    app.get('/api/video/modes', route('plain', () => videos.videoModes(config)));
    // The composer describes what it holds (no bytes): hasVideo / hasImage / hasFirstFrame
    // / hasLastFrame flags, or URLs, plus mode, prompt and duration.
    app.post('/api/video/plan', route('plain', (req) => {
        const b = req.body || {};
        const media = (has, url) => urlOf(url) || (has ? { upload: true } : null);
        return videos.planVideo(ctx, {
            mode: b.mode,
            prompt: b.prompt,
            duration: b.duration,
            video: media(b.hasVideo, b.refVideoUrl),
            image: media(b.hasImage, b.refImageUrl),
            firstFrame: media(b.hasFirstFrame, b.firstFrameUrl),
            lastFrame: media(b.hasLastFrame, b.lastFrameUrl)
        });
    }));
    app.post('/api/video/generate', videoUpload, route('video', (req) => {
        const b = req.body || {};
        const f = (name) => fileOf((req.files?.[name] || [])[0]);
        return videos.createVideo(ctx, {
            mode: b.mode,
            prompt: b.userMessage,
            model: b.model,
            ratio: b.ratio,
            resolution: b.resolution,
            duration: b.duration,
            watermark: b.watermark,
            generateAudio: b.generateAudio,
            seed: b.seed,
            // An uploaded file overrides a pasted URL for the same slot.
            video: f('video') || urlOf(b.refVideoUrl),
            image: f('image') || urlOf(b.refImageUrl),
            firstFrame: f('firstFrame') || urlOf(b.firstFrameUrl),
            lastFrame: f('lastFrame') || urlOf(b.lastFrameUrl)
        });
    }));
    app.get('/api/video/tasks/:id', route('video', (req) => videos.pollOnce(ctx, req.params.id, { attempt: req.query.attempt })));
    app.get('/api/video/gallery', route('video', () => videos.listVideos(ctx)));
    app.get('/api/video/:id', route('video', (req) => videos.getVideo(ctx, req.params.id)));
    app.delete('/api/video/:id', route('plain', (req) => videos.deleteVideo(ctx, req.params.id)));

    return app;
}

module.exports = { createApp, tunnelScope };
