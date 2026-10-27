// `image batch`: run a file of image-generate jobs with a concurrency limit, a spend
// cap and resume. Each job is exactly an `image generate` input (plus an optional
// `id`), so a batch can do nothing a single command can't.
//
// Jobs file: .json is one document (an array of jobs, or { "defaults": {…}, "jobs": [ … ] });
// any other name is JSON Lines (one job per line; blank lines and # comments skipped).
// Relative paths in a job (images, promptFile, out) are relative to the jobs file.
//
// Progress lives in "<jobs file>.status.json". A job recorded there as done is never
// paid for twice: re-running needs --resume (skip what is done) or --restart.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StudioError } = require('./errors');
const { withLock } = require('./stores/lock');
const { writeJsonAtomic } = require('./stores/json');

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const PATH_FIELDS = ['promptFile', 'out'];

function parseJobsFile(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch (e) {
        throw new StudioError('VALIDATION', e.code === 'ENOENT' ? `Jobs file not found: ${file}` : e.message);
    }
    let jobs;
    let defaults = {};
    if (!/\.json$/i.test(file)) {
        jobs = [];
        raw.split('\n').forEach((line, i) => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return;
            try { jobs.push({ ...JSON.parse(t), _line: i + 1 }); } catch (e) {
                throw new StudioError('VALIDATION', `Jobs file line ${i + 1} is not valid JSON: ${e.message}`);
            }
        });
    } else {
        let doc;
        try { doc = JSON.parse(raw); } catch (e) { throw new StudioError('VALIDATION', `Jobs file is not valid JSON: ${e.message}`); }
        jobs = Array.isArray(doc) ? doc : doc.jobs;
        defaults = (!Array.isArray(doc) && doc.defaults) || {};
        if (!Array.isArray(jobs)) throw new StudioError('VALIDATION', 'A .json jobs file must be an array of jobs or { "jobs": [...] }.');
    }
    if (!jobs.length) throw new StudioError('VALIDATION', 'The jobs file has no jobs.');
    return { jobs, defaults };
}

