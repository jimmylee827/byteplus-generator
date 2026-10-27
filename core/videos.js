// ---- VIDEO EDITING (Seedance 2.5 · ModelArk contents/generations/tasks) ----
// Edit mode: at least one reference_video drives an omni reference-to-video *edit*
// task (omni_reference_task_type = "edit"). Tasks are asynchronous, so the caller
// polls (pollOnce / wait); the finished clip is downloaded to videos/ once the
// upstream reports "succeeded". Reuses the same rotating BytePlus API keys as images.
//
// How local files reach BytePlus at all is explained in core/staging.js.
const fsp = require('fs/promises');
const path = require('path');
const { StudioError } = require('./errors');
const { TASKS_URL, rotatingFetch } = require('./ark');
const { withLock } = require('./stores/lock');
const { downloadFile } = require('./files');
const { stageLocalFile, unstageFiles } = require('./staging');

function sanitizeFilename(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '_'); }

// Duration bounds, established empirically against the live API (4-30 accepted;
// outside that the request is rejected), because the published docs render their body
// client-side and can't be read directly. The same range holds for every subtask that
// accepts a duration at all.
//
// There is deliberately no ratio allow-list. A well-formed-but-unusable enum value
// survives the early syntax check — a bogus-resolution canary reported even "nonsense"
// as a valid ratio — so a list built that way would be fiction. The subtask constraint
// is enforced later and only a real submission reveals it, so we send ratio where a
// real submission proved it works and let upstream speak for anything else.
const VIDEO_DURATION_MIN = 4;
const VIDEO_DURATION_MAX = 30;
const VIDEO_DURATION_DEFAULT = 5;

/**
 * Which ARK subtask a set of inputs maps to. `omni_reference_task_type` accepts
 * auto | reference | edit | extend; we never send 'auto' because the three concrete
 * cases are known and an explicit value keeps the request reproducible.
 */
function videoSubtask(mode, refVideo) {
    if (mode === 'firstLast') return 'first_last';
    return refVideo ? 'edit' : 'reference';
}

// Builds the ARK task body for every video mode. Kept as one function because the modes
// disagree about which parameters are even legal, and the upstream rejects the whole
// request on a stray key rather than ignoring it.
//
//   edit       — a reference clip drives the output (`omni_reference_task_type: 'edit'`).
//                ratio/duration are DICTATED by the source clip and the API rejects the
//                request outright if either is supplied.
//   reference  — no clip, just a reference image ('reference'). With nothing to inherit
//                from, ratio AND duration become real inputs and are honoured exactly
//                (a 16:9 / 4s request came back as 16:9 / 4s).
//   first_last — keyframe generation, which the API reports internally as "flf2v". The
//                mode is inferred from the image roles, so `omni_reference_task_type`
//                must be OMITTED here. `duration` is a real input; `ratio` is NOT — the
//                output follows the first-frame image. `last_frame` is only legal
//                alongside `first_frame`, and frame content cannot be combined with
//                reference media.
function buildVideoTaskBody(opts) {
    const {
        mode, model, text, refVideo, refImage, firstFrame, lastFrame,
        resolution, ratio, duration, watermark, generateAudio, seed, defaultModel
    } = opts;

    const content = [{ type: 'text', text }];
    const body = {
        model: model || defaultModel,
        content,
        resolution: resolution || '1080p',
        watermark: !!watermark
    };
    const subtask = videoSubtask(mode, refVideo);

    if (subtask === 'first_last') {
        content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' });
        if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' });
        body.duration = Number(duration) || VIDEO_DURATION_DEFAULT;
    } else if (subtask === 'edit') {
        content.push({ type: 'video_url', video_url: { url: refVideo }, role: 'reference_video' });
        if (refImage) content.push({ type: 'image_url', image_url: { url: refImage }, role: 'reference_image' });
        body.omni_reference_task_type = 'edit';
    } else {
        content.push({ type: 'image_url', image_url: { url: refImage }, role: 'reference_image' });
        body.omni_reference_task_type = 'reference';
        if (ratio) body.ratio = ratio;
        body.duration = Number(duration) || VIDEO_DURATION_DEFAULT;
    }

    if (generateAudio !== undefined) body.generate_audio = !!generateAudio;
    if (seed) body.seed = Number(seed);
    return body;
}

