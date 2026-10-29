#!/usr/bin/env node
// ai-media-studio: the command-line core of BytePlus Studio. Parses arguments, runs one
// operation from core/operations.js, prints the result. No decisions are made here.
const readline = require('readline');
const { parseCommand, helpFor, mainHelp } = require('./args');
const { formatResult } = require('./format');
const { asStudioError, errorEnvelope, StudioError } = require('../core/errors');

const VERSION = require('../package.json').version;

const stderrLog = { log: (...a) => console.error(...a), error: (...a) => console.error(...a) };
const quietLog = { log() {}, error() {} };

async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf-8');
}

// "-" means stdin: for --prompt / --body / --text directly, and for any *File flag
// (whose text then stands in for the inline value).
async function resolveStdin(input) {
    let used = false;
    const take = async () => {
        if (used) throw new StudioError('USAGE', 'Only one option can read from stdin ("-").');
        used = true;
        return readStdin();
    };
    for (const k of ['prompt', 'body', 'text']) if (input[k] === '-') input[k] = await take();
    for (const k of Object.keys(input)) {
        if (k.endsWith('File') && input[k] === '-') {
            input[k.slice(0, -4)] = await take();
            delete input[k];
        }
    }
}

async function confirm(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise(r => rl.question(`${question} [y/N] `, r));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
}

function print(globals, opName, result) {
    if (globals.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stdout.write(formatResult(opName, result) + '\n');
}

function fail(globals, err) {
    const e = asStudioError(err);
    if (globals.json) process.stdout.write(JSON.stringify(errorEnvelope(e), null, 2) + '\n');
    else process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = e.exitCode;
}

async function runLongRunning(op, input, globals) {
    const log = console; // a foreground service: its log is the output
    if (op.name === 'serve') {
        const { getConfig } = require('../core/config');
        const config = getConfig();
        if (!config.endpointId || config.apiKeys.length === 0) {
            throw new StudioError('CONFIG', 'Missing ENDPOINT_ID or BYTEPLUS_API_KEYS in .env file.');
        }
        await require('../server/serve').run({ port: input.port, log });
        return;
    }
    if (op.name === 'tunnel.up') {
        // runTunnelUp points the tunnel at whatever already serves videos/staging (this
        // app's server, if running) or starts a staging-only listener on a free port.
        // 3000 is never required.
        await require('../server/serve').runTunnelUp({ port: input.port, log });
        return;
    }
    if (op.name === 'mcp') {
        await require('../mcp/server').start();
        return;
    }
    void globals;
}

async function main(argv) {
    // Known before parsing, so even a parse error is reported in the requested format.
    let globals = { json: argv.includes('--json') };
    try {
        const parsed = parseCommand(argv);
        globals = parsed.globals || {};
        if (!parsed.op) {
            if (globals.version) { process.stdout.write(VERSION + '\n'); return; }
            if (globals.help || !parsed.words || !parsed.words.length) { process.stdout.write(mainHelp(VERSION) + '\n'); return; }
            throw new StudioError('USAGE', `Unknown command "${parsed.words.join(' ')}". Run \`ai-media-studio --help\`.`);
        }
        const { op, input } = parsed;
        if (globals.help) { process.stdout.write(helpFor(op) + '\n'); return; }
        if (op.longRunning) { await runLongRunning(op, input, globals); return; }

        await resolveStdin(input);
        if (op.hints && op.hints.destructive && !op.selfConfirm && !globals.yes) {
            if (!process.stdin.isTTY) {
                throw new StudioError('USAGE', `Refusing to ${op.name.replace('.', ' ')} without --yes (stdin is not a terminal).`);
            }
            const target = input.id ? ` ${input.id}` : '';
            if (!(await confirm(`${op.summary} Proceed with ${op.name.replace('.', ' ')}${target}?`))) {
                throw new StudioError('USAGE', 'Cancelled.');
            }
        }

        const { createContext } = require('../core/context');
        const { runOperation } = require('../core/operations');
        const ctx = createContext({ surface: 'cli', log: globals.verbose ? stderrLog : quietLog });
        // Progress always goes to stderr (stdout carries only the result) — except with
        // `image batch --jsonl`, whose stdout is one JSON line per job, then the summary.
        const jsonl = Boolean(input.jsonl);
        delete input.jsonl;
        const lastStatus = new Map();
        const io = {
            onJob: (line) => {
                if (jsonl) process.stdout.write(JSON.stringify(line) + '\n');
                else process.stderr.write(`${line.id}: ${line.state}${line.cost ? ` US$${line.cost.usd}` : ''}${line.reason ? ` (${line.reason})` : ''}${line.error ? ` — ${line.error}` : ''}\n`);
            },
            onProgress: (r) => {
                const id = r.record && r.record.id;
                if (lastStatus.get(id) === r.status) return;
                lastStatus.set(id, r.status);
                process.stderr.write(`${id}: ${r.status}\n`);
            }
        };
        let result;
        try {
            result = await runOperation(ctx, op.name, input, io);
        } catch (err) {
            if (jsonl) {
                process.stdout.write(JSON.stringify(errorEnvelope(err)) + '\n');
                process.exitCode = asStudioError(err).exitCode;
                return;
            }
            throw err;
        }
        if (jsonl) process.stdout.write(JSON.stringify(result) + '\n');
        else print(globals, op.name, result);
    } catch (err) {
        fail(globals, err);
    }
}

main(process.argv.slice(2));
