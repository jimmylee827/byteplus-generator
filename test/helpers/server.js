// Starts a server under test in its own temp data dir (or a shared one, to test several
// processes on one data folder), with fetch mocked.
//
// target 'legacy'  — the pre-refactor code, read straight from git at BASELINE and run
//                    from a temp copy (its ROOT is __dirname, so the copy's folders are
//                    the only ones it can touch). Used to record and re-check goldens.
// target 'current' — this working tree, pointed at a temp AI_MEDIA_STUDIO_DATA_DIR.
//
// Either way the real gallery/, videos/ and prompts/ are never read or written.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const REPO = path.resolve(__dirname, '..', '..');
const BASELINE = '880d429';
const MOCK = path.join(__dirname, 'mock-fetch.js');

const TEST_ENV = {
    ENDPOINT_ID: 'ep-test-endpoint-0001',
    BYTEPLUS_API_KEYS: 'key-aaaa1111,key-bbbb2222,key-cccc3333',
    PUBLIC_BASE_URL: 'https://public.example.test',
    AUTO_TUNNEL: '0',
    VIDEO_UPLOAD_LIMIT_MB: '1'
};

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

function makeTmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function extractBaseline(dir) {
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', BASELINE], { cwd: REPO, encoding: 'utf-8' })
        .split('\n')
        .filter(f => f === 'server.js' || f === 'tunnel.js' || f.startsWith('public/'));
    for (const f of files) {
        const dest = path.join(dir, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, execFileSync('git', ['show', `${BASELINE}:${f}`], { cwd: REPO }));
    }
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
}

function createMockControl(dir, { reset = true } = {}) {
    if (reset || !fs.existsSync(path.join(dir, 'rules.json'))) {
        fs.writeFileSync(path.join(dir, 'rules.json'), '[]');
        fs.writeFileSync(path.join(dir, 'log.jsonl'), '');
    }
    return {
        dir,
        /** Queue scripted responses; each is consumed by the first matching request. */
        rules(list) {
            const cur = JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf-8'));
            fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(cur.concat(list)));
        },
        log() {
            return fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf-8')
                .split('\n').filter(Boolean).map(l => JSON.parse(l));
        },
        /** Requests that went to BytePlus (not the mock CDN). */
        ark() { return this.log().filter(r => r.url.startsWith('https://ark.')); },
        clear() {
            fs.writeFileSync(path.join(dir, 'log.jsonl'), '');
            fs.writeFileSync(path.join(dir, 'rules.json'), '[]');
        }
    };
}

async function waitForHealth(url, proc, output) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}):\n${output()}`);
        try {
            const r = await fetch(`${url}/api/health`);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`server did not become healthy:\n${output()}`);
}

async function startServer({ env = {}, target = process.env.TEST_TARGET || 'current', dataDir: sharedDataDir, mockDir: sharedMockDir } = {}) {
    const port = await freePort();
    const mockDir = sharedMockDir || makeTmp('ams-mock-');
    let cwd, dataDir, script;
    if (target === 'legacy') {
        cwd = dataDir = makeTmp('ams-legacy-');
        extractBaseline(cwd);
        script = path.join(cwd, 'server.js');
    } else {
        dataDir = sharedDataDir || makeTmp('ams-data-');
        cwd = dataDir; // no .env here, so dotenv loads nothing
        script = path.join(REPO, 'server.js');
    }
    const childEnv = {
        ...process.env,
        ...TEST_ENV,
        PORT: String(port),
        AI_MEDIA_STUDIO_DATA_DIR: dataDir,
        // Never let the server under test read the real .env.
        AI_MEDIA_STUDIO_ENV_FILE: path.join(dataDir, '.env'),
        MOCK_FETCH_DIR: mockDir,
        NODE_OPTIONS: `--require ${MOCK}`,
        ...env
    };
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    const proc = spawn(process.execPath, [script], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url, proc, () => out);
    return {
        url,
        port,
        dataDir,
        target,
        mockDir,
        mock: createMockControl(mockDir, { reset: !sharedMockDir }),
        output: () => out,
        async stop() {
            if (proc.exitCode !== null) return;
            await new Promise(resolve => { proc.once('exit', resolve); proc.kill('SIGTERM'); });
        }
    };
}

// Fields the refactor added to responses. Characterisation tests compare the legacy
// shape, so `call` strips these from `body` and keeps the untouched response in `full`.
const ADDED_TOP = ['code', 'terminal', 'failureReason', 'nextPollMs', 'pendingIds', 'retryable'];
function legacyView(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const out = { ...body };
    for (const k of ADDED_TOP) delete out[k];
    const strip = (r) => { if (r && typeof r === 'object') { const c = { ...r }; delete c.paths; return c; } return r; };
    if (out.item) out.item = strip(out.item);
    if (out.record) out.record = strip(out.record);
    if (Array.isArray(out.items)) out.items = out.items.map(strip);
    return out;
}

/** Small client: json body, multipart form ({field: string | {name, type, bytes}} or arrays), or nothing. */
async function call(server, method, route, { json, form } = {}) {
    const init = { method };
    if (json !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(json);
    } else if (form) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(form)) {
            for (const item of Array.isArray(v) ? v : [v]) {
                if (item && typeof item === 'object') fd.append(k, new Blob([item.bytes], { type: item.type }), item.name);
                else fd.append(k, item);
            }
        }
        init.body = fd;
    }
    const r = await fetch(server.url + route, init);
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body: legacyView(body), full: body };
}

// Deterministic fake uploads.
const FILES = {
    png: (name = 'ref.png') => ({ name, type: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) }),
    jpeg: (name = 'ref.jpg') => ({ name, type: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]) }),
    mp4: (name = 'clip.mp4', size = 64) => ({ name, type: 'video/mp4', bytes: Buffer.alloc(size, 7) })
};

module.exports = { startServer, call, FILES, TEST_ENV, REPO, BASELINE, makeTmp, legacyView };
