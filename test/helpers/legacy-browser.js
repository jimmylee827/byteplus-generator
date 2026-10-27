// Loads the pre-refactor browser logic (model matrix, buildSize, slot engine) out of
// public/app.js at BASELINE and runs it in a vm sandbox with the DOM bits it reads
// stubbed. This is the reference the core ports are checked against.
const { execFileSync } = require('child_process');
const vm = require('vm');
const { REPO, BASELINE } = require('./server');

function slice(src, startMarker, endMarker) {
    const a = src.indexOf(startMarker);
    const b = src.indexOf(endMarker, a);
    if (a < 0 || b < 0) throw new Error(`legacy-browser: markers not found: ${startMarker} … ${endMarker}`);
    return src.slice(a, b);
}

function loadLegacyBrowserLogic() {
    const src = execFileSync('git', ['show', `${BASELINE}:public/app.js`], { cwd: REPO, encoding: 'utf-8' });
    const code = [
        slice(src, 'const SEEDREAM_MODELS', '// ============ State ============'),
        slice(src, 'function currentModelKey()', '// Populate the resolution dropdown'),
        slice(src, 'function buildSize()', 'function makeJobCard('),
        slice(src, 'const SLOT_RE', 'function refreshSlots(')
    ].join('\n');
    const ctx = {
        modelSelect: { value: '' },
        resolutionSelect: { value: '' },
        ratioSelect: { value: '' },
        state: { slotValues: {}, slotDefaults: {} }
    };
    vm.createContext(ctx);
    vm.runInContext(code + '\nthis.__api = { SEEDREAM_MODELS, buildSize, parseSlots, compilePrompt };', ctx);
    const api = ctx.__api;
    return {
        SEEDREAM_MODELS: JSON.parse(JSON.stringify(api.SEEDREAM_MODELS)),
        buildSize(model, resolution, ratio) {
            ctx.modelSelect.value = model;
            ctx.resolutionSelect.value = resolution;
            ctx.ratioSelect.value = ratio;
            return api.buildSize();
        },
        parseSlots: (t) => JSON.parse(JSON.stringify(api.parseSlots(t))),
        /** What generate() sends: values the user touched, defaults for the rest. */
        compile(template, values = {}) {
            ctx.state.slotDefaults = api.parseSlots(template).defaults;
            ctx.state.slotValues = values;
            return api.compilePrompt(template);
        }
    };
}

module.exports = { loadLegacyBrowserLogic };
