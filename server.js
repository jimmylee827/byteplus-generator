require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { Tunnel } = require('./tunnel');
let tunnel = null;

// --- CONFIGURATION ---
const ENDPOINT_ID = process.env.ENDPOINT_ID;
const PORT = process.env.PORT || 3000;
const API_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations';

// Not every Seedream model accepts the same request body, and ModelArk rejects
// the whole call on an unsupported key rather than ignoring it. Seedream 5.0 Pro
// drops both `sequential_image_generation` and `stream` (5.0 Lite and 4.x keep
// them), so those are only sent to models known to take them. Matching on the ID
// rather than an exact string keeps pass-through model IDs working.
function modelSupportsSequentialAndStream(modelId) {
    return !/seedream-5-0-pro/i.test(modelId || '');
}

const apiKeys = (process.env.BYTEPLUS_API_KEYS || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

if (!ENDPOINT_ID || apiKeys.length === 0) {
    console.error('ERROR: Missing ENDPOINT_ID or BYTEPLUS_API_KEYS in .env file.');
    process.exit(1);
}

// Video editing drives Seedance 2.5 via the ModelArk "contents/generations/tasks"
// API — the same BytePlus ARK host and the same rotating API keys image gen uses,
// so no separate credentials are required. The default model id can be overridden
// with VIDEO_MODEL (e.g. a specific snapshot) if BytePlus ships a newer alias.
const WEB_API_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const VIDEO_MODEL = (process.env.VIDEO_MODEL || 'dreamina-seedance-2-5-260628').trim();
const videoEnabled = apiKeys.length > 0;

// The tasks API only accepts reference media as a URL that BytePlus can fetch
// server-side (verified: `file_id` is not a supported content type, and data URIs
// are rejected). To use a *local* clip we must therefore serve it ourselves at an
// address reachable from the public internet. PUBLIC_BASE_URL is that address —
// e.g. an ngrok/cloudflared tunnel pointed at this server. Without it, uploads are
// refused up front with an actionable message and only pasted URLs work.
// A quick tunnel's hostname ROTATES, so this can't be a boot-time constant: it's
// read live on every request. AUTO_TUNNEL=0 disables the supervisor and pins the
// value to whatever .env holds (use that for a stable/named tunnel).
let publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const AUTO_TUNNEL = process.env.AUTO_TUNNEL !== '0' && process.env.AUTO_TUNNEL !== 'false';
function getPublicBaseUrl() { return publicBaseUrl; }
function uploadsAvailable() { return Boolean(publicBaseUrl); }

// --- PATHS ---
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const GALLERY_DIR = path.join(ROOT, 'gallery');
const MANIFEST_PATH = path.join(GALLERY_DIR, 'manifest.json');
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const PROMPTS_PATH = path.join(PROMPTS_DIR, 'library.json');

const VIDEO_DIR = path.join(ROOT, 'videos');
const VIDEO_MANIFEST_PATH = path.join(VIDEO_DIR, 'manifest.json');

if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });
if (!fs.existsSync(MANIFEST_PATH)) fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ items: [] }, null, 2));
if (!fs.existsSync(PROMPTS_DIR)) fs.mkdirSync(PROMPTS_DIR, { recursive: true });
if (!fs.existsSync(PROMPTS_PATH)) fs.writeFileSync(PROMPTS_PATH, JSON.stringify({ items: [] }, null, 2));
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });
if (!fs.existsSync(VIDEO_MANIFEST_PATH)) fs.writeFileSync(VIDEO_MANIFEST_PATH, JSON.stringify({ items: [] }, null, 2));

// --- KEY ROTATION MANAGER ---
class KeyManager {
    constructor(keys) {
        this.keys = keys.map(k => ({ key: k, uses: 0, disabled: false }));
        this.currentIndex = 0;
    }
    getCurrentKey() {
        const start = this.currentIndex;
        while (this.keys[this.currentIndex].disabled) {
            this.currentIndex = (this.currentIndex + 1) % this.keys.length;
            if (this.currentIndex === start) return null;
        }
        return this.keys[this.currentIndex].key;
    }
    recordSuccess() {
        this.keys[this.currentIndex].uses += 1;
        const u = this.keys[this.currentIndex].uses;
        console.log(`[KEY] index=${this.currentIndex} uses=${u}`);
        if (u >= 200) {
            console.log('[KEY] Hit 200 uses, hot-swapping.');
            this.rotateKey();
        }
    }
    rotateKey({ disable = false } = {}) {
        if (disable) this.keys[this.currentIndex].disabled = true;
        const start = this.currentIndex;
        do {
            this.currentIndex = (this.currentIndex + 1) % this.keys.length;
            if (this.currentIndex === start) return false;
        } while (this.keys[this.currentIndex].disabled);
        console.log(`[KEY] Rotated to index=${this.currentIndex}`);
        return true;
    }
    activeCount() { return this.keys.filter(k => !k.disabled).length; }
}
const keyManager = new KeyManager(apiKeys);

