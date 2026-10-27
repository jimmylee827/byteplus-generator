// Human-readable output for each command. Only presentation lives here: the --json
// output is the result object itself.
const money = (c) => (c ? `US$${c.usd}` : 'unknown (no price for this model)');
const trunc = (s, n) => { s = String(s ?? ''); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function yamlish(value, indent = '') {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        if (value.every(v => v === null || typeof v !== 'object')) return value.join(', ');
        return '\n' + value.map(v => `${indent}- ${yamlish(v, indent + '  ').replace(/^\n\s*/, '')}`).join('\n');
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (!keys.length) return '{}';
        return '\n' + keys.map(k => `${indent}${k}: ${yamlish(value[k], indent + '  ')}`).join('\n');
    }
    return String(value);
}
const generic = (r) => {
    const { success, ...rest } = r;
    void success;
    return yamlish(rest).replace(/^\n/, '');
};

const imageLine = (it) => `${it.id}  ${trunc(it.size || it.requestedSize, 10).padEnd(10)}  ${trunc(oneLine(it.prompt), 70)}`;
const videoLine = (it) => `${it.id}  ${String(it.status).padEnd(9)}  ${String(it.taskType || '').padEnd(10)}  ${trunc(oneLine(it.prompt), 60)}`;
const videoResult = (r) => {
    const rec = r.record || {};
    const file = rec.paths && rec.paths.fullVideo;
    const lines = [`${rec.id}  ${r.status || rec.status}`];
    if (file) lines.push(file);
    if (r.failureReason) lines.push(`failed: ${r.failureReason}`);
    return lines.join('\n');
};

