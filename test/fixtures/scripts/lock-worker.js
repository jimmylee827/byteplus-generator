// Child process for lock tests: increments a shared counter N times under the lock.
// A lost update (two processes reading the same value) shows up as a short total.
const fs = require('fs');
const path = require('path');
const { withLock } = require('../../../core/stores/lock');

const [dir, times] = process.argv.slice(2);
const counter = path.join(dir, 'counter.txt');
(async () => {
    for (let i = 0; i < Number(times); i++) {
        await withLock(path.join(dir, 'locks'), 'counter', async () => {
            const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf-8') : 0);
            await new Promise(r => setImmediate(r));
            fs.writeFileSync(counter, String(n + 1));
        });
    }
})();