// --- MANIFEST HELPERS ---
async function readManifest() {
    const raw = await fsp.readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(raw);
}
async function writeManifest(m) {
    await fsp.writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2));
}
async function addManifestItem(item) {
    const m = await readManifest();
    m.items.unshift(item);
    await writeManifest(m);
}
async function removeManifestItem(id) {
    const m = await readManifest();
    const idx = m.items.findIndex(i => i.id === id);
    if (idx === -1) return null;
    const [removed] = m.items.splice(idx, 1);
    await writeManifest(m);
    return removed;
}

// --- VIDEO MANIFEST HELPERS ---
async function readVideoManifest() {
    const raw = await fsp.readFile(VIDEO_MANIFEST_PATH, 'utf-8');
    return JSON.parse(raw);
}
async function writeVideoManifest(m) {
    await fsp.writeFile(VIDEO_MANIFEST_PATH, JSON.stringify(m, null, 2));
}
async function addVideoItem(item) {
    const m = await readVideoManifest();
    m.items.unshift(item);
    await writeVideoManifest(m);
}
async function getVideoItem(id) {
    const m = await readVideoManifest();
    return m.items.find(i => i.id === id) || null;
}
async function removeVideoItem(id) {
    const m = await readVideoManifest();
    const idx = m.items.findIndex(i => i.id === id);
    if (idx === -1) return null;
    const [removed] = m.items.splice(idx, 1);
    await writeVideoManifest(m);
    return removed;
}

// --- PROMPT LIBRARY HELPERS ---
async function readPrompts() {
    const raw = await fsp.readFile(PROMPTS_PATH, 'utf-8');
    return JSON.parse(raw);
}
async function writePrompts(p) {
    await fsp.writeFile(PROMPTS_PATH, JSON.stringify(p, null, 2));
}
function summarizePrompt(p) {
    const cur = p.versions.find(v => v.version === p.currentVersion) || p.versions[p.versions.length - 1];
    return {
        id: p.id,
        title: p.title,
        body: cur ? cur.body : '',
        currentVersion: p.currentVersion,
        versionCount: p.versions.length,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    };
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
function nextGalleryId(date = new Date()) {
    const base = formatTimestamp(date);
    let id = base;
    let n = 2;
    while (
        fs.existsSync(path.join(GALLERY_DIR, `${id}.jpeg`)) ||
        fs.readdirSync(GALLERY_DIR).some(f => f.startsWith(id + '_in_') || f.startsWith(id + '.'))
    ) {
        id = `${base}_${n++}`;
    }
    return id;
}

// --- EXPRESS SETUP ---
const app = express();
app.use((_req, res, next) => {
    res.setHeader('Alt-Svc', 'clear');
    next();
});
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/gallery', express.static(GALLERY_DIR));
app.use('/videos', express.static(VIDEO_DIR));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 9 } // 10MB, max 9 image refs
});

// Video reference clips can be larger; limit one file per request.
const VIDEO_UPLOAD_LIMIT_MB = Number(process.env.VIDEO_UPLOAD_LIMIT_MB || 200);
const videoUpload = multer({
    storage: multer.memoryStorage(),
    // Edit mode sends video + optional ref image; frame mode sends first + optional
    // last frame. Two is the real per-request maximum either way; the third slot is
    // headroom so a stray field fails validation with our message, not multer's.
    limits: { fileSize: VIDEO_UPLOAD_LIMIT_MB * 1024 * 1024, files: 3 }
});

// Multer rejects oversize/extra files by throwing, which Express would otherwise
// render as an HTML stack trace — unreadable in the video tab's error card. Wrap the
// middleware so those failures come back as the same JSON shape as every other error.
function videoUploadFields(fields) {
    const mw = videoUpload.fields(fields);
    return (req, res, next) => mw(req, res, (err) => {
        if (!err) return next();
        console.error('[VIDEO] upload rejected:', err.code || '', err.message);
        const msg = err.code === 'LIMIT_FILE_SIZE'
            ? `File too large — the limit is ${VIDEO_UPLOAD_LIMIT_MB} MB. Trim the clip, export it smaller, ` +
              'or raise VIDEO_UPLOAD_LIMIT_MB in .env.'
            : `Upload rejected: ${err.message}`;
        res.status(400).json({ success: false, error: msg });
    });
}