const FORMATTERS = {
    health: (r) => [
        `keys      ${r.activeKeys}/${r.totalKeys} active`,
        `video     ${r.videoEnabled ? 'enabled' : 'disabled (no API keys)'}`,
        `uploads   ${r.videoUploadsEnabled ? `via ${r.publicBaseUrl}` : 'unavailable — no public URL (pasted URLs still work)'}`
    ].join('\n'),
    size: (r) => r.size,
    'image.generate': (r) => {
        if (r.dryRun) return [JSON.stringify(r.request, null, 2), `estimated cost ${money(r.estimatedCost)}`].join('\n');
        const made = r.items || [r.item];
        return [
            ...made.map(it => it.paths.output),
            `${made.length > 1 ? `group ${r.groupId} · ${made.length} of ${r.requested} images` : `id ${r.item.id} · ${r.item.size}`} · cost ${money(r.cost)}` +
                `${r.copiedTo ? ` · copied to ${[].concat(r.copiedTo).join(', ')}` : ''}`,
            ...(r.failures || []).map(f => `image ${f.index + 1} failed: ${f.error}`)
        ].join('\n');
    },
    'image.batch': (r) => (r.dryRun
        ? [...r.jobs.map(j => `${j.id}  ${String(j.model).padEnd(30)} ${money(j.estimatedCost)}`),
            `${r.total} job(s), estimated US$${r.estimatedSpendUsd}${r.unpriced ? ` + ${r.unpriced} unpriced` : ''}` +
            `${r.withinMaxSpend === null ? '' : r.withinMaxSpend ? ' — within --max-spend' : ' — OVER --max-spend'}`].join('\n')
        : `${r.done} done, ${r.failed} failed, ${r.skipped} skipped (${r.alreadyDone} already done) · spent US$${r.spendUsd} this run, US$${r.totalSpendUsd} in total\n${r.statusFile}`),
    usage: (r) => [
        `${r.images} image(s) · US$${r.spendUsd}${r.estimatedUsd ? ` (US$${r.estimatedUsd} of it estimated for older images)` : ''}${r.unpriced ? ` · ${r.unpriced} unpriced` : ''}`,
        ...r.byModel.map(m => `  ${m.model.padEnd(32)} ${String(m.images).padStart(5)} × · US$${m.usd}`),
        `prices: ${r.prices.source} (read ${r.prices.read})`
    ].join('\n'),
    'gallery.prune': (r) => (r.dryRun
        ? `Would delete ${r.matched} image(s), ${(r.bytes / 1048576).toFixed(1)} MB. Run again with --yes to delete.`
        : `Deleted ${r.deleted} image(s), ${(r.bytes / 1048576).toFixed(1)} MB.`),
    'image.trim': (r) => `${r.output}  ${r.width}×${r.height}`,
    'image.tile': (r) => `${r.output}  ${r.width}×${r.height} (${r.columns}×${r.rows})`,
    'image.compare': (r) => `${r.output}  ${r.width}×${r.height}`,
    'gallery.list': (r) => (r.items.length ? r.items.map(imageLine).join('\n') : 'No images.'),
    'gallery.show': (r) => [imageLine(r.item), r.item.paths.output, ...r.item.paths.inputs.map(p => `input ${p}`)].join('\n'),
    'gallery.path': (r) => r.path,
    'gallery.delete': () => 'Deleted.',
    'prompts.list': (r) => (r.items.length
        ? r.items.map(p => `${p.id}  v${String(p.currentVersion).padEnd(3)} ${trunc(p.title, 40)}`).join('\n')
        : 'No saved prompts.'),
    'prompts.show': (r) => [
        `${r.item.title}  (v${r.item.currentVersion}, ${r.item.versions.length} versions)`,
        '',
        (r.item.versions.find(v => v.version === r.item.currentVersion) || {}).body || '',
        '',
        ...r.item.versions.slice().reverse().map(v => `v${v.version}${v.version === r.item.currentVersion ? ' (current)' : ''}${v.restoredFrom ? ` from v${v.restoredFrom}` : ''}  ${v.createdAt}`)
    ].join('\n'),
    'prompts.create': (r) => `Saved "${r.item.title}" as v${r.item.currentVersion} (${r.item.id}).`,
    'prompts.update': (r) => `"${r.item.title}" is now v${r.item.currentVersion}.`,
    'prompts.restore': (r) => `Restored as v${r.item.currentVersion}.`,
    'prompts.delete': () => 'Deleted.',
    'prompts.slots': (r) => (r.slots.length ? r.slots.map(s => `${s.name} = ${s.default === '' ? '(empty)' : s.default}`).join('\n') : 'No slots.'),
    'prompts.compile': (r) => r.text,
    'video.create': (r) => r.dryRun ? JSON.stringify(r.request, null, 2) : r.taskId ? `${r.taskId}  queued` : videoResult(r),
    'video.status': videoResult,
    'video.wait': videoResult,
    'video.resume': (r) => (r.resumed ? r.results.map(x => `${x.id}  ${x.status}${x.error ? `  ${x.error}` : ''}`).join('\n') : 'Nothing pending.'),
    'video.list': (r) => (r.items.length ? r.items.map(videoLine).join('\n') : 'No videos.'),
    'video.show': (r) => [videoLine(r.item), ...Object.entries(r.item.paths).filter(([, p]) => p).map(([k, p]) => `${k} ${p}`)].join('\n'),
    'video.delete': () => 'Deleted.',
    'video.plan': (r) => [
        `subtask   ${r.subtask}`,
        `ratio     ${r.accepts.ratio ? 'accepted' : `not accepted${r.ratioFollows ? ` (follows the ${r.ratioFollows})` : ''}`}`,
        `duration  ${r.accepts.duration ? 'accepted' : `not accepted${r.durationFollows ? ` (follows the ${r.durationFollows})` : ''}`}`,
        `uploads   ${r.uploads.needed ? (r.uploads.available ? 'needed, available' : 'needed, NOT available') : 'none'}`,
        r.ready ? 'ready' : `problems:\n${r.problems.map(p => `  - ${p.message}`).join('\n')}`
    ].join('\n'),
    'tunnel.status': (r) => `${r.tunnel.status}${r.tunnel.url ? `  ${r.tunnel.url}` : ''}  (${r.tunnel.mode}${r.tunnel.ownerPid ? `, pid ${r.tunnel.ownerPid}` : ''})`,
    'keys.reset': () => 'Key rotation state cleared.'
};

function formatResult(opName, result) {
    const f = FORMATTERS[opName];
    return f ? f(result) : generic(result);
}

module.exports = { formatResult };