// What each subtask lets the caller choose. Drives `video modes`, `video plan` and the
// composer, which shows only the controls listed here.
const SUBTASKS = {
    edit: { accepts: { ratio: false, duration: false }, ratioFollows: 'source clip', durationFollows: 'source clip' },
    reference: { accepts: { ratio: true, duration: true }, ratioFollows: null, durationFollows: null },
    first_last: { accepts: { ratio: false, duration: true }, ratioFollows: 'first frame', durationFollows: null }
};

/** `ai-media-studio video modes`: everything a UI or agent needs to build a request. */
function videoModes(config) {
    return {
        success: true,
        modes: [
            { id: 'edit', label: 'Edit clip', inputs: ['video', 'image'], note: 'A reference clip (→ edit) or a reference image alone (→ reference); either is enough.' },
            { id: 'firstLast', label: 'First → Last frame', inputs: ['firstFrame', 'lastFrame'], note: 'Requires a first frame; a last frame is optional. Cannot be combined with reference media.' }
        ],
        subtasks: SUBTASKS,
        models: [{ id: config.videoModel, label: 'Seedance 2.5', default: true }],
        resolutions: ['1080p', '720p', '480p'],
        defaultResolution: '1080p',
        ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
        defaultRatio: '16:9',
        duration: { min: VIDEO_DURATION_MIN, max: VIDEO_DURATION_MAX, default: VIDEO_DURATION_DEFAULT },
        defaults: { generateAudio: true, watermark: false },
        uploadLimitMb: config.videoUploadLimitMb,
        source: {
            minPixels: 407696,
            minDurationSeconds: VIDEO_DURATION_MIN,
            maxDurationSeconds: VIDEO_DURATION_MAX
        }
    };
}

function uploadTooLargeMessage(config) {
    return `File too large — the limit is ${config.videoUploadLimitMb} MB. Trim the clip, export it smaller, ` +
        'or raise VIDEO_UPLOAD_LIMIT_MB in .env.';
}

function uploadsUnavailableMessage(surface, mode) {
    if (surface === 'http') {
        // Frame mode has no URL escape hatch in the composer — the images are always
        // uploads — so only edit mode gets told to paste a URL instead.
        return 'Uploads are paused while the public tunnel reconnects — BytePlus downloads ' +
            'reference media itself, so this server must be reachable. It should recover within ' +
            'a few seconds; retry shortly' +
            (mode === 'firstLast' ? '. ' : ', or paste a public video URL instead. ') +
            '(If AUTO_TUNNEL=0, set PUBLIC_BASE_URL yourself.)';
    }
    return 'Local files need a public URL that BytePlus can download them from, and none is live. ' +
        'Start `ai-media-studio serve` or `ai-media-studio tunnel up` in another terminal, ' +
        'or pass public https:// URLs instead of local paths. ' +
        '(With AUTO_TUNNEL=0, set PUBLIC_BASE_URL in .env.)';
}

const isUpload = (m) => Boolean(m) && !m.url;

/**
 * Everything about a request that can be known without spending money or staging
 * files. Media inputs are null | { url } | { buffer, originalname } | { upload: true }
 * (the last only for planning, when the bytes aren't sent).
 */
