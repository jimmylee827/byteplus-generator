// Local image utilities — no BytePlus calls, nothing billed. They replace the ad-hoc
// Pillow/sharp scripts callers wrote around generated images:
//   trim     crop away a plain background (the colour of the top-left pixel)
//   tile     lay images out in a grid with no gaps (e.g. a character sheet)
//   compare  a labelled side-by-side sheet for human review
// Layout belongs in code, not in a prompt: the models overlap and mislabel multi-view
// sheets they are asked to draw themselves.
//
// Needs the optional `sharp` dependency.
const fs = require('fs');
const path = require('path');
const { StudioError } = require('./errors');

function sharpOrFail() {
    try { return require('sharp'); } catch {
        throw new StudioError('CONFIG', 'Image utilities need the optional "sharp" package: run `npm install sharp`.');
    }
}

function ensureInput(p) {
    if (!fs.existsSync(p)) throw new StudioError('VALIDATION', `File not found: ${p}`);
    return p;
}

function encodeFor(img, out) {
    const ext = path.extname(out).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return img.jpeg({ quality: 92 });
    if (ext === '.webp') return img.webp({ quality: 92 });
    if (ext === '.png') return img.png();
    throw new StudioError('VALIDATION', `Output must end in .png, .jpg, .jpeg or .webp: ${out}`);
}

const parseCell = (s) => {
    const m = /^(\d+)x(\d+)$/.exec(String(s || ''));
    if (!m) throw new StudioError('USAGE', `Expected WIDTHxHEIGHT, got "${s}".`);
    return { width: Number(m[1]), height: Number(m[2]) };
};

/** Crop a plain border. out defaults to "<name>-trim<ext>" beside the input. */
// --- trim ---
// "Plain background" in practice means a studio backdrop with gradients, soft shadows
// and vignetting, not one flat colour: sharp's own trim (one corner colour + tolerance)
// finds nothing to cut on real photos. So trim looks for the SUBJECT: strong edges,
// per row and per column, on a downscaled grey copy. Broad shadows and wall gradients
// have soft edges and don't count; the empty margin around the subject does.
//   threshold   Sobel gradient magnitude a pixel needs to count as an edge (0–255)
//   minContent  % of a row/column that must be edges for it to hold content
//   margin      % of the long edge kept as breathing room around the subject
const ANALYSIS_MAX_SIDE = 700;

function edgeCounts(grey, W, H, threshold) {
    const at = (x, y) => grey[y * W + x];
    const rows = new Uint32Array(H);
    const cols = new Uint32Array(W);
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
                - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
            const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
                - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
            if (Math.hypot(gx, gy) / 4 > threshold) { rows[y]++; cols[x]++; }
        }
    }
    return { rows, cols };
}

/**
 * Where the subject starts and ends, in the analysed image's pixels. Each axis is
 * measured on its own: a subject that runs off the top and bottom still gets its
 * left/right margins trimmed (and vice versa). Null only when there is content in
 * neither axis, i.e. nothing to separate from the background.
 */
function contentBox({ rows, cols }, W, H, minContentPct) {
    const rowLimit = Math.max(3, Math.floor(W * minContentPct / 100));
    const colLimit = Math.max(3, Math.floor(H * minContentPct / 100));
    let top = 0, bottom = H - 1, left = 0, right = W - 1;
    while (top <= bottom && rows[top] < rowLimit) top++;
    while (bottom >= top && rows[bottom] < rowLimit) bottom--;
    const rowsFound = top <= bottom;
    while (left <= right && cols[left] < colLimit) left++;
    while (right >= left && cols[right] < colLimit) right--;
    const colsFound = left <= right;
    if (!rowsFound && !colsFound) return null;
    if (!rowsFound) { top = 0; bottom = H - 1; }
    if (!colsFound) { left = 0; right = W - 1; }
    return { left, top, right, bottom };
}

/** The subject's box from alpha, for cut-outs; null when the image isn't transparent at the edges. */
async function alphaBox(sharp, input) {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: W, height: H, channels: C } = info;
    const alphaAt = (x, y) => data[(y * W + x) * C + 3];
    const opaque = (x, y) => alphaAt(x, y) > 8;
    const edges = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].some(([x, y]) => !opaque(x, y));
    if (!edges) return null;
    let left = W, right = -1, top = H, bottom = -1;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!opaque(x, y)) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
    }
    return right >= left && bottom >= top ? { left, top, right, bottom } : null;
}

