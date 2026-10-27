// --- KEY ROTATION MANAGER ---
// Rotates BYTEPLUS_API_KEYS: hot-swaps after 200 successful uses, rotates on
// 401/402/403/429, and disables a key on 401.
//
// The state lives in .state/keys.json, not in memory, because the server, the CLI and
// the MCP server may all be calling BytePlus at once. Keys are identified by a hash,
// never stored. The current key is remembered by hash too, so reordering .env keeps
// pointing at the same key. What resets it:
//   - a key removed from BYTEPLUS_API_KEYS is dropped from the state on the next write;
//   - `ai-media-studio keys reset` clears everything (uses, disabled flags, position).
// A key disabled by a 401 therefore stays disabled until one of those happens.
//
// Rotation acts on the key that was actually used, and only moves the shared position
// if that key is still current — two processes that both hit a 429 on the same key
// rotate once, not twice.
const crypto = require('crypto');
const fs = require('fs');
const { withLock } = require('./stores/lock');
const { readJson, writeJsonAtomic } = require('./stores/json');
const { mask } = require('./config');

const SWAP_AFTER_USES = 200;
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);

class KeyManager {
    constructor(keys, { stateFile, locksDir, log = console }) {
        this.keys = keys;
        this.hashes = keys.map(hashKey);
        this.stateFile = stateFile;
        this.locksDir = locksDir;
        this.log = log;
    }

    async _load() {
        let s = null;
        if (fs.existsSync(this.stateFile)) {
            try { s = await readJson(this.stateFile); } catch { s = null; }
        }
        const prev = (s && s.keys) || {};
        const keys = {};
        for (const h of this.hashes) keys[h] = { uses: 0, disabled: false, ...(prev[h] || {}) };
        let index = s ? this.hashes.indexOf(s.currentKeyHash) : -1;
        if (index < 0) index = 0;
        return { keys, index };
    }

    async _save({ keys, index }) {
        await writeJsonAtomic(this.stateFile, { version: 1, currentKeyHash: this.hashes[index] || null, keys });
    }

    _tx(fn) {
        return withLock(this.locksDir, 'keys', async () => {
            const st = await this._load();
            const out = await fn(st);
            await this._save(st);
            return out;
        });
    }

    /** The key to use now, skipping disabled ones; null when every key is disabled. */
    async acquire() {
        if (this.keys.length === 0) return null;
        return this._tx(st => {
            const start = st.index;
            while (st.keys[this.hashes[st.index]].disabled) {
                st.index = (st.index + 1) % this.keys.length;
                if (st.index === start) return null;
            }
            return { key: this.keys[st.index], hash: this.hashes[st.index] };
        });
    }

    async recordSuccess(hash) {
        return this._tx(st => {
            const k = st.keys[hash];
            if (!k) return;
            k.uses += 1;
            const i = this.hashes.indexOf(hash);
            this.log.log(`[KEY] index=${i} uses=${k.uses}`);
            if (k.uses >= SWAP_AFTER_USES && st.index === i) {
                this.log.log('[KEY] Hit 200 uses, hot-swapping.');
                this._advance(st);
            }
        });
    }

    /**
     * After a rejection: optionally disable the key, then move on if it's still current.
     * Returns whether another key is worth trying (false once rotation wraps round).
     */
    async rotate(hash, { disable = false, status } = {}) {
        return this._tx(st => {
            const k = st.keys[hash];
            if (k) {
                if (disable) { k.disabled = true; k.disabledAt = new Date().toISOString(); }
                if (status) k.lastStatus = status;
            }
            const i = this.hashes.indexOf(hash);
            if (st.index !== i) {
                // Another caller already moved on; worth retrying if anything is usable.
                return this.hashes.some(h => !st.keys[h].disabled);
            }
            return this._advance(st);
        });
    }

    _advance(st) {
        const start = st.index;
        do {
            st.index = (st.index + 1) % this.keys.length;
            if (st.index === start) return false;
        } while (st.keys[this.hashes[st.index]].disabled);
        this.log.log(`[KEY] Rotated to index=${st.index}`);
        return true;
    }

    async activeCount() {
        if (this.keys.length === 0) return 0;
        const st = await this._load();
        return this.hashes.filter(h => !st.keys[h].disabled).length;
    }

    /** Masked per-key view for `keys status`. Never includes a key. */
    async status() {
        const st = await this._load();
        return {
            current: this.keys.length ? st.index : null,
            keys: this.hashes.map((h, i) => ({
                index: i,
                key: mask(this.keys[i]),
                uses: st.keys[h].uses,
                disabled: st.keys[h].disabled,
                ...(st.keys[h].disabledAt ? { disabledAt: st.keys[h].disabledAt } : {}),
                ...(st.keys[h].lastStatus ? { lastStatus: st.keys[h].lastStatus } : {})
            }))
        };
    }

    async reset() {
        return withLock(this.locksDir, 'keys', async () => {
            await fs.promises.rm(this.stateFile, { force: true });
        });
    }
}

module.exports = { KeyManager, hashKey, SWAP_AFTER_USES };