// --- HELPERS ---
function bufferToDataUri(buffer, mimetype, fallback = 'image/png') {
    const mime = (mimetype || fallback).toLowerCase();
    return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function downloadFile(url, destPath) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await fsp.writeFile(destPath, buf);
    return buf.length;
}

// --- ROUTES ---
app.get('/api/health', (_req, res) => {
    res.json({
        ok: true,
        activeKeys: keyManager.activeCount(),
        totalKeys: apiKeys.length,
        videoEnabled,
        // Reference-media uploads only work when BytePlus can reach us (PUBLIC_BASE_URL).
        videoUploadsEnabled: uploadsAvailable(),
        publicBaseUrl: getPublicBaseUrl() || null
    });
});

app.post('/api/generate', upload.array('images', 9), async (req, res) => {
    const { prompt, size, watermark, model, output_format } = req.body || {};
    if (!prompt || !prompt.trim()) {
        return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    // Build base64 data URIs from uploaded files
    const inputImages = (req.files || []).map(f => bufferToDataUri(f.buffer, f.mimetype));

    // Model selection: "endpoint" (or empty) resolves to the configured Seedream
    // endpoint ID; anything else is treated as a ModelArk model ID (e.g.
    // "dola-seedream-5-0-pro-260628") and forwarded verbatim.
    const modelId = (model && model !== 'endpoint') ? model : ENDPOINT_ID;

    const body = {
        model: modelId,
        prompt: prompt.trim(),
        response_format: 'url',
        size: size || '4K',
        watermark: watermark === 'true' || watermark === true
    };
    if (modelSupportsSequentialAndStream(modelId)) {
        body.sequential_image_generation = 'disabled';
        body.stream = false;
    }
    // Seedream 5.0 Pro lets the caller pick png/jpeg; default behaviour for the
    // 4.5 endpoint is jpeg only, so we only override when explicitly requested.
    if (output_format && output_format !== 'auto') body.output_format = output_format;
    if (inputImages.length === 1) body.image = inputImages[0];
    else if (inputImages.length > 1) body.image = inputImages;

    let attempts = 0;
    const maxAttempts = keyManager.activeCount();

    while (attempts < maxAttempts) {
        const currentKey = keyManager.getCurrentKey();
        if (!currentKey) break;

        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${currentKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (response.ok) {
                const data = await response.json();
                keyManager.recordSuccess();

                const item = data.data && data.data[0];
                if (!item || !item.url) {
                    return res.status(502).json({ success: false, error: 'No image returned by upstream.' });
                }

                // Persist image locally
                const id = nextGalleryId();
                const filename = `${id}.jpeg`;
                const filePath = path.join(GALLERY_DIR, filename);
                try {
                    await downloadFile(item.url, filePath);
                } catch (e) {
                    console.error('[GALLERY] Download failed:', e.message);
                    return res.status(502).json({ success: false, error: 'Failed to save image locally.' });
                }

                // Save input thumbnails alongside (small, base64-truncated to avoid bloat)
                const inputThumbs = [];
                for (let i = 0; i < (req.files || []).length; i++) {
                    const f = req.files[i];
                    const thumbName = `${id}_in_${i}${path.extname(f.originalname) || '.png'}`;
                    const thumbPath = path.join(GALLERY_DIR, thumbName);
                    await fsp.writeFile(thumbPath, f.buffer);
                    inputThumbs.push(`/gallery/${thumbName}`);
                }

                const record = {
                    id,
                    prompt: body.prompt,
                    model: modelId,
                    size: item.size || body.size,
                    requestedSize: body.size,
                    watermark: body.watermark,
                    inputCount: inputImages.length,
                    inputThumbs,
                    outputPath: `/gallery/${filename}`,
                    createdAt: new Date().toISOString()
                };
                await addManifestItem(record);

                return res.json({ success: true, item: record });
            }

            // Quota / rate-limit / auth → rotate
            if ([401, 402, 403, 429].includes(response.status)) {
                console.log(`[KEY] Status ${response.status}, rotating.`);
                const rotated = keyManager.rotateKey({ disable: response.status === 401 });
                attempts++;
                if (!rotated) break;
                continue;
            }

            const errText = await response.text();
            // Pull the friendly message out of BytePlus's JSON error envelope, if any.
            let friendly = errText;
            try { const j = JSON.parse(errText); friendly = (j.error && (j.error.message || j.error.code)) || errText; } catch {}
            return res.status(response.status).json({ success: false, error: friendly });

        } catch (error) {
            console.error('[NET]', error);
            return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
        }
    }

    res.status(503).json({ success: false, error: 'All API keys exhausted or invalid.' });
});

app.get('/api/gallery', async (_req, res) => {
    try {
        const m = await readManifest();
        res.json({ success: true, items: m.items });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/gallery/:id', async (req, res) => {
    try {
        const m = await readManifest();
        const item = m.items.find(i => i.id === req.params.id);
        if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
        res.json({ success: true, item });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/gallery/:id', async (req, res) => {
    try {
        const removed = await removeManifestItem(req.params.id);
        if (!removed) return res.status(404).json({ success: false, error: 'Not found.' });

        // Delete output + input thumbs from disk
        const toDelete = [removed.outputPath, ...(removed.inputThumbs || [])];
        for (const rel of toDelete) {
            const abs = path.join(ROOT, rel.replace(/^\//, ''));
            await fsp.unlink(abs).catch(() => {});
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ---- PROMPT LIBRARY ROUTES ----
app.get('/api/prompts', async (_req, res) => {
    try {
        const p = await readPrompts();
        res.json({ success: true, items: p.items.map(summarizePrompt) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/prompts/:id', async (req, res) => {
    try {
        const p = await readPrompts();
        const item = p.items.find(i => i.id === req.params.id);
        if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
        res.json({ success: true, item });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/prompts', async (req, res) => {
    try {
        const { title, body } = req.body || {};
        if (!title || !title.trim()) return res.status(400).json({ success: false, error: 'Title is required.' });
        if (typeof body !== 'string') return res.status(400).json({ success: false, error: 'Body is required.' });
        const p = await readPrompts();
        const now = new Date().toISOString();
        const item = {
            id: randomUUID(),
            title: title.trim(),
            currentVersion: 1,
            versions: [{ version: 1, body, createdAt: now }],
            createdAt: now,
            updatedAt: now
        };
        p.items.unshift(item);
        await writePrompts(p);
        res.json({ success: true, item: summarizePrompt(item) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/prompts/:id', async (req, res) => {
    try {
        const { title, body } = req.body || {};
        const p = await readPrompts();
        const item = p.items.find(i => i.id === req.params.id);
        if (!item) return res.status(404).json({ success: false, error: 'Not found.' });

        const now = new Date().toISOString();
        let bumped = false;
        if (typeof title === 'string' && title.trim() && title.trim() !== item.title) {
            item.title = title.trim();
            bumped = true;
        }
        if (typeof body === 'string') {
            const cur = item.versions.find(v => v.version === item.currentVersion);
            if (!cur || cur.body !== body) {
                const newVer = item.currentVersion + 1;
                item.versions.push({ version: newVer, body, createdAt: now });
                item.currentVersion = newVer;
                bumped = true;
            }
        }
        if (bumped) item.updatedAt = now;
        await writePrompts(p);
        res.json({ success: true, item: summarizePrompt(item) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/prompts/:id/restore/:version', async (req, res) => {
    try {
        const ver = parseInt(req.params.version, 10);
        const p = await readPrompts();
        const item = p.items.find(i => i.id === req.params.id);
        if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
        const target = item.versions.find(v => v.version === ver);
        if (!target) return res.status(404).json({ success: false, error: 'Version not found.' });

        const now = new Date().toISOString();
        const newVer = item.currentVersion + 1;
        item.versions.push({ version: newVer, body: target.body, createdAt: now, restoredFrom: ver });
        item.currentVersion = newVer;
        item.updatedAt = now;
        await writePrompts(p);
        res.json({ success: true, item: summarizePrompt(item) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/prompts/:id', async (req, res) => {
    try {
        const p = await readPrompts();
        const idx = p.items.findIndex(i => i.id === req.params.id);
        if (idx === -1) return res.status(404).json({ success: false, error: 'Not found.' });
        p.items.splice(idx, 1);
        await writePrompts(p);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ---- VIDEO EDITING ROUTES (Seedance 2.5 · ModelArk contents/generations/tasks) ----
// Edit mode: at least one reference_video drives an omni reference-to-video *edit*
// task (omni_reference_task_type = "edit"). Tasks are asynchronous, so the client
// polls /api/video/tasks/:id; the server downloads the final clip to /videos once the
// upstream reports "succeeded". Reuses the same rotating BytePlus API keys as images.
//
// IMPORTANT — how reference media reaches BytePlus:
// The tasks API accepts exactly these content types (per its own validator):
// `text`, `image_url`, `audio_url`, `video_url`, `draft_task`. There is NO file_id
// block, and video_url.url must be a real, fetchable URL — data URIs are rejected
// ("must be provided as a web url"). The ModelArk Files API is *not* a way around
// this: uploads reach status "active" but never return a download_url, so a file_id
// can't be turned into a URL either.
//
// Consequence: a local upload can only be used if BytePlus can download it from us.
// We stage the upload into videos/staging/ and hand the task a PUBLIC_BASE_URL link
// to it. Staged files are cleaned up once the task reaches a terminal state.
// A pasted URL skips staging entirely and is passed through verbatim.
function sanitizeFilename(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '_'); }

const STAGING_DIR = path.join(VIDEO_DIR, 'staging');
if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });

// Write an uploaded buffer into the publicly-served staging dir and return both the
// absolute URL to hand upstream and the on-disk path so we can delete it later.
async function stageLocalFile(buffer, originalname, fallbackExt) {
    const ext = (path.extname(originalname || '') || fallbackExt).toLowerCase();
    const name = `${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
    await fsp.writeFile(path.join(STAGING_DIR, name), buffer);
    return { url: `${getPublicBaseUrl()}/videos/staging/${name}`, file: path.join(STAGING_DIR, name) };
}

// Best-effort removal of staged inputs once upstream no longer needs them.
async function unstageFiles(paths) {
    for (const p of paths || []) {
        try { await fsp.unlink(p); } catch { /* already gone */ }
    }
}

// A task that is never polled to completion (server restart, closed tab) leaves its
// staged input behind. Nothing upstream needs a clip older than the longest plausible
// render, so sweep stale files on boot and hourly to keep the dir from growing.
const STAGING_TTL_MS = 6 * 60 * 60 * 1000; // 6h
async function sweepStaging() {
    let removed = 0;
    try {
        for (const name of await fsp.readdir(STAGING_DIR)) {
            const fp = path.join(STAGING_DIR, name);
            try {
                const st = await fsp.stat(fp);
                if (Date.now() - st.mtimeMs > STAGING_TTL_MS) { await fsp.unlink(fp); removed++; }
            } catch { /* raced with a delete */ }
        }
    } catch { /* dir missing — recreated on next upload */ }
    if (removed) console.log(`[VIDEO] swept ${removed} stale staged file(s).`);
}

function arkErrorPayload(data, status) {
    if (data && data.error) {
        const e = data.error;
        return (typeof e === 'string') ? e : (e.message || e.code || JSON.stringify(e));
    }
    return (data && data.raw) ? data.raw : `Upstream ${status}`;
}

// Authenticated GET against the ARK tasks API, with key rotation on quota/rate/auth.
async function arkTaskGet(path) {
    let attempts = 0;
    const max = keyManager.activeCount();
    while (attempts < max) {
        const key = keyManager.getCurrentKey();
        if (!key) throw new Error('No active API keys.');
        const r = await fetch(`${WEB_API_BASE}${path}`, {
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
        });
        if (r.ok) { keyManager.recordSuccess(); return { ok: true, status: r.status, data: await r.json().catch(() => null) }; }
        if ([401, 402, 403, 429].includes(r.status)) {
            const rotated = keyManager.rotateKey({ disable: r.status === 401 });
            attempts++;
            if (!rotated) return { ok: false, status: r.status, data: { raw: await r.text().catch(() => '') } };
            continue;
        }
        return { ok: false, status: r.status, data: await r.json().catch(() => ({ raw: '' })) };
    }
    return { ok: false, status: 503, data: { raw: 'All API keys exhausted.' } };
}

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
        resolution, ratio, duration, watermark, generateAudio, seed
    } = opts;

    const content = [{ type: 'text', text }];
    const body = {
        model: model || VIDEO_MODEL,
        content,
        resolution: resolution || '1080p',
        watermark: !!watermark
    };
    const subtask = videoSubtask(mode, refVideo);

    if (subtask === 'first_last') {
        content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' });
        if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' });
        body.duration = Number(duration) || 5;
    } else if (subtask === 'edit') {
        content.push({ type: 'video_url', video_url: { url: refVideo }, role: 'reference_video' });
        if (refImage) content.push({ type: 'image_url', image_url: { url: refImage }, role: 'reference_image' });
        body.omni_reference_task_type = 'edit';
    } else {
        content.push({ type: 'image_url', image_url: { url: refImage }, role: 'reference_image' });
        body.omni_reference_task_type = 'reference';
        if (ratio) body.ratio = ratio;
        body.duration = Number(duration) || 5;
    }

    if (generateAudio !== undefined) body.generate_audio = !!generateAudio;
    if (seed) body.seed = Number(seed);
    return body;
}

app.post('/api/video/generate', videoUploadFields([
    { name: 'video', maxCount: 1 },
    { name: 'image', maxCount: 1 },
    { name: 'firstFrame', maxCount: 1 },
    { name: 'lastFrame', maxCount: 1 }
]), async (req, res) => {
    if (!videoEnabled) {
        return res.status(503).json({ success: false, error: 'No API keys configured.' });
    }
    const { userMessage, model, ratio, resolution, duration, watermark, generateAudio, seed, refVideoUrl } = req.body || {};
    // Mode defaults to 'edit' so any client that predates frame mode keeps working.
    const mode = req.body?.mode === 'firstLast' ? 'firstLast' : 'edit';
    if (!userMessage || !userMessage.trim()) {
        return res.status(400).json({
            success: false,
            error: mode === 'firstLast' ? 'A prompt is required.' : 'An edit instruction is required.'
        });
    }

    const videoFile = (req.files?.video || [])[0];
    const imageFile = (req.files?.image || [])[0];
    const firstFrameFile = (req.files?.firstFrame || [])[0];
    const lastFrameFile = (req.files?.lastFrame || [])[0];
    let refVideo = refVideoUrl?.trim() ? refVideoUrl.trim() : null;
    let refImage = null;
    let firstFrameUrl = null;
    let lastFrameUrl = null;

    // Frame content and reference media are mutually exclusive upstream ("first/last
    // frame content cannot be mixed with reference media content"), and a last frame is
    // only legal alongside a first. Catch both here so the caller gets a clear reason
    // instead of an opaque 400 from the validator.
    if (mode === 'firstLast') {
        if (!firstFrameFile) {
            return res.status(400).json({ success: false, error: 'A first frame image is required.' });
        }
        if (videoFile || refVideo || imageFile) {
            return res.status(400).json({
                success: false,
                error: 'First/last frame mode can\'t be combined with a reference video or reference image — ' +
                    'the model rejects mixing them. Clear the reference media, or switch to Edit mode.'
            });
        }
    } else if (firstFrameFile || lastFrameFile) {
        return res.status(400).json({
            success: false,
            error: 'Frame images were supplied but the request is in Edit mode. Switch to first/last frame mode.'
        });
    }

    // Uploaded files must be reachable by BytePlus, so they're staged into
    // videos/staging/ and referenced through PUBLIC_BASE_URL. Without a public base
    // URL configured there is no way to serve them, so say so plainly rather than
    // letting the request fail deep inside the upstream validator.
    const stagedPaths = [];
    const anyUpload = videoFile || imageFile || firstFrameFile || lastFrameFile;
    if (anyUpload && !uploadsAvailable()) {
        return res.status(400).json({
            success: false,
            // Frame mode has no URL escape hatch — the images are always uploads —
            // so only edit mode gets told to paste a URL instead.
            error: 'Uploads are paused while the public tunnel reconnects — BytePlus downloads ' +
                'reference media itself, so this server must be reachable. It should recover within ' +
                'a few seconds; retry shortly' +
                (mode === 'firstLast' ? '. ' : ', or paste a public video URL instead. ') +
                '(If AUTO_TUNNEL=0, set PUBLIC_BASE_URL yourself.)'
        });
    }
    try {
        if (videoFile) {
            const staged = await stageLocalFile(videoFile.buffer, videoFile.originalname, '.mp4');
            refVideo = staged.url;
            stagedPaths.push(staged.file);
        }
        if (imageFile) {
            const staged = await stageLocalFile(imageFile.buffer, imageFile.originalname, '.png');
            refImage = staged.url;
            stagedPaths.push(staged.file);
        }
        if (firstFrameFile) {
            const staged = await stageLocalFile(firstFrameFile.buffer, firstFrameFile.originalname, '.png');
            firstFrameUrl = staged.url;
            stagedPaths.push(staged.file);
        }
        if (lastFrameFile) {
            const staged = await stageLocalFile(lastFrameFile.buffer, lastFrameFile.originalname, '.png');
            lastFrameUrl = staged.url;
            stagedPaths.push(staged.file);
        }
    } catch (e) {
        console.error('[VIDEO] staging failed:', e);
        await unstageFiles(stagedPaths);
        return res.status(500).json({ success: false, error: 'Failed to stage upload: ' + e.message });
    }
    // Edit mode needs *something* to work from, but either reference will do: a clip
    // maps to the 'edit' subtask, a lone image to 'reference'.
    if (mode === 'edit' && !refVideo && !refImage) {
        await unstageFiles(stagedPaths);
        return res.status(400).json({
            success: false,
            error: 'Add a reference video (upload a clip or provide a URL) or a reference image.'
        });
    }
    // Duration is only ours to set where there's no source clip dictating it.
    if (videoSubtask(mode, refVideo) !== 'edit') {
        const d = Number(duration);
        if (duration !== undefined && duration !== '' && (!Number.isFinite(d) || d < VIDEO_DURATION_MIN || d > VIDEO_DURATION_MAX)) {
            await unstageFiles(stagedPaths);
            return res.status(400).json({
                success: false,
                error: `Duration must be between ${VIDEO_DURATION_MIN} and ${VIDEO_DURATION_MAX} seconds.`
            });
        }
    }

    const body = buildVideoTaskBody({
        mode,
        model,
        text: userMessage.trim(),
        refVideo,
        refImage,
        firstFrame: firstFrameUrl,
        lastFrame: lastFrameUrl,
        resolution,
        ratio,
        duration,
        watermark: watermark === 'true' || watermark === true,
        generateAudio: generateAudio === undefined ? undefined : (generateAudio === 'true' || generateAudio === true),
        seed
    });

    let attempts = 0;
    const maxAttempts = keyManager.activeCount();
    let lastErr = null;
    while (attempts < maxAttempts) {
        const key = keyManager.getCurrentKey();
        if (!key) break;
        try {
            const r = await fetch(`${WEB_API_BASE}/contents/generations/tasks`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (r.ok) {
                const data = await r.json().catch(() => null);
                keyManager.recordSuccess();
                const taskId = data && data.id;
                if (!taskId) {
                    await unstageFiles(stagedPaths);
                    return res.status(502).json({ success: false, error: 'No task id returned by upstream.' });
                }
                const now = new Date().toISOString();
                const record = {
                    id: taskId,
                    status: 'queued',
                    prompt: body.content[0].text,
                    model: body.model,
                    taskType: videoSubtask(mode, refVideo),
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
                    refSource: videoFile ? 'upload' : (refVideo ? 'url' : 'image'),
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
                const saveInput = async (file, suffix) => {
                    if (!file) return null;
                    const name = `${sanitizeFilename(taskId)}_${suffix}${path.extname(file.originalname) || '.png'}`;
                    await fsp.writeFile(path.join(VIDEO_DIR, name), file.buffer);
                    return `/videos/${name}`;
                };
                record.refImage = await saveInput(imageFile, 'ref');
                record.inputFirstFrame = await saveInput(firstFrameFile, 'infirst');
                record.inputLastFrame = await saveInput(lastFrameFile, 'inlast');
                await addVideoItem(record);
                return res.json({ success: true, taskId, record });
            }
            if ([401, 402, 403, 429].includes(r.status)) {
                const rotated = keyManager.rotateKey({ disable: r.status === 401 });
                attempts++;
                lastErr = await r.text().catch(() => '');
                console.error('[VIDEO] create → ARK status', r.status, '(rotating key):', lastErr);
                if (!rotated) break;
                continue;
            }
            const errBody = await r.text().catch(() => '');
            console.error('[VIDEO] create → ARK status', r.status, ':', errBody);
            let data = null; try { data = JSON.parse(errBody); } catch {}
            await unstageFiles(stagedPaths);
            return res.status(r.status).json({ success: false, error: arkErrorPayload(data, r.status), raw: errBody });
        } catch (e) {
            console.error('[VIDEO] create:', e);
            await unstageFiles(stagedPaths);
            return res.status(500).json({ success: false, error: e.message || 'Internal server error' });
        }
    }
    console.error('[VIDEO] create → all keys exhausted. last error:', lastErr);
    await unstageFiles(stagedPaths);
    res.status(503).json({ success: false, error: lastErr ? lastErr : 'All API keys exhausted.', raw: lastErr });
});

// Map ARK task statuses to our gallery record vocabulary.
function normalizeVideoStatus(s) {
    if (s === 'succeeded') return 'succeeded';
    if (s === 'failed' || s === 'cancelled') return 'failed';
    if (s === 'running') return 'running';
    return 'queued';
}

app.get('/api/video/tasks/:id', async (req, res) => {
    if (!videoEnabled) return res.status(503).json({ success: false, error: 'No API keys configured.' });
    const id = req.params.id;
    const result = await arkTaskGet(`/contents/generations/tasks/${encodeURIComponent(id)}`);
    if (!result.ok) {
        const raw = (result.data && result.data.raw) ? result.data.raw : JSON.stringify(result.data);
        console.error('[VIDEO] poll → ARK status', result.status, 'for task', id, ':', raw);
        return res.status(result.status === 503 ? 503 : 502).json({ success: false, error: arkErrorPayload(result.data, result.status), raw });
    }
    const task = result.data || {};
    const status = normalizeVideoStatus(task.status);
    const existing = await getVideoItem(id);
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
            const fp = path.join(VIDEO_DIR, `${safe}.mp4`);
            try { await downloadFile(videoUrl, fp); rec.fullVideo = `/videos/${safe}.mp4`; }
            catch (e) { console.error('[VIDEO] download:', e.message); }
        }
        if (task.content && task.content.first_frame_image_url) {
            const ff = `${safe}_first.jpg`;
            try { await downloadFile(task.content.first_frame_image_url, path.join(VIDEO_DIR, ff)); rec.firstFrame = `/videos/${ff}`; }
            catch (e) { console.error('[VIDEO] firstframe:', e.message); }
        }
        if (task.content && task.content.last_frame_image_url) {
            const lf = `${safe}_last.jpg`;
            try { await downloadFile(task.content.last_frame_image_url, path.join(VIDEO_DIR, lf)); rec.lastFrame = `/videos/${lf}`; }
            catch (e) { console.error('[VIDEO] lastframe:', e.message); }
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
        record = { ...(existing || {}), status };
        record.updatedAt = new Date().toISOString();
    }

    // When ARK marks the task failed, the real reason lives in task.error — log it
    // in full so the request id / quota / model-activation codes aren't lost.
    if (status === 'failed' && task.error) {
        console.error('[VIDEO] task', id, 'FAILED:', JSON.stringify(task.error));
        // Mirror it onto the persisted record so it shows in the gallery card too.
        record.error = task.error.message || task.error.code || JSON.stringify(task.error);
    }

    // The task is done with our staged inputs once it's terminal — drop them so
    // videos/staging/ doesn't accumulate copies of every uploaded clip.
    if ((status === 'succeeded' || status === 'failed') && record.stagedPaths?.length) {
        await unstageFiles(record.stagedPaths);
        delete record.stagedPaths;
    }

    // Persist the change in place (keeps newest-first ordering).
    const m = await readVideoManifest();
    const i = m.items.findIndex(it => it.id === id);
    if (i >= 0) m.items[i] = record; else m.items.unshift(record);
    await writeVideoManifest(m);

    res.json({ success: true, status, task, record });
});

app.get('/api/video/gallery', async (_req, res) => {
    try {
        const m = await readVideoManifest();
        res.json({ success: true, items: m.items });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/video/:id', async (req, res) => {
    try {
        const item = await getVideoItem(req.params.id);
        if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
        res.json({ success: true, item });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/video/:id', async (req, res) => {
    try {
        const removed = await removeVideoItem(req.params.id);
        if (!removed) return res.status(404).json({ success: false, error: 'Not found.' });
        const toDelete = [
            removed.fullVideo, removed.refImage,
            removed.firstFrame, removed.lastFrame,             // output keyframes
            removed.inputFirstFrame, removed.inputLastFrame    // input frames we sent
        ].filter(Boolean);
        for (const rel of toDelete) {
            const abs = path.join(ROOT, rel.replace(/^\//, ''));
            await fsp.unlink(abs).catch(() => {});
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`BytePlus Studio running on http://localhost:${PORT}`);
    console.log(`Loaded ${apiKeys.length} API key(s).`);
    if (videoEnabled) console.log('Video editing enabled (Seedance 2.5).');

    // Reclaim staged inputs orphaned by tasks that never finished polling.
    sweepStaging();
    setInterval(sweepStaging, 60 * 60 * 1000).unref();

    // Keep a public tunnel alive for the server's lifetime so local-file uploads
    // work without manual setup. Quick-tunnel hostnames rotate, so the supervisor
    // republishes the new one into publicBaseUrl (and .env) on every reconnect —
    // no restart needed. Set AUTO_TUNNEL=0 to manage PUBLIC_BASE_URL yourself.
    if (!AUTO_TUNNEL) {
        console.log(publicBaseUrl
            ? `[TUNNEL] auto-tunnel off; using PUBLIC_BASE_URL=${publicBaseUrl}`
            : '[TUNNEL] auto-tunnel off and no PUBLIC_BASE_URL — uploads disabled (pasted URLs still work).');
        return;
    }
    // The supervisor owns the address from here on. Any PUBLIC_BASE_URL left in .env is
    // a stale hostname from a previous run — trusting it would advertise a dead URL to
    // BytePlus until the tunnel comes up.
    if (publicBaseUrl) {
        console.log('[TUNNEL] ignoring stale PUBLIC_BASE_URL until the tunnel reports in.');
        publicBaseUrl = '';
    }
    tunnel = new Tunnel({
        port: PORT,
        envPath: path.join(ROOT, '.env'),
        // Set both to run your own named tunnel on a domain you control: a fixed
        // hostname, and none of the quick tunnel's throttling. Falls back to a quick
        // tunnel when either is missing.
        name: process.env.TUNNEL_NAME || null,
        hostname: process.env.TUNNEL_HOSTNAME || null
    });
    tunnel.onChange((url) => {
        publicBaseUrl = url ? url.replace(/\/+$/, '') : '';
        console.log(url
            ? `[TUNNEL] uploads enabled via ${publicBaseUrl}`
            : '[TUNNEL] uploads disabled until the tunnel reconnects.');
    });
    tunnel.start();
});

// Don't leave an orphaned cloudflared behind when the server goes away.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        tunnel?.stop();
        process.exit(0);
    });
}