function analyzeVideo(ctx, input) {
    // Mode defaults to 'edit' so any client that predates frame mode keeps working.
    const mode = (input.mode === 'firstLast' || input.mode === 'first-last') ? 'firstLast' : 'edit';
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const { video, image, firstFrame, lastFrame } = input;
    const subtask = videoSubtask(mode, video);
    const uploads = [video, image, firstFrame, lastFrame].filter(isUpload);
    const publicBaseUrl = ctx.publicUrl();
    const problems = [];
    const add = (code, message) => problems.push(new StudioError(code, message));

    const limit = ctx.config.videoUploadLimitMb * 1024 * 1024;
    if (uploads.some(u => u.buffer && u.buffer.length > limit)) add('VALIDATION', uploadTooLargeMessage(ctx.config));

    if (!prompt.trim()) {
        add('VALIDATION', mode === 'firstLast' ? 'A prompt is required.' : 'An edit instruction is required.');
    }

    // Frame content and reference media are mutually exclusive upstream ("first/last
    // frame content cannot be mixed with reference media content"), and a last frame is
    // only legal alongside a first. Catch both here so the caller gets a clear reason
    // instead of an opaque 400 from the validator.
    if (mode === 'firstLast') {
        if (!firstFrame) {
            add('VALIDATION', 'A first frame image is required.');
        } else if (video || image) {
            add('VALIDATION', 'First/last frame mode can\'t be combined with a reference video or reference image — ' +
                'the model rejects mixing them. Clear the reference media, or switch to Edit mode.');
        }
    } else if (firstFrame || lastFrame) {
        add('VALIDATION', 'Frame images were supplied but the request is in Edit mode. Switch to first/last frame mode.');
    }

    // Uploaded files must be reachable by BytePlus, so they're staged into
    // videos/staging/ and referenced through the public URL. Without one there is no
    // way to serve them, so say so plainly rather than letting the request fail deep
    // inside the upstream validator.
    if (uploads.length && !publicBaseUrl) add('UPLOADS_UNAVAILABLE', uploadsUnavailableMessage(ctx.surface, mode));

    // Edit mode needs *something* to work from, but either reference will do: a clip
    // maps to the 'edit' subtask, a lone image to 'reference'.
    if (mode === 'edit' && !video && !image) {
        add('VALIDATION', 'Add a reference video (upload a clip or provide a URL) or a reference image.');
    }
    // Duration is only ours to set where there's no source clip dictating it.
    if (subtask !== 'edit') {
        const { duration } = input;
        const d = Number(duration);
        if (duration !== undefined && duration !== null && duration !== '' &&
            (!Number.isFinite(d) || d < VIDEO_DURATION_MIN || d > VIDEO_DURATION_MAX)) {
            add('VALIDATION', `Duration must be between ${VIDEO_DURATION_MIN} and ${VIDEO_DURATION_MAX} seconds.`);
        }
    }
    return { mode, prompt, subtask, uploads, publicBaseUrl, problems };
}

/** `video plan`: free — what the request would become, and what's wrong with it. */
function planVideo(ctx, input) {
    const a = analyzeVideo(ctx, input);
    return {
        success: true,
        mode: a.mode,
        subtask: a.subtask,
        ...SUBTASKS[a.subtask],
        uploads: { needed: a.uploads.length > 0, available: Boolean(a.publicBaseUrl) },
        problems: a.problems.map(p => ({ code: p.code, message: p.message })),
        ready: a.problems.length === 0
    };
}

function bodyOptions(ctx, input, a, urls) {
    const bool = (v) => v === 'true' || v === true;
    return {
        mode: a.mode,
        model: input.model,
        defaultModel: ctx.config.videoModel,
        text: a.prompt.trim(),
        refVideo: urls.video,
        refImage: urls.image,
        firstFrame: urls.firstFrame,
        lastFrame: urls.lastFrame,
        resolution: input.resolution,
        ratio: input.ratio,
        duration: input.duration,
        watermark: bool(input.watermark),
        generateAudio: input.generateAudio === undefined || input.generateAudio === null ? undefined : bool(input.generateAudio),
        seed: input.seed
    };
}

function arkErrorPayload(data, status) {
    if (data && data.error) {
        const e = data.error;
        return (typeof e === 'string') ? e : (e.message || e.code || JSON.stringify(e));
    }
    return (data && data.raw) ? data.raw : `Upstream ${status}`;
}

/**
 * Start a task. input: { mode, prompt, model?, resolution?, ratio?, duration?,
 * watermark?, generateAudio?, seed?, video?, image?, firstFrame?, lastFrame? }
 */
