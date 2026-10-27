// Pins the logic that used to live only in public/app.js. The legacy functions are
// loaded from git; once core/ exists, every case is also checked for equality there.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadLegacyBrowserLogic } = require('../helpers/legacy-browser');

const legacy = loadLegacyBrowserLogic();
const hasCore = fs.existsSync(path.join(__dirname, '..', '..', 'core', 'slots.js'));
const core = hasCore ? { models: require('../../core/models'), slots: require('../../core/slots') } : null;

const RATIOS = ['auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9', '5:4'];

describe('size matrix', () => {
    it('legacy spot checks', () => {
        assert.equal(legacy.buildSize('endpoint', '4K', '3:4'), '3520x4704');
        assert.equal(legacy.buildSize('endpoint', '2K', '21:9'), '3136x1344');
        assert.equal(legacy.buildSize('dola-seedream-5-0-pro-260628', '1.5K', '16:9'), '2048x1152');
        assert.equal(legacy.buildSize('endpoint', '4K', 'auto'), '4K');
        assert.equal(legacy.buildSize('endpoint', '4K', '5:4'), '4K', 'unknown ratio falls back to the resolution');
        assert.equal(legacy.buildSize('nonexistent', '2K', '1:1'), '2048x2048', 'unknown model uses the endpoint matrix');
    });

    it('core matches legacy for every model × resolution × ratio', { skip: !core }, () => {
        assert.deepEqual(core.models.SEEDREAM_MODELS, legacy.SEEDREAM_MODELS);
        for (const [model, cfg] of Object.entries(legacy.SEEDREAM_MODELS)) {
            for (const res of [...cfg.resolutions, '8K']) {
                for (const ratio of RATIOS) {
                    assert.equal(
                        core.models.buildSize(model, res, ratio),
                        legacy.buildSize(model, res, ratio),
                        `${model} ${res} ${ratio}`
                    );
                }
            }
        }
    });
});

// [template, values, expected compiled text]
const COMPILE_CASES = [
    ['A {{style:cyberpunk}} city', {}, 'A cyberpunk city'],
    ['{{subject}} portrait', {}, ' portrait'],
    ['{{style:cyberpunk}} city', { style: '' }, ' city'],                 // empty is deliberate
    ['{{style:cyberpunk}} city', { style: 'noir' }, 'noir city'],
    ['{{a:x}} and {{a:y}}', {}, 'x and x'],                               // duplicates share; first default wins
    ['{{a:x}} and {{a:y}}', { a: 'z' }, 'z and z'],
    ['{{ a : spaced }}', {}, ' spaced '],                                // default keeps its spaces
    ['{{a:b:c}}', {}, 'b:c'],
    ['{{a:}}', {}, ''],
    ['{{a b}} stays', {}, '{{a b}} stays'],                              // not a slot name
    ['{{a:b}c}}', {}, '{{a:b}c}}'],                                      // a default cannot contain }
    ['{{multi:line one\nline two}}', {}, 'line one\nline two'],
    ['{{x-y_1:ok}}', {}, 'ok'],
    ['{{v}}', { v: '$1 $& $$' }, '$1 $& $$'],                            // no replace() patterns
    ['{{v:d}}', { other: 'ignored' }, 'd'],
    ['no slots here', {}, 'no slots here'],
    ['', {}, '']
];

// [template, expected parseSlots result]
const PARSE_CASES = [
    ['A {{style:cyberpunk}} of {{subject}}, by {{style:other}}', { order: ['style', 'subject'], defaults: { style: 'cyberpunk', subject: '' } }],
    ['{{ a : b }}', { order: ['a'], defaults: { a: ' b ' } }],
    ['{{a b}} {{ok}}', { order: ['ok'], defaults: { ok: '' } }],
    ['', { order: [], defaults: {} }]
];

describe('slot engine', () => {
    for (const [tpl, values, expected] of COMPILE_CASES) {
        it(`compile ${JSON.stringify(tpl)} with ${JSON.stringify(values)}`, () => {
            assert.equal(legacy.compile(tpl, values), expected);
            if (core) assert.equal(core.slots.compilePrompt(tpl, values), expected);
        });
    }
    for (const [tpl, expected] of PARSE_CASES) {
        it(`parse ${JSON.stringify(tpl)}`, () => {
            assert.deepEqual(legacy.parseSlots(tpl), expected);
            if (core) assert.deepEqual(core.slots.parseSlots(tpl), expected);
        });
    }
});
