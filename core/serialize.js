// The one serializer every adapter uses. Records keep their stored fields untouched;
// `paths` is added alongside with absolute filesystem paths (null where a file doesn't
// exist), next to the /gallery/... and /videos/... web paths already in the record.
const path = require('path');

const abs = (config, rel) => (rel ? path.join(config.dataDir, String(rel).replace(/^\//, '')) : null);

function imagePaths(config, item) {
    return { ...item, paths: { output: abs(config, item.outputPath), inputs: (item.inputThumbs || []).map(r => abs(config, r)) } };
}

const VIDEO_FILES = ['fullVideo', 'refImage', 'firstFrame', 'lastFrame', 'inputFirstFrame', 'inputLastFrame'];
function videoPaths(config, rec) {
    if (!rec) return rec;
    const paths = {};
    for (const k of VIDEO_FILES) paths[k] = abs(config, rec[k]);
    return { ...rec, paths };
}

function mapRecords(result, fn) {
    if (!result || typeof result !== 'object') return result;
    const out = { ...result };
    if (out.item) out.item = fn(out.item);
    if (out.record) out.record = fn(out.record);
    if (Array.isArray(out.items)) out.items = out.items.map(fn);
    if (Array.isArray(out.results)) out.results = out.results.map(r => (r.record ? { ...r, record: fn(r.record) } : r));
    return out;
}

const present = {
    image: (config, result) => mapRecords(result, it => imagePaths(config, it)),
    video: (config, result) => mapRecords(result, rec => videoPaths(config, rec)),
    plain: (_config, result) => result
};

module.exports = { present, absPath: abs };
