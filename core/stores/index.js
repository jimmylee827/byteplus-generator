// The three user-data manifests. Item order is newest first, as the UI expects, and
// existing items are never reordered: adds unshift, updates replace in place.
const { jsonDocument } = require('./json');

function listStore(doc) {
    return {
        async list() { return (await doc.read()).items; },
        async get(id) { return (await doc.read()).items.find(i => i.id === id) || null; },
        async add(item) { return doc.mutate(m => { m.items.unshift(item); return item; }); },
        async remove(id) {
            return doc.mutate(m => {
                const idx = m.items.findIndex(i => i.id === id);
                if (idx === -1) return null;
                const [removed] = m.items.splice(idx, 1);
                return removed;
            });
        },
        /** fn(existing|null, items) → new record, or undefined to leave the file alone. */
        async upsert(id, fn) {
            return doc.mutate(async m => {
                const i = m.items.findIndex(it => it.id === id);
                const next = await fn(i >= 0 ? m.items[i] : null, m.items);
                if (next === undefined) return i >= 0 ? m.items[i] : null;
                if (i >= 0) m.items[i] = next; else m.items.unshift(next);
                return next;
            });
        },
        mutate: (fn) => doc.mutate(fn)
    };
}

function createStores(config) {
    const mk = (file, lockName) => listStore(jsonDocument({ file, locksDir: config.locksDir, lockName, initial: { items: [] } }));
    return {
        gallery: mk(config.galleryManifest, 'gallery-manifest'),
        videos: mk(config.videoManifest, 'videos-manifest'),
        prompts: mk(config.promptsFile, 'prompts-library')
    };
}

module.exports = { createStores };
