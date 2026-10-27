// A small JPEG preview of a generated image, so an MCP caller can see what it made.
// `sharp` is an optional dependency: without it (or for a file it can't decode) the
// caller simply gets no preview — the absolute path to the full image is always there.
const PREVIEW_MAX_EDGE = 1024;

let sharp;
function loadSharp() {
    if (sharp === undefined) {
        try { sharp = require('sharp'); } catch { sharp = null; }
    }
    return sharp;
}

/** → { data: base64, mimeType } or null */
async function imagePreview(file) {
    const s = loadSharp();
    if (!s) return null;
    try {
        const buf = await s(file)
            .rotate()
            .resize({ width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
        return { data: buf.toString('base64'), mimeType: 'image/jpeg' };
    } catch {
        return null;
    }
}

module.exports = { imagePreview, PREVIEW_MAX_EDGE };
