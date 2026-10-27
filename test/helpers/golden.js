// Golden upstream requests. Recorded once from the legacy code (UPDATE_GOLDENS=1 with
// TEST_TARGET=legacy) and compared byte-for-byte afterwards: the body string must equal
// JSON.stringify of the recorded body, so key order counts as well as values.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'fixtures', 'upstream');

// Staged upload names carry Date.now() and a random suffix; everything else is stable.
function normalizeRaw(raw) {
    return raw && raw.replace(/(\/videos\/staging\/)\d+_[0-9a-f]{8}(\.[A-Za-z0-9]+)/g, '$1<staged>$2');
}

function expectUpstream(name, entry) {
    assert.ok(entry, `no upstream request recorded for golden "${name}"`);
    const file = path.join(DIR, `${name}.json`);
    const actual = {
        method: entry.method,
        url: entry.url,
        keyIndex: entry.keyIndex,
        body: entry.raw === null ? null : JSON.parse(normalizeRaw(entry.raw))
    };
    if (process.env.UPDATE_GOLDENS === '1') {
        if (process.env.TEST_TARGET !== 'legacy') {
            throw new Error('Goldens may only be recorded from the legacy code (TEST_TARGET=legacy).');
        }
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
        return;
    }
    assert.ok(fs.existsSync(file), `golden "${name}" missing; record it with UPDATE_GOLDENS=1 TEST_TARGET=legacy`);
    const golden = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(actual.method, golden.method, `${name}: method`);
    assert.equal(actual.url, golden.url, `${name}: url`);
    assert.equal(actual.keyIndex, golden.keyIndex, `${name}: key index`);
    assert.equal(
        golden.body === null ? null : normalizeRaw(entry.raw),
        golden.body === null ? null : JSON.stringify(golden.body),
        `${name}: request body differs from the legacy golden`
    );
}

module.exports = { expectUpstream, normalizeRaw };
