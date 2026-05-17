require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');

// --- CONFIGURATION ---
const ENDPOINT_ID = process.env.ENDPOINT_ID;
const PORT = process.env.PORT || 3000;
const API_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations';

const apiKeys = (process.env.BYTEPLUS_API_KEYS || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

if (!ENDPOINT_ID || apiKeys.length === 0) {
    console.error('ERROR: Missing ENDPOINT_ID or BYTEPLUS_API_KEYS in .env file.');
    process.exit(1);
}

// --- PATHS ---
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const GALLERY_DIR = path.join(ROOT, 'gallery');
const MANIFEST_PATH = path.join(GALLERY_DIR, 'manifest.json');
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const PROMPTS_PATH = path.join(PROMPTS_DIR, 'library.json');

if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });
if (!fs.existsSync(MANIFEST_PATH)) fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ items: [] }, null, 2));
if (!fs.existsSync(PROMPTS_DIR)) fs.mkdirSync(PROMPTS_DIR, { recursive: true });
if (!fs.existsSync(PROMPTS_PATH)) fs.writeFileSync(PROMPTS_PATH, JSON.stringify({ items: [] }, null, 2));

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

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 9 } // 10MB, max 9
});

// --- HELPERS ---
function bufferToDataUri(buffer, mimetype) {
    const mime = (mimetype || 'image/png').toLowerCase();
    return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function downloadImage(url, destPath) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await fsp.writeFile(destPath, buf);
    return buf.length;
}

// --- ROUTES ---
app.get('/api/health', (_req, res) => {
    res.json({ ok: true, activeKeys: keyManager.activeCount(), totalKeys: apiKeys.length });
});

app.post('/api/generate', upload.array('images', 9), async (req, res) => {
    const { prompt, size, watermark } = req.body || {};
    if (!prompt || !prompt.trim()) {
        return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    // Build base64 data URIs from uploaded files
    const inputImages = (req.files || []).map(f => bufferToDataUri(f.buffer, f.mimetype));

    const body = {
        model: ENDPOINT_ID,
        prompt: prompt.trim(),
        sequential_image_generation: 'disabled',
        response_format: 'url',
        size: size || '4K',
        stream: false,
        watermark: watermark === 'true' || watermark === true
    };
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
                    await downloadImage(item.url, filePath);
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
            return res.status(response.status).json({ success: false, error: errText });

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

app.listen(PORT, () => {
    console.log(`Seedream Studio running on http://localhost:${PORT}`);
    console.log(`Loaded ${apiKeys.length} API key(s).`);
});
