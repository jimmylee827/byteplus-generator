// Small file helpers shared by image and video code.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

async function downloadBuffer(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
}

// On Windows a rename fails with EPERM/EACCES/EBUSY while another process holds the
// file open without delete sharing — typically antivirus or the search indexer
// scanning a file we just wrote. The hold is brief, so retry (as graceful-fs does).
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function renameRetry(from, to, { timeoutMs = 10000 } = {}) {
    const start = Date.now();
    for (let delay = 10; ; delay = Math.min(delay * 2, 500)) {
        try {
            return await fsp.rename(from, to);
        } catch (e) {
            if (process.platform !== 'win32' || !RENAME_RETRY_CODES.has(e.code) || Date.now() - start >= timeoutMs) throw e;
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

/** Write via temp file + rename, so a concurrent reader never sees a partial file. */
async function writeFileAtomic(dest, buf) {
    const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, buf);
    await renameRetry(tmp, dest);
}

async function downloadFile(url, destPath) {
    const buf = await downloadBuffer(url);
    await writeFileAtomic(destPath, buf);
    return buf.length;
}

// Gallery files are named by what the bytes are, not by what was requested. Anything
// unrecognised keeps the historical .jpeg name.
function detectImageExt(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    return 'jpeg';
}

const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.heic': 'image/heic', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.m4v': 'video/x-m4v'
};
/** Best guess from a filename, as a browser would report it; null when unknown. */
function mimeFromName(name) {
    return MIME_BY_EXT[path.extname(name || '').toLowerCase()] || null;
}

function isHttpUrl(s) {
    return typeof s === 'string' && /^https?:\/\//i.test(s.trim());
}

module.exports = { downloadBuffer, downloadFile, writeFileAtomic, renameRetry, detectImageExt, mimeFromName, isHttpUrl };
