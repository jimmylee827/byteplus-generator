// Prompt library: versioned prompts. Every body change appends a version; restoring
// copies an old version forward as a new one, so history is never rewritten.
const { randomUUID } = require('crypto');
const { StudioError } = require('./errors');
const { parseSlots, compileView } = require('./slots');

function summarizePrompt(p) {
    const cur = p.versions.find(v => v.version === p.currentVersion) || p.versions[p.versions.length - 1];
    return {
        id: p.id,
        title: p.title,
        body: cur ? cur.body : '',
        currentVersion: p.currentVersion,
        versionCount: p.versions.length,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    };
}

const notFound = () => new StudioError('NOT_FOUND', 'Not found.');
const isBlank = (s) => typeof s !== 'string' || !s.trim();

async function listPrompts(ctx, { search } = {}) {
    let items = (await ctx.stores.prompts.list()).map(summarizePrompt);
    const q = (search || '').trim().toLowerCase();
    if (q) items = items.filter(it => it.title.toLowerCase().includes(q) || it.body.toLowerCase().includes(q));
    return { success: true, items };
}

async function getPrompt(ctx, id) {
    const item = await ctx.stores.prompts.get(id);
    if (!item) throw notFound();
    return { success: true, item };
}

async function createPrompt(ctx, { title, body } = {}) {
    if (!title || !title.trim()) throw new StudioError('VALIDATION', 'Title is required.');
    if (isBlank(body)) throw new StudioError('VALIDATION', 'Body is required.');
    const now = new Date().toISOString();
    const item = {
        id: randomUUID(),
        title: title.trim(),
        currentVersion: 1,
        versions: [{ version: 1, body, createdAt: now }],
        createdAt: now,
        updatedAt: now
    };
    await ctx.stores.prompts.mutate(p => { p.items.unshift(item); });
    return { success: true, item: summarizePrompt(item) };
}

async function updatePrompt(ctx, id, { title, body } = {}) {
    if (typeof body === 'string' && isBlank(body)) throw new StudioError('VALIDATION', 'Body is required.');
    const item = await ctx.stores.prompts.mutate(p => {
        const item = p.items.find(i => i.id === id);
        if (!item) return null;

        const now = new Date().toISOString();
        let bumped = false;
        if (typeof title === 'string' && title.trim() && title.trim() !== item.title) {
            item.title = title.trim();
            bumped = true;
        }
        if (typeof body === 'string') {
            const cur = item.versions.find(v => v.version === item.currentVersion);
            if (!cur || cur.body !== body) {
                const newVer = item.currentVersion + 1;
                item.versions.push({ version: newVer, body, createdAt: now });
                item.currentVersion = newVer;
                bumped = true;
            }
        }
        if (bumped) item.updatedAt = now;
        return item;
    });
    if (!item) throw notFound();
    return { success: true, item: summarizePrompt(item) };
}

async function restorePrompt(ctx, id, version) {
    const ver = parseInt(version, 10);
    let problem = null;
    const item = await ctx.stores.prompts.mutate(p => {
        const item = p.items.find(i => i.id === id);
        if (!item) { problem = notFound(); return null; }
        const target = item.versions.find(v => v.version === ver);
        if (!target) { problem = new StudioError('NOT_FOUND', 'Version not found.'); return null; }
        if (ver === item.currentVersion) { problem = new StudioError('VALIDATION', 'That is already the current version.'); return null; }

        const now = new Date().toISOString();
        const newVer = item.currentVersion + 1;
        item.versions.push({ version: newVer, body: target.body, createdAt: now, restoredFrom: ver });
        item.currentVersion = newVer;
        item.updatedAt = now;
        return item;
    });
    if (problem) throw problem;
    return { success: true, item: summarizePrompt(item) };
}

async function deletePrompt(ctx, id) {
    const removed = await ctx.stores.prompts.remove(id);
    if (!removed) throw notFound();
    return { success: true };
}

/** A template to work on: inline text, or the current body of a saved prompt. */
async function resolveTemplate(ctx, { id, text }) {
    if (typeof text === 'string') return text;
    if (id) return summarizePrompt((await getPrompt(ctx, id)).item).body;
    throw new StudioError('USAGE', 'Give a prompt id or --text.');
}

async function promptSlots(ctx, { id, text }) {
    const template = await resolveTemplate(ctx, { id, text });
    const { order, defaults } = parseSlots(template);
    return { success: true, slots: order.map(name => ({ name, default: defaults[name] })) };
}

async function compilePromptTemplate(ctx, { id, text, values }) {
    const template = await resolveTemplate(ctx, { id, text });
    return { success: true, ...compileView(template, values || {}) };
}

module.exports = {
    summarizePrompt, listPrompts, getPrompt, createPrompt, updatePrompt, restorePrompt, deletePrompt,
    promptSlots, compilePromptTemplate, resolveTemplate
};
