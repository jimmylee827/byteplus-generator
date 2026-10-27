// Runs the CLI as a separate process with the same mocked fetch and env as the test
// servers, against a given data folder.
const { spawn } = require('child_process');
const path = require('path');
const { TEST_ENV, REPO } = require('./server');

const BIN = path.join(REPO, 'cli', 'ai-media-studio.js');
const MOCK = path.join(__dirname, 'mock-fetch.js');

function runCli(args, { dataDir, mockDir, env = {}, stdin } = {}) {
    return new Promise((resolve) => {
        const childEnv = {
            ...process.env,
            ...TEST_ENV,
            AI_MEDIA_STUDIO_DATA_DIR: dataDir,
            AI_MEDIA_STUDIO_ENV_FILE: path.join(dataDir, '.env'),
            MOCK_FETCH_DIR: mockDir,
            NODE_OPTIONS: `--require ${MOCK}`,
            ...env
        };
        for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
        const p = spawn(process.execPath, [BIN, ...args], { cwd: dataDir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', d => { stdout += d; });
        p.stderr.on('data', d => { stderr += d; });
        if (stdin !== undefined) p.stdin.end(stdin); else p.stdin.end();
        p.on('exit', (code) => {
            let json;
            try { json = JSON.parse(stdout); } catch { json = undefined; }
            resolve({ code, stdout, stderr, json });
        });
    });
}

module.exports = { runCli };
