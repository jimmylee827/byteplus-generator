// File and URL inputs for the CLI and MCP surfaces (the HTTP surface receives bytes
// from multer instead). A value is either a public http(s) URL, passed through
// verbatim, or a local path that is read here.
//
// MCP callers are another program acting for the user, so their paths must be
// absolute and resolve inside AI_MEDIA_STUDIO_ALLOWED_DIRS (default: the repo and the
// home folder). Secrets are refused whatever the allow-list says: the .env file and
// the .state/ folder. The CLI is the user at their own terminal and is not restricted.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { StudioError } = require('./errors');
const { isHttpUrl, mimeFromName } = require('./files');

function realpathOrParent(p) {
    try { return fs.realpathSync(p); } catch {
        const parent = path.dirname(p);
        if (parent === p) return p;
        return path.join(realpathOrParent(parent), path.basename(p));
    }
}

const inside = (child, dir) => child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** Throws PATH_NOT_ALLOWED unless an MCP caller may touch this path. Returns the real path. */
function checkAllowedPath(ctx, p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
        throw new StudioError('PATH_NOT_ALLOWED', `Paths must be absolute: ${p}`);
    }
    const real = realpathOrParent(p);
    const { config } = ctx;
    const denied = [realpathOrParent(config.stateDir)];
    const base = path.basename(real);
    const envDir = realpathOrParent(path.dirname(config.envFile));
    if (real === realpathOrParent(config.envFile) || (base.startsWith('.env') && path.dirname(real) === envDir)) {
        throw new StudioError('PATH_NOT_ALLOWED', `Refusing to read the .env file: ${p}`);
    }
    if (denied.some(d => inside(real, d))) {
        throw new StudioError('PATH_NOT_ALLOWED', `Refusing to touch the private state folder: ${p}`);
    }
    const allowed = config.allowedDirs.map(realpathOrParent);
    if (!allowed.some(d => inside(real, d))) {
        throw new StudioError('PATH_NOT_ALLOWED',
            `Path is outside the allowed folders (${allowed.join(', ')}): ${p}. Set AI_MEDIA_STUDIO_ALLOWED_DIRS to change them.`);
    }
    return real;
}

function resolveLocal(ctx, p) {
    if (ctx.surface === 'mcp') return checkAllowedPath(ctx, p);
    return path.resolve(p);
}

async function readLocalFile(ctx, p) {
    const abs = resolveLocal(ctx, p);
    try {
        return { abs, buffer: await fsp.readFile(abs) };
    } catch (e) {
        if (e.code === 'ENOENT') throw new StudioError('VALIDATION', `File not found: ${p}`);
        if (e.code === 'EISDIR') throw new StudioError('VALIDATION', `Expected a file but got a folder: ${p}`);
        throw e;
    }
}

/** A local image/clip, or a URL when urls are allowed → the core media shape. */
async function loadMedia(ctx, value, { allowUrl = true } = {}) {
    if (value === undefined || value === null || value === '') return null;
    if (isHttpUrl(value)) {
        if (!allowUrl) throw new StudioError('VALIDATION', `Expected a local file, not a URL: ${value}`);
        return { url: value.trim() };
    }
    const { abs, buffer } = await readLocalFile(ctx, value);
    return { buffer, originalname: path.basename(abs), mimetype: mimeFromName(abs) };
}

async function readTextFile(ctx, p) {
    return (await readLocalFile(ctx, p)).buffer.toString('utf-8');
}

/** An output folder (image generate --out). */
function resolveOutDir(ctx, p) {
    if (!p) return null;
    return resolveLocal(ctx, p);
}

module.exports = { loadMedia, readTextFile, resolveOutDir, checkAllowedPath };
