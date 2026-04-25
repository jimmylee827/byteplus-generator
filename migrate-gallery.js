// One-shot migration: rename gallery files from UUID to YYYYMMDD_HHmmss_sss[_N].
// Run with: node migrate-gallery.js
const fs = require('fs');
const path = require('path');

const GALLERY_DIR = path.join(__dirname, 'gallery');
const MANIFEST_PATH = path.join(GALLERY_DIR, 'manifest.json');

function pad(n, len = 2) { return String(n).padStart(len, '0'); }
function formatTimestamp(date) {
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

function main() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const used = new Set();
    const renames = []; // [{from, to}]

    // Process oldest first so collision suffixes are stable & monotonic
    const items = manifest.items
        .slice()
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    for (const item of items) {
        const oldId = item.id;
        const date = new Date(item.createdAt);
        const base = formatTimestamp(date);
        let newId = base;
        let n = 2;
        while (used.has(newId)) {
            newId = `${base}_${n++}`;
        }
        used.add(newId);

        if (newId === oldId) continue; // already migrated

        // Rename output file
        const oldOut = path.join(GALLERY_DIR, `${oldId}.jpeg`);
        const newOut = path.join(GALLERY_DIR, `${newId}.jpeg`);
        if (fs.existsSync(oldOut)) {
            renames.push({ from: oldOut, to: newOut });
        }

        // Rename input thumbs (preserve extension)
        const newInputThumbs = [];
        for (const rel of item.inputThumbs || []) {
            const oldName = path.basename(rel);
            // oldName looks like `<oldId>_in_<i>.<ext>`
            if (!oldName.startsWith(oldId + '_in_')) {
                newInputThumbs.push(rel); // unknown shape, leave as-is
                continue;
            }
            const tail = oldName.slice(oldId.length); // `_in_<i>.<ext>`
            const newName = newId + tail;
            renames.push({
                from: path.join(GALLERY_DIR, oldName),
                to: path.join(GALLERY_DIR, newName)
            });
            newInputThumbs.push(`/gallery/${newName}`);
        }

        item.id = newId;
        item.outputPath = `/gallery/${newId}.jpeg`;
        item.inputThumbs = newInputThumbs;
    }

    // Sanity: ensure no destination already exists (would clobber)
    for (const r of renames) {
        if (fs.existsSync(r.to)) {
            throw new Error(`Refusing to clobber: ${r.to}`);
        }
    }

    // Apply renames
    let count = 0;
    for (const r of renames) {
        if (!fs.existsSync(r.from)) {
            console.warn(`[skip] missing source: ${r.from}`);
            continue;
        }
        fs.renameSync(r.from, r.to);
        count++;
    }

    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`Migrated ${items.length} items, renamed ${count} file(s).`);
}

main();
