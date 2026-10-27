// Turns argv into { op, input, globals } using the operation table — every flag comes
// from an operation's JSON Schema, so the CLI and the MCP tools accept the same inputs.
const { parseArgs } = require('node:util');
const { OPERATIONS } = require('../core/operations');
const { StudioError } = require('../core/errors');

const kebab = (s) => s.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const GLOBAL_OPTIONS = {
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    verbose: { type: 'boolean', short: 'v' },
    yes: { type: 'boolean', short: 'y' },
    version: { type: 'boolean' }
};

/** The operation named by the leading words of argv (longest match), and the rest. */
function findOperation(argv) {
    const words = [];
    for (const a of argv) { if (a.startsWith('-')) break; words.push(a); }
    for (let n = Math.min(words.length, 3); n > 0; n--) {
        const name = words.slice(0, n).join('.');
        const op = OPERATIONS.find(o => o.name === name);
        if (op) return { op, rest: argv.slice(n) };
    }
    return { op: null, rest: argv, words };
}

/** The flags an operation takes, as { property, flag, schema } entries. */
function flagsFor(op) {
    const out = [];
    for (const [prop, schema] of Object.entries(op.input.properties || {})) {
        const cli = schema.cli || {};
        if (cli.positional) continue;
        out.push({ prop, flag: cli.flag || kebab(prop), schema, cli });
    }
    return out;
}

function positionalsFor(op) {
    return Object.entries(op.input.properties || {}).filter(([, s]) => s.cli && s.cli.positional).map(([prop, schema]) => ({ prop, schema }));
}

function coerce(prop, schema, value) {
    if (schema.type === 'integer' || schema.type === 'number') {
        const n = Number(value);
        if (value === '' || !Number.isFinite(n) || (schema.type === 'integer' && !Number.isInteger(n))) {
            throw new StudioError('USAGE', `--${kebab(prop)} must be a ${schema.type === 'integer' ? 'whole ' : ''}number, got "${value}".`);
        }
        return n;
    }
    if (schema.enum && !schema.enum.includes(value)) {
        throw new StudioError('USAGE', `--${kebab(prop)} must be one of ${schema.enum.join(', ')}; got "${value}".`);
    }
    return value;
}

function parseCommand(argv) {
    const { op, rest, words } = findOperation(argv);
    if (!op) {
        const g = parseArgs({ args: argv, options: GLOBAL_OPTIONS, allowPositionals: true, strict: false });
        return { op: null, words, globals: g.values };
    }
    const options = { ...GLOBAL_OPTIONS };
    const flags = flagsFor(op);
    for (const f of flags) {
        const isBool = f.schema.type === 'boolean';
        options[f.flag] = { type: isBool ? 'boolean' : 'string' };
        if (f.cli.short) options[f.flag].short = f.cli.short;
        if (f.cli.multiple || f.schema.type === 'array') options[f.flag].multiple = true;
        if (isBool && f.cli.negatable) options[`no-${f.flag}`] = { type: 'boolean' };
    }
    let parsed;
    try {
        parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
    } catch (e) {
        throw new StudioError('USAGE', e.message.replace(/\. To specify a positional argument.*$/s, '.'));
    }
    const { values, positionals } = parsed;
    const globals = {};
    for (const k of Object.keys(GLOBAL_OPTIONS)) if (values[k] !== undefined) globals[k] = values[k];

    const input = {};
    for (const f of flags) {
        let v = values[f.flag];
        if (f.schema.type === 'boolean' && f.cli.negatable && values[`no-${f.flag}`]) v = false;
        if (v === undefined) continue;
        if (f.cli.kv) {
            const o = {};
            for (const pair of v) {
                const i = pair.indexOf('=');
                if (i <= 0) throw new StudioError('USAGE', `--${f.flag} expects name=value, got "${pair}".`);
                o[pair.slice(0, i)] = pair.slice(i + 1);
            }
            v = o;
        } else if (Array.isArray(v)) {
            v = v.map(x => coerce(f.prop, f.schema.items || {}, x));
        } else if (f.schema.type !== 'boolean') {
            v = coerce(f.prop, f.schema, v);
        }
        input[f.prop] = v;
    }
    const pos = positionalsFor(op);
    if (positionals.length > pos.length) {
        throw new StudioError('USAGE', `Unexpected argument "${positionals[pos.length]}". See \`ai-media-studio ${op.name.replace(/\./g, ' ')} --help\`.`);
    }
    pos.forEach((p, i) => { if (positionals[i] !== undefined) input[p.prop] = coerce(p.prop, p.schema, positionals[i]); });
    if (!globals.help) {
        for (const req of op.input.required || []) {
            if (input[req] === undefined) {
                const isPos = pos.some(p => p.prop === req);
                throw new StudioError('USAGE', isPos
                    ? `Missing ${req.toUpperCase()}. Usage: ${usageLine(op)}`
                    : `Missing --${kebab(req)}. Usage: ${usageLine(op)}`);
            }
        }
    }
    return { op, input, globals };
}