async function trimImage({ input, out, threshold = 16, margin = 1.5, minContent = 4, pad = 0, background: bgHex = null }) {
    const sharp = sharpOrFail();
    ensureInput(input);
    const dest = out || path.join(path.dirname(input), `${path.parse(input).name}-trim${path.extname(input)}`);
    const meta = await sharp(input).metadata();
    const { width: W, height: H } = meta;

    let box = meta.hasAlpha ? await alphaBox(sharp, input) : null;
    if (!box) {
        const scale = Math.min(1, ANALYSIS_MAX_SIDE / Math.max(W, H));
        const w = Math.max(1, Math.round(W * scale));
        const h = Math.max(1, Math.round(H * scale));
        const { data, info } = await sharp(input).removeAlpha().resize(w, h, { fit: 'fill' })
            .greyscale().blur(0.8).raw().toBuffer({ resolveWithObject: true });
        const found = contentBox(edgeCounts(data, info.width, info.height, Number(threshold)), info.width, info.height, Number(minContent));
        if (found) {
            const sx = W / info.width, sy = H / info.height;
            box = {
                left: Math.floor(found.left * sx), top: Math.floor(found.top * sy),
                right: Math.ceil((found.right + 1) * sx) - 1, bottom: Math.ceil((found.bottom + 1) * sy) - 1
            };
        }
    }

    const nothingToDo = !box || (box.left <= 0 && box.top <= 0 && box.right >= W - 1 && box.bottom >= H - 1);
    if (nothingToDo) {
        // Nothing found (or content touches every edge): copy through, and say so.
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        const res = await encodeFor(sharp(input), dest).toFile(dest);
        return {
            success: true, input, output: dest, width: res.width, height: res.height,
            unchanged: true, reason: box ? 'content reaches every edge' : 'no background could be separated from the subject',
            trimmed: { left: 0, top: 0, right: 0, bottom: 0 }
        };
    }

    const m = Math.round(Number(margin) / 100 * Math.max(W, H));
    const crop = {
        left: Math.max(0, box.left - m), top: Math.max(0, box.top - m),
        right: Math.min(W - 1, box.right + m), bottom: Math.min(H - 1, box.bottom + m)
    };
    const width = crop.right - crop.left + 1;
    const height = crop.bottom - crop.top + 1;

    let img = sharp(await sharp(input).extract({ left: crop.left, top: crop.top, width, height }).toBuffer());
    const padPx = Number(pad);
    if (padPx > 0) {
        let background = bgHex;
        if (!background) {
            const { data } = await sharp(input).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
            background = { r: data[0], g: data[1], b: data[2], alpha: 1 };
        }
        img = img.extend({ top: padPx, bottom: padPx, left: padPx, right: padPx, background });
    }
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const res = await encodeFor(img, dest).toFile(dest);
    return {
        success: true, input, output: dest, width: res.width, height: res.height,
        trimmed: {
            left: crop.left, top: crop.top,
            right: W - 1 - crop.right, bottom: H - 1 - crop.bottom
        },
        source: { width: W, height: H }
    };
}

/** Images in a grid, cells touching. Each image is fitted into the cell size. */
async function tileImages({ inputs, out, columns, cell, fit = 'contain', background = '#ffffff' }) {
    const sharp = sharpOrFail();
    if (!inputs || inputs.length < 1) throw new StudioError('USAGE', 'Give at least one image to tile.');
    if (!out) throw new StudioError('USAGE', 'Give --out for the tiled image.');
    if (!['contain', 'cover'].includes(fit)) throw new StudioError('USAGE', '--fit must be contain or cover.');
    inputs.forEach(ensureInput);
    const cols = Number(columns) || inputs.length;
    if (!Number.isInteger(cols) || cols < 1) throw new StudioError('USAGE', '--columns must be a whole number of at least 1.');
    const size = cell ? parseCell(cell) : await sharp(inputs[0]).metadata().then(m => ({ width: m.width, height: m.height }));
    const rows = Math.ceil(inputs.length / cols);
    const tiles = await Promise.all(inputs.map(p => sharp(p).resize({ ...size, fit, background }).toBuffer()));
    const canvas = sharp({ create: { width: size.width * cols, height: size.height * rows, channels: 4, background } })
        .composite(tiles.map((input, i) => ({ input, left: (i % cols) * size.width, top: Math.floor(i / cols) * size.height })));
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    const res = await encodeFor(canvas, out).toFile(out);
    return { success: true, output: out, width: res.width, height: res.height, columns: cols, rows, cell: size, count: inputs.length };
}

const escapeXml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** A review sheet: each image scaled to the same height, labelled underneath. */
async function compareImages({ inputs, out, labels, height = 640, columns }) {
    const sharp = sharpOrFail();
    if (!inputs || inputs.length < 2) throw new StudioError('USAGE', 'Give at least two images to compare.');
    if (!out) throw new StudioError('USAGE', 'Give --out for the comparison sheet.');
    inputs.forEach(ensureInput);
    if (labels && labels.length && labels.length !== inputs.length) {
        throw new StudioError('USAGE', `Give one --label per image (${inputs.length}), or none.`);
    }
    const h = Number(height);
    const gap = 16;
    const labelH = 44;
    const cols = Number(columns) || inputs.length;
    const scaled = await Promise.all(inputs.map(p => sharp(p).resize({ height: h }).toBuffer({ resolveWithObject: true })));
    const cellW = Math.max(...scaled.map(s => s.info.width));
    const rows = Math.ceil(inputs.length / cols);
    const W = cols * cellW + (cols + 1) * gap;
    const H = rows * (h + labelH) + (rows + 1) * gap;
    const parts = [];
    scaled.forEach((s, i) => {
        const x = gap + (i % cols) * (cellW + gap);
        const y = gap + Math.floor(i / cols) * (h + labelH + gap);
        parts.push({ input: s.data, left: x + Math.floor((cellW - s.info.width) / 2), top: y });
        const text = escapeXml((labels && labels[i]) || path.basename(inputs[i]));
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${labelH}">` +
            `<text x="${cellW / 2}" y="${labelH / 2 + 8}" font-family="Helvetica, Arial, sans-serif" font-size="22" text-anchor="middle" fill="#111">${text}</text></svg>`;
        parts.push({ input: Buffer.from(svg), left: x, top: y + h });
    });
    const sheet = sharp({ create: { width: W, height: H, channels: 4, background: '#ffffff' } }).composite(parts);
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    const res = await encodeFor(sheet, out).toFile(out);
    return { success: true, output: out, width: res.width, height: res.height, count: inputs.length };
}

module.exports = { trimImage, tileImages, compareImages };
