// Preloaded into the server under test (NODE_OPTIONS=--require …). Replaces global
// fetch so no request ever reaches BytePlus: ARK calls and the mock CDN are answered
// here, everything is recorded, and the test process steers responses through files
// in MOCK_FETCH_DIR (the server is a separate process, so files are the channel).
//
//   rules.json  [{ match, response }]  first rule whose `match` is a substring of
//               "METHOD URL" is consumed; otherwise a default answer is used.
//   log.jsonl   one line per intercepted request: { method, url, keyIndex, raw }
//   state.json  counters for generated ids
//
// response: { status, json?, text?, bytes?: 'jpeg'|'png'|'webp'|'mp4', base64?, networkError?: true }
const fs = require('fs');
const path = require('path');

const DIR = process.env.MOCK_FETCH_DIR;
if (!DIR) throw new Error('mock-fetch: MOCK_FETCH_DIR is not set');

const ARK_HOST = 'https://ark.ap-southeast.bytepluses.com';
const CDN_HOST = 'https://mock.cdn';
const realFetch = globalThis.fetch;

const BYTES = {
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    webp: Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'binary'),
    mp4: Buffer.from('\x00\x00\x00\x18ftypmp42MOCKVIDEO', 'binary')
};

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf-8')); } catch { return fallback; }
}
function writeJson(file, value) {
    const p = path.join(DIR, file);
    fs.writeFileSync(p + '.tmp', JSON.stringify(value));
    fs.renameSync(p + '.tmp', p);
}
function nextCounter(name) {
    const s = readJson('state.json', {});
    s[name] = (s[name] || 0) + 1;
    writeJson('state.json', s);
    return s[name];
}

const keys = (process.env.BYTEPLUS_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
function keyIndexOf(headers) {
    const auth = headers && (headers.Authorization || headers.authorization);
    if (!auth) return null;
    const i = keys.indexOf(String(auth).replace(/^Bearer\s+/, ''));
    return i >= 0 ? i : 'unknown';
}

function takeRule(signature) {
    const rules = readJson('rules.json', []);
    const i = rules.findIndex(r => signature.includes(r.match));
    if (i < 0) return null;
    const [rule] = rules.splice(i, 1);
    writeJson('rules.json', rules);
    return rule.response;
}

function respond(spec) {
    if (spec.networkError) throw new TypeError('fetch failed (mock network error)');
    const status = spec.status || 200;
    if (spec.base64) {
        return new Response(Buffer.from(spec.base64, 'base64'), { status, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (spec.bytes) {
        return new Response(BYTES[spec.bytes], { status, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (spec.json !== undefined) {
        return new Response(JSON.stringify(spec.json), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(spec.text || '', { status });
}

function defaultResponse(method, url) {
    if (url.startsWith(CDN_HOST)) {
        const ext = path.extname(new URL(url).pathname).slice(1);
        return { status: 200, bytes: ext === 'png' ? 'png' : ext === 'mp4' ? 'mp4' : ext === 'webp' ? 'webp' : 'jpeg' };
    }
    if (method === 'POST' && url.endsWith('/images/generations')) {
        return { status: 200, json: { data: [{ url: `${CDN_HOST}/img/${nextCounter('img')}.jpeg` }] } };
    }
    if (method === 'POST' && url.endsWith('/contents/generations/tasks')) {
        return { status: 200, json: { id: `cgt-mock-${nextCounter('task')}` } };
    }
    if (method === 'GET' && url.includes('/contents/generations/tasks/')) {
        return { status: 200, json: { id: decodeURIComponent(url.split('/').pop()), status: 'running' } };
    }
    return { status: 599, text: `mock-fetch: no default for ${method} ${url}` };
}

globalThis.fetch = async function mockFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(ARK_HOST) && !url.startsWith(CDN_HOST)) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const raw = typeof init.body === 'string' ? init.body : null;
    fs.appendFileSync(path.join(DIR, 'log.jsonl'),
        JSON.stringify({ method, url, keyIndex: keyIndexOf(init.headers), raw }) + '\n');
    const spec = takeRule(`${method} ${url}`) || defaultResponse(method, url);
    return respond(spec);
};