async function createVideo(ctx, input, { dryRun = false } = {}) {
    const a = analyzeVideo(ctx, input);
    if (a.problems.length) throw a.problems[0];
    const { config, log } = ctx;
    const fallbackExt = { video: '.mp4', image: '.png', firstFrame: '.png', lastFrame: '.png' };

    if (dryRun) {
        const urls = {};
        for (const k of Object.keys(fallbackExt)) {
            const m = input[k];
            urls[k] = !m ? null : m.url ? m.url.trim()
                : `<staged-upload: ${m.originalname || k}, ${m.buffer ? m.buffer.length : 0} bytes>`;
        }
        return { success: true, dryRun: true, request: { method: 'POST', url: TASKS_URL, body: buildVideoTaskBody(bodyOptions(ctx, input, a, urls)) } };
    }

    await fsp.mkdir(config.videoDir, { recursive: true });
    const stagedPaths = [];
    const urls = {};
    try {
        for (const k of Object.keys(fallbackExt)) {
            const m = input[k];
            if (!m) { urls[k] = null; continue; }
            if (m.url) { urls[k] = m.url.trim(); continue; }
            const staged = await stageLocalFile(config, a.publicBaseUrl, m.buffer, m.originalname, fallbackExt[k]);
            urls[k] = staged.url;
            stagedPaths.push(staged.file);
        }
    } catch (e) {
        log.error('[VIDEO] staging failed:', e);
        await unstageFiles(stagedPaths);
        throw new StudioError('INTERNAL', 'Failed to stage upload: ' + e.message);
    }

    const body = buildVideoTaskBody(bodyOptions(ctx, input, a, urls));

    let lastErr = null;
    try {
        const outcome = await rotatingFetch(ctx.keys, {
            url: TASKS_URL,
            method: 'POST',
            body: JSON.stringify(body),
            readRotatedText: true,
            onRotate: (status, text) => {
                lastErr = text;
                log.error('[VIDEO] create → ARK status', status, '(rotating key):', text);
            }
        });
        if (outcome.type === 'ok') {
            const data = await outcome.res.json().catch(() => null);
            const taskId = data && data.id;
            if (!taskId) {
                await unstageFiles(stagedPaths);
                throw new StudioError('UPSTREAM_BAD_RESPONSE', 'No task id returned by upstream.');
            }
            const now = new Date().toISOString();
            const record = {
                id: taskId,
                status: 'queued',
                prompt: body.content[0].text,
                model: body.model,
                taskType: videoSubtask(a.mode, urls.video),
                // Left null in every mode and filled in from the finished task. Edit
                // inherits ratio/duration from the source clip; frame mode derives the
                // ratio from the first-frame image (an 'adaptive' request came back as
                // "397:265"); reference mode honours what we asked for but the task is
                // still the authority.
                videoRatio: null,
                videoResolution: body.resolution,
                duration: null,
                // What we asked for, where asking was allowed — lets a card show the
                // intended values while the task is still running.
                requestedRatio: body.ratio || null,
                requestedDuration: body.duration || null,
                watermark: body.watermark,
                generateAudio: body.generate_audio || false,
                refSource: isUpload(input.video) ? 'upload' : (urls.video ? 'url' : 'image'),
                // Staged inputs stay on disk until the task is terminal — BytePlus
                // fetches them asynchronously, so deleting now would break the task.
                stagedPaths,
                refImage: null,
                fullVideo: null,
                // NOTE: firstFrame/lastFrame are the OUTPUT keyframes the finished task
                // reports; the input frames we sent live under inputFirstFrame/
                // inputLastFrame. Don't conflate them.
                firstFrame: null,
                lastFrame: null,
                inputFirstFrame: null,
                inputLastFrame: null,
                createdAt: now,
                updatedAt: now
            };
            // Keep a local copy of every input image so the gallery still has them
            // after the staged originals are swept.
            const saveInput = async (m, suffix) => {
                if (!isUpload(m)) return null;
                const name = `${sanitizeFilename(taskId)}_${suffix}${path.extname(m.originalname || '') || '.png'}`;
                await fsp.writeFile(path.join(config.videoDir, name), m.buffer);
                return `/videos/${name}`;
            };
            record.refImage = await saveInput(input.image, 'ref');
            record.inputFirstFrame = await saveInput(input.firstFrame, 'infirst');
            record.inputLastFrame = await saveInput(input.lastFrame, 'inlast');
            await ctx.stores.videos.add(record);
            return { success: true, taskId, record };
        }
        if (outcome.type === 'error') {
            const r = outcome.res;
            const errBody = await r.text().catch(() => '');
            log.error('[VIDEO] create → ARK status', r.status, ':', errBody);
            let data = null; try { data = JSON.parse(errBody); } catch {}
            await unstageFiles(stagedPaths);
            throw new StudioError('UPSTREAM_REJECTED', arkErrorPayload(data, r.status), { httpStatus: r.status, raw: errBody });
        }
    } catch (e) {
        if (e instanceof StudioError) throw e;
        log.error('[VIDEO] create:', e);
        await unstageFiles(stagedPaths);
        throw new StudioError('NETWORK', e.message || 'Internal server error', { retryable: true });
    }
    log.error('[VIDEO] create → all keys exhausted. last error:', lastErr);
    await unstageFiles(stagedPaths);
    throw new StudioError('KEYS_EXHAUSTED', lastErr ? lastErr : 'All API keys exhausted.', { raw: lastErr });
}

