// JSON files shared between processes: atomic replace (temp file + rename, so a reader
// never sees a half-written file) and read-modify-write under a lock, so two writers
// can't lose each other's changes. Formatting stays JSON.stringify(x, null, 2) — the
// same bytes the server always wrote.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { withLock } = require('./lock');

async function readJson(file) {
    return JSON.parse(await fsp.readFile(file, 'utf-8'));
}

async function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
    try {
        await fsp.rename(tmp, file);
    } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        throw e;
    }
}

/** Create the file with `initial` if it doesn't exist yet (never overwrites). */
function ensureJsonFile(file, initial) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
        try { fs.writeFileSync(file, JSON.stringify(initial, null, 2), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
}

/**
 * A lock-guarded JSON document.
 *   read()        → current contents
 *   mutate(fn)    → fn(fresh contents) may change it in place and returns a value;
 *                   the file is rewritten and the value returned
 */
function jsonDocument({ file, locksDir, lockName, initial }) {
    let ensured = false;
    const ensure = () => { if (!ensured) { ensureJsonFile(file, initial); ensured = true; } };
    return {
        file,
        async read() { ensure(); return readJson(file); },
        async mutate(fn, lockOpts) {
            ensure();
            return withLock(locksDir, lockName, async () => {
                const doc = await readJson(file);
                const result = await fn(doc);
                await writeJsonAtomic(file, doc);
                return result;
            }, lockOpts);
        }
    };
}

module.exports = { jsonDocument, readJson, writeJsonAtomic, ensureJsonFile };
