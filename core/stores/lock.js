// Cross-process mutual exclusion with plain lock files, so the server, the CLI and the
// MCP server can share one data folder. A lock is a file created with O_EXCL holding
// the owner's pid; a holder that died (pid gone) or overstayed `staleMs` is broken.
// Within one process an in-memory queue serialises callers first, so a process never
// contends with itself.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { StudioError } = require('../errors');

const queues = new Map(); // lock path → tail promise

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function acquireFile(file, { timeoutMs, staleMs }) {
    const token = crypto.randomUUID();
    const deadline = Date.now() + timeoutMs;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    for (;;) {
        try {
            const fh = await fsp.open(file, 'wx');
            await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token }));
            await fh.close();
            return token;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
        }
        let holder = null;
        try { holder = JSON.parse(await fsp.readFile(file, 'utf-8')); } catch { /* being written or just released */ }
        if (holder && (!pidAlive(holder.pid) || Date.now() - holder.at > staleMs)) {
            // Only remove the exact lock we judged stale, not a fresh one that replaced it.
            try {
                const again = JSON.parse(await fsp.readFile(file, 'utf-8'));
                if (again.token === holder.token) await fsp.unlink(file);
            } catch { /* someone else broke it first */ }
            continue;
        }
        if (Date.now() > deadline) {
            throw new StudioError('INTERNAL', `Timed out waiting for lock ${path.basename(file)}.`);
        }
        await sleep(5 + Math.random() * 20);
    }
}

async function releaseFile(file, token) {
    try {
        const holder = JSON.parse(await fsp.readFile(file, 'utf-8'));
        if (holder.token === token) await fsp.unlink(file);
    } catch { /* already gone */ }
}

/**
 * Run fn while holding lock `name` (a file under locksDir).
 * @param {string} locksDir
 * @param {string} name
 * @param {() => Promise<any>} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [opts]
 */
async function withLock(locksDir, name, fn, { timeoutMs = 10000, staleMs = 30000 } = {}) {
    const file = path.join(locksDir, `${name.replace(/[^A-Za-z0-9_.-]/g, '_')}.lock`);
    const prev = queues.get(file) || Promise.resolve();
    let release;
    const mine = new Promise(r => { release = r; });
    const tail = prev.then(() => mine);
    queues.set(file, tail);
    await prev;
    try {
        const token = await acquireFile(file, { timeoutMs, staleMs });
        try {
            return await fn();
        } finally {
            await releaseFile(file, token);
        }
    } finally {
        release();
        if (queues.get(file) === tail) queues.delete(file);
    }
}

module.exports = { withLock, pidAlive };