// Authenticated GET against the ARK tasks API, with key rotation on quota/rate/auth.
async function arkTaskGet(ctx, id) {
    const outcome = await rotatingFetch(ctx.keys, {
        url: `${TASKS_URL}/${encodeURIComponent(id)}`,
        readRotatedText: true
    });
    if (outcome.type === 'ok') return { ok: true, status: outcome.res.status, data: await outcome.res.json().catch(() => null) };
    if (outcome.type === 'nokey') throw new StudioError('KEYS_EXHAUSTED', 'No active API keys.');
    if (outcome.type === 'exhausted') {
        if (outcome.res) return { ok: false, status: outcome.res.status, data: { raw: outcome.lastText || '' } };
        return { ok: false, status: 503, exhausted: true, data: { raw: 'All API keys exhausted.' } };
    }
    return { ok: false, status: outcome.res.status, data: await outcome.res.json().catch(() => ({ raw: '' })) };
}

// Map ARK task statuses to our gallery record vocabulary.
function normalizeVideoStatus(s) {
    if (s === 'succeeded') return 'succeeded';
    if (s === 'failed' || s === 'cancelled') return 'failed';
    if (s === 'running') return 'running';
    return 'queued';
}

const isTerminal = (status) => status === 'succeeded' || status === 'failed';

// The reason a failed task gives, as the UI shows it.
function failureReason(task) {
    return (task && task.error)
        ? (task.error.message || task.error.code || JSON.stringify(task.error))
        : 'Generation failed upstream.';
}

// Polling cadence, as the composer has always used it: the first poll is immediate,
// then the interval scales as the task ages (5s → 10s → 20s). A network blip retries
// after 10s, up to the 12th attempt.
function pollDelay(attempt) {
    return attempt < 6 ? 5000 : attempt < 20 ? 10000 : 20000;
}
const NETWORK_RETRY_DELAY = 10000;
const NETWORK_RETRY_MAX_ATTEMPTS = 12;

/**
 * One status check. On terminal success, downloads the clip + keyframes; on any terminal
 * state, unstages inputs. Safe to run from several processes at once: the finalize step
 * runs under a per-task lock and re-reads the record inside it.
 */