function usageLine(op) {
    const pos = positionalsFor(op).map(p => ((op.input.required || []).includes(p.prop) ? p.prop.toUpperCase() : `[${p.prop.toUpperCase()}]`));
    return ['ai-media-studio', ...op.name.split('.'), ...pos, flagsFor(op).length ? '[options]' : ''].filter(Boolean).join(' ');
}

function helpFor(op) {
    const lines = [usageLine(op), '', op.summary, ''];
    const pos = positionalsFor(op);
    if (pos.length) {
        lines.push('Arguments:');
        for (const p of pos) lines.push(`  ${p.prop.toUpperCase().padEnd(22)} ${p.schema.description || ''}`);
        lines.push('');
    }
    const flags = flagsFor(op);
    if (flags.length) {
        lines.push('Options:');
        for (const f of flags) {
            const name = `${f.cli.short ? `-${f.cli.short}, ` : ''}--${f.flag}${f.schema.type === 'boolean' ? '' : f.cli.kv ? ' NAME=VALUE' : ' VALUE'}${f.cli.multiple || f.schema.type === 'array' ? ' …' : ''}`;
            lines.push(`  ${name.padEnd(28)} ${f.schema.description || ''}${f.cli.negatable ? ` (--no-${f.flag} to turn off)` : ''}`);
        }
        lines.push('');
    }
    lines.push('Global: --json (one JSON document on stdout), --verbose, --yes (skip confirmation), --help');
    return lines.join('\n');
}

function mainHelp(version) {
    const groups = {};
    for (const op of OPERATIONS) {
        const g = op.name.includes('.') ? op.name.split('.')[0] : 'general';
        (groups[g] = groups[g] || []).push(op);
    }
    const lines = [
        `ai-media-studio ${version} — Seedream images and Seedance video on BytePlus ModelArk`,
        '',
        'Usage: ai-media-studio <command> [arguments] [options]',
        ''
    ];
    for (const [g, ops] of Object.entries(groups)) {
        lines.push(g === 'general' ? 'Commands:' : `${g}:`);
        for (const op of ops) lines.push(`  ${op.name.replace(/\./g, ' ').padEnd(18)} ${op.summary.replace(/^BILLED: each call is a paid BytePlus generation\. /, '[billed] ')}`);
        lines.push('');
    }
    lines.push('Every command takes --json. Exit codes: 0 ok, 1 other error, 2 usage/validation,');
    lines.push('3 upstream rejected or task failed, 4 all keys exhausted, 5 not found,');
    lines.push('6 uploads unavailable (no public URL), 7 wait timed out.');
    lines.push('Run `ai-media-studio <command> --help` for its options.');
    return lines.join('\n');
}

module.exports = { parseCommand, helpFor, mainHelp, usageLine, kebab };
