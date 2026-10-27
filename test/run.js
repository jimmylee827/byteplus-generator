// `npm test`: runs every *.test.js with node:test, then proves the real user data was
// not touched — the manifests' checksums must match before and after the run.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const GUARDED = ['gallery/manifest.json', 'videos/manifest.json', 'prompts/library.json'];

function snapshot() {
    return GUARDED.map(rel => {
        const p = path.join(REPO, rel);
        return fs.existsSync(p) ? `${rel}:${crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')}` : `${rel}:absent`;
    });
}

const before = snapshot();
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), 'test/**/*.test.js'], { cwd: REPO, stdio: 'inherit' });
const after = snapshot();
const changed = after.filter((s, i) => s !== before[i]);
if (changed.length) {
    console.error(`\nUSER DATA CHANGED during the test run: ${changed.join(', ')}`);
    process.exit(1);
}
process.exit(r.status ?? 1);