async function pollOnce(ctx, id, { attempt } = {}) {
    const { config, log } = ctx;
    let result;
    try {
        result = await arkTaskGet(ctx, id);
    } catch (e) {
        if (e instanceof StudioError) throw e;
        throw new StudioError('NETWORK', e.message || 'Internal server error', { retryable: true });
    }
    if (!result.ok) {
        const raw = (result.data && result.data.raw) ? result.data.raw : JSON.stringify(result.data);
        log.error('[VIDEO] poll → ARK status', result.status, 'for task', id, ':', raw);
        throw new StudioError(result.exhausted ? 'KEYS_EXHAUSTED' : 'UPSTREAM_BAD_RESPONSE', arkErrorPayload(result.data, result.status), {
            httpStatus: result.status === 503 ? 503 : 502, raw
        });
    }
    const task = result.data || {};
    const status = normalizeVideoStatus(task.status);
    await fsp.mkdir(config.videoDir, { recursive: true });

    // Long-held on purpose: a second poller of the same finished task waits here
    // instead of downloading the clip again.
    const record = await withLock(config.locksDir, `video-${id}`, async () => {
        const existing = await ctx.stores.videos.get(id);
        let record = existing || {
            id, status, prompt: '', model: '', createdAt: task.created_at || new Date().toISOString(), updatedAt: new Date().toISOString()
        };

        // On terminal success, download the produced clip + any returned keyframes so the
        // gallery keeps the asset after the upstream URL expires.
        if (status === 'succeeded' && existing && !existing.fullVideo) {
            const safe = sanitizeFilename(id);
            const rec = { ...existing, status: 'succeeded' };
            const videoUrl = task.content && task.content.video_url;
            if (videoUrl) {
                const fp = path.join(config.videoDir, `${safe}.mp4`);
                try { await downloadFile(videoUrl, fp); rec.fullVideo = `/videos/${safe}.mp4`; }
                catch (e) { log.error('[VIDEO] download:', e.message); }
            }
            if (task.content && task.content.first_frame_image_url) {
                const ff = `${safe}_first.jpg`;
                try { await downloadFile(task.content.first_frame_image_url, path.join(config.videoDir, ff)); rec.firstFrame = `/videos/${ff}`; }
                catch (e) { log.error('[VIDEO] firstframe:', e.message); }
            }
            if (task.content && task.content.last_frame_image_url) {
                const lf = `${safe}_last.jpg`;
                try { await downloadFile(task.content.last_frame_image_url, path.join(config.videoDir, lf)); rec.lastFrame = `/videos/${lf}`; }
                catch (e) { log.error('[VIDEO] lastframe:', e.message); }
            }
            // Edit mode inherits ratio/duration from the source clip, so learn the real
            // values from the finished task rather than echoing what we requested.
            const usage = task.usage || {};
            if (task.duration != null) rec.duration = task.duration;
            else if (usage.duration != null) rec.duration = usage.duration;
            if (task.ratio) rec.videoRatio = task.ratio;
            else if (usage.ratio) rec.videoRatio = usage.ratio;
            rec.updatedAt = new Date().toISOString();
            record = rec;
        } else if (status !== normalizeVideoStatus(existing && existing.status)) {
            // (The pre-refactor server spread `existing || {}` here, which dropped the id
            // from a stub record for a task it hadn't created.)
            record = { ...record, status };
            record.updatedAt = new Date().toISOString();
        }

        // When ARK marks the task failed, the real reason lives in task.error — log it
        // in full so the request id / quota / model-activation codes aren't lost.
        if (status === 'failed' && task.error) {
            log.error('[VIDEO] task', id, 'FAILED:', JSON.stringify(task.error));
            // Mirror it onto the persisted record so it shows in the gallery card too.
            record.error = task.error.message || task.error.code || JSON.stringify(task.error);
        }

        // The task is done with our staged inputs once it's terminal — drop them so
        // videos/staging/ doesn't accumulate copies of every uploaded clip.
        if (isTerminal(status) && record.stagedPaths?.length) {
            await unstageFiles(record.stagedPaths);
            delete record.stagedPaths;
        }

        // Persist the change in place (keeps newest-first ordering).
        await ctx.stores.videos.upsert(id, () => record);
        return record;
    }, { timeoutMs: 15 * 60 * 1000, staleMs: 30 * 60 * 1000 });

    const terminal = isTerminal(status);
    return {
        success: true,
        status,
        task,
        record,
        terminal,
        failureReason: status === 'failed' ? failureReason(task) : null,
        nextPollMs: terminal || !attempt ? null : pollDelay(Number(attempt))
    };
}