/** Jobs with ids, defaults applied and paths made absolute. */
function normalizeJobs(file, { jobs, defaults }, { validate, tags = [] }) {
    const base = path.dirname(path.resolve(file));
    const abs = (p) => (typeof p === 'string' && !/^https?:\/\//i.test(p) && !path.isAbsolute(p) ? path.resolve(base, p) : p);
    const seen = new Set();
    return jobs.map((j, i) => {
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new StudioError('VALIDATION', `Job ${i + 1} must be an object.`);
        const { id: givenId, _line, ...rest } = j;
        const id = givenId !== undefined ? String(givenId) : `job-${i + 1}`;
        if (seen.has(id)) throw new StudioError('VALIDATION', `Duplicate job id "${id}".`);
        seen.add(id);
        const job = { ...defaults, ...rest };
        for (const k of PATH_FIELDS) if (job[k] !== undefined) job[k] = abs(job[k]);
        if (Array.isArray(job.images)) {
            job.images = job.images.map(v => {
                const m = /^([A-Za-z][\w-]*)=(.+)$/.exec(String(v));
                return m ? `${m[1]}=${abs(m[2])}` : abs(v);
            });
        }
        const allTags = [...new Set([...(job.tags || []), ...tags])];
        if (allTags.length) job.tags = allTags;
        job.meta = { ...(job.meta || {}), batch: path.basename(file), job: id };
        try {
            validate(job);
        } catch (e) {
            throw new StudioError(e.code || 'VALIDATION', `Job "${id}"${_line ? ` (line ${_line})` : ''}: ${e.message}`);
        }
        return { id, job };
    });
}

function statusPath(file) { return `${path.resolve(file)}.status.json`; }

function readStatus(file) {
    try { return JSON.parse(fs.readFileSync(statusPath(file), 'utf-8')); } catch { return null; }
}

const round = (n) => Math.round(n * 100000) / 100000;
const spentIn = (status) => round(Object.values((status && status.jobs) || {}).reduce((s, j) => s + (j.state === 'done' && j.cost ? j.cost.usd : 0), 0));
const isImageFile = (p) => typeof p === 'string' && /\.(jpe?g|png|webp)$/i.test(p);

/**
 * @param ctx
 * @param {{ file: string, concurrency?: number, maxSpend?: number, resume?: boolean, restart?: boolean,
 *           tags?: string[], dryRun?: boolean }} opts
 * @param {{ validate: (job) => void, estimate: (job) => Promise<object>, generate: (job) => Promise<object>,
 *           onJob?: (line) => void }} hooks  how to check, price and run one job (the image.generate operation)
 */
async function runBatch(ctx, opts, hooks) {
    const file = path.resolve(opts.file);
    const concurrency = opts.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(opts.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
        throw new StudioError('USAGE', `--concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}.`);
    }
    const maxSpend = opts.maxSpend === undefined || opts.maxSpend === null ? null : Number(opts.maxSpend);
    if (maxSpend !== null && (!Number.isFinite(maxSpend) || maxSpend < 0)) throw new StudioError('USAGE', '--max-spend must be a number of US dollars.');
    if (opts.resume && opts.restart) throw new StudioError('USAGE', 'Give --resume or --restart, not both.');

    const jobs = normalizeJobs(file, parseJobsFile(file), { validate: hooks.validate, tags: opts.tags || [] });

    // Price every job up front: a bad job fails the whole batch before anything is spent.
    const estimates = new Map();
    for (const { id, job } of jobs) {
        try {
            estimates.set(id, (await hooks.estimate(job)).estimatedCost || null);
        } catch (e) {
            throw new StudioError(e.code || 'VALIDATION', `Job "${id}": ${e.message}`);
        }
    }

    if (opts.dryRun) {
        const priced = [...estimates.values()].filter(Boolean);
        const total = round(priced.reduce((s, c) => s + c.usd, 0));
        return {
            success: true,
            dryRun: true,
            file,
            total: jobs.length,
            estimatedSpendUsd: total,
            unpriced: jobs.length - priced.length,
            withinMaxSpend: maxSpend === null ? null : total <= maxSpend && priced.length === jobs.length,
            jobs: jobs.map(({ id, job }) => ({ id, model: job.model || 'endpoint', estimatedCost: estimates.get(id) }))
        };
    }

    const statusFile = statusPath(file);
    const lockName = `batch-${crypto.createHash('sha1').update(statusFile).digest('hex').slice(0, 12)}`;
    let status = readStatus(file);
    if (status && Object.keys(status.jobs || {}).length && !opts.resume && !opts.restart) {
        throw new StudioError('USAGE',
            `${path.basename(statusFile)} already records ${Object.keys(status.jobs).length} job(s). ` +
            'Pass --resume to skip the finished ones, or --restart to run every job again (and pay again).');
    }
    if (!status || opts.restart) status = { version: 1, file, jobs: {} };
    const previousSpend = spentIn(status);
    const save = () => withLock(ctx.config.locksDir, lockName, () => {
        status.updatedAt = new Date().toISOString();
        return writeJsonAtomic(statusFile, status);
    });

    let spent = 0;           // this run
    let reserved = 0;        // estimates of jobs in flight
    let stopReason = null;   // once set, no new job starts
    const results = [];
    const emit = (line) => { results.push(line); if (hooks.onJob) hooks.onJob(line); };

    const runOne = async ({ id, job }) => {
        const prev = status.jobs[id];
        if (opts.resume && prev && prev.state === 'done') {
            return emit({ id, state: 'skipped', reason: 'already done', galleryIds: prev.galleryIds, cost: prev.cost });
        }
        if (opts.resume && isImageFile(job.out) && fs.existsSync(job.out)) {
            return emit({ id, state: 'skipped', reason: 'output exists', output: job.out });
        }
        if (stopReason) return emit({ id, state: 'skipped', reason: stopReason });
        const est = estimates.get(id);
        if (maxSpend !== null) {
            if (!est) return emit({ id, state: 'skipped', reason: 'no known price, so --max-spend cannot be checked' });
            if (previousSpend + spent + reserved + est.usd > maxSpend + 1e-9) {
                stopReason = `max-spend US$${maxSpend} reached`;
                return emit({ id, state: 'skipped', reason: stopReason });
            }
        }
        reserved += est ? est.usd : 0;
        status.jobs[id] = { state: 'running', startedAt: new Date().toISOString() };
        await save();
        try {
            const r = await hooks.generate(job);
            const records = r.items || [r.item];
            const line = {
                id,
                state: 'done',
                galleryIds: records.map(x => x.id),
                outputs: records.map(x => (x.paths ? x.paths.output : x.outputPath)),
                ...(r.copiedTo ? { copiedTo: r.copiedTo } : {}),
                cost: r.cost || null
            };
            if (r.cost) spent = round(spent + r.cost.usd);
            status.jobs[id] = { ...line, finishedAt: new Date().toISOString() };
            await save();
            emit(line);
        } catch (e) {
            if (e.code === 'KEYS_EXHAUSTED') stopReason = 'all API keys exhausted';
            const line = { id, state: 'failed', error: e.message, code: e.code || 'INTERNAL' };
            status.jobs[id] = { ...line, finishedAt: new Date().toISOString() };
            await save();
            emit(line);
        } finally {
            reserved = round(reserved - (est ? est.usd : 0));
        }
    };

    // A fixed pool working through the jobs in file order.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (next < jobs.length) await runOne(jobs[next++]);
    }));

    const count = (state, pred = () => true) => results.filter(r => r.state === state && pred(r)).length;
    const summary = {
        success: true,
        file,
        statusFile,
        total: jobs.length,
        done: count('done'),
        failed: count('failed'),
        skipped: count('skipped'),
        alreadyDone: count('skipped', r => r.reason === 'already done' || r.reason === 'output exists'),
        spendUsd: spent,
        totalSpendUsd: round(previousSpend + spent),
        maxSpendUsd: maxSpend,
        results: [...results].sort((a, b) => jobs.findIndex(j => j.id === a.id) - jobs.findIndex(j => j.id === b.id))
    };
    const incomplete = summary.failed + (summary.skipped - summary.alreadyDone);
    if (incomplete) {
        throw new StudioError('BATCH_INCOMPLETE',
            `${incomplete} of ${jobs.length} job(s) did not finish (${summary.failed} failed, ${summary.skipped - summary.alreadyDone} skipped). ` +
            'Fix what failed, then run again with --resume.',
            { extra: { summary } });
    }
    return summary;
}

module.exports = { runBatch, parseJobsFile, normalizeJobs, statusPath, DEFAULT_CONCURRENCY };