const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Poll until terminal, with the composer's cadence. Resolves with the final poll on
 * success; rejects TASK_FAILED, WAIT_TIMEOUT, or whatever stopped polling.
 */
async function waitForVideo(ctx, id, { timeoutMs = null, onProgress } = {}) {
    const scale = ctx.config.pollScale || 1;
    const sleep = ctx.sleep || realSleep;
    const deadline = timeoutMs ? Date.now() + timeoutMs : null;
    let attempts = 0;
    let lastStatus = 'queued';
    for (;;) {
        attempts++;
        let r;
        try {
            r = await pollOnce(ctx, id, { attempt: attempts });
        } catch (e) {
            // Transient network blips: keep polling a few times before giving up.
            if (e.code === 'NETWORK' && attempts < NETWORK_RETRY_MAX_ATTEMPTS) {
                await sleep(NETWORK_RETRY_DELAY * scale);
                continue;
            }
            throw e;
        }
        lastStatus = r.status;
        if (onProgress) onProgress(r);
        if (r.status === 'succeeded') return r;
        if (r.status === 'failed') {
            throw new StudioError('TASK_FAILED', r.failureReason, { extra: { taskId: id, record: r.record } });
        }
        const delay = pollDelay(attempts) * scale;
        if (deadline && Date.now() + delay > deadline) {
            throw new StudioError('WAIT_TIMEOUT',
                `Stopped waiting for task ${id}; it is still ${lastStatus}. ` +
                `Continue with \`ai-media-studio video wait ${id}\` or \`ai-media-studio video resume\`.`,
                { extra: { taskId: id, status: lastStatus } });
        }
        await sleep(delay);
    }
}

/** Re-poll every queued/running task to completion (what the composer does on reload). */
async function resumeVideos(ctx, { timeoutMs = null, onProgress } = {}) {
    const items = await ctx.stores.videos.list();
    const pending = items.filter(it => it.status === 'queued' || it.status === 'running').map(it => it.id);
    const settled = await Promise.allSettled(pending.map(id => waitForVideo(ctx, id, { timeoutMs, onProgress })));
    const results = settled.map((s, i) => s.status === 'fulfilled'
        ? { id: pending[i], status: s.value.status, record: s.value.record }
        : { id: pending[i], status: s.reason.code === 'TASK_FAILED' ? 'failed' : 'pending', error: s.reason.message, code: s.reason.code });
    return { success: true, resumed: pending.length, results };
}

// ---- VIDEO GALLERY ----
async function listVideos(ctx) {
    const items = await ctx.stores.videos.list();
    return {
        success: true,
        items,
        // Tasks the composer should keep polling after a reload.
        pendingIds: items.filter(it => it.status === 'queued' || it.status === 'running').map(it => it.id)
    };
}

async function getVideo(ctx, id) {
    const item = await ctx.stores.videos.get(id);
    if (!item) throw new StudioError('NOT_FOUND', 'Not found.');
    return { success: true, item };
}

async function deleteVideo(ctx, id) {
    const removed = await ctx.stores.videos.remove(id);
    if (!removed) throw new StudioError('NOT_FOUND', 'Not found.');
    const toDelete = [
        removed.fullVideo, removed.refImage,
        removed.firstFrame, removed.lastFrame,             // output keyframes
        removed.inputFirstFrame, removed.inputLastFrame    // input frames we sent
    ].filter(Boolean);
    for (const rel of toDelete) {
        const abs = path.join(ctx.config.dataDir, rel.replace(/^\//, ''));
        await fsp.unlink(abs).catch(() => {});
    }
    return { success: true };
}

module.exports = {
    VIDEO_DURATION_MIN, VIDEO_DURATION_MAX, VIDEO_DURATION_DEFAULT, SUBTASKS,
    videoSubtask, buildVideoTaskBody, videoModes, planVideo, analyzeVideo, createVideo,
    pollOnce, waitForVideo, resumeVideos, listVideos, getVideo, deleteVideo,
    pollDelay, normalizeVideoStatus, failureReason, uploadTooLargeMessage, arkErrorPayload
};
