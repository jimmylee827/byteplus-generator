// ============ Slot / Template engine ============ (moved from public/app.js)
// Syntax: {{name:default}} or {{name}} (default is empty)
// Duplicate names share one input. First occurrence's default is used if defaults differ.
const SLOT_RE = /\{\{\s*([A-Za-z0-9_\-]+)\s*(?::([^}]*))?\}\}/g;

function parseSlots(template) {
    const order = [];
    const defaults = {};
    const re = new RegExp(SLOT_RE.source, 'g');
    let m;
    while ((m = re.exec(template)) !== null) {
        const name = m[1];
        const def = m[2] !== undefined ? m[2] : '';
        if (!Object.hasOwn(defaults, name)) {
            defaults[name] = def;
            order.push(name);
        }
    }
    return { order, defaults };
}

// Own properties only, so a slot called e.g. "constructor" behaves like any other name.
const own = (obj, name) => (obj && Object.hasOwn(obj, name) ? obj[name] : undefined);

/** The value a slot gets: the caller's value if one was given, else its default. */
function slotValue(name, values, defaults) {
    // Empty string means "intentionally empty" — only fall back to the default
    // when the user has never touched this slot (value is undefined).
    const v = own(values, name);
    return v !== undefined ? v : (own(defaults, name) || '');
}

function compilePrompt(template, values = {}) {
    const { defaults } = parseSlots(template);
    return template.replace(new RegExp(SLOT_RE.source, 'g'), (_match, name) => slotValue(name, values, defaults));
}

/**
 * Everything the composer shows for a template:
 *   slots     [{ name, default }] in first-appearance order
 *   values    the caller's values for slots that still exist, defaults for new ones
 *   text      the compiled prompt
 *   segments  [{ text }] / [{ slot, value }] — the compiled prompt in pieces, for the
 *             highlighted preview
 */
function compileView(template, values = {}) {
    const { order, defaults } = parseSlots(template);
    // Keep values for vars that still exist; drop the rest; add new ones from defaults
    const next = {};
    for (const name of order) {
        const v = own(values, name);
        next[name] = v !== undefined ? v : defaults[name];
    }
    const segments = [];
    const re = new RegExp(SLOT_RE.source, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(template)) !== null) {
        if (m.index > last) segments.push({ text: template.slice(last, m.index) });
        segments.push({ slot: m[1], value: slotValue(m[1], next, defaults) });
        last = m.index + m[0].length;
    }
    if (last < template.length) segments.push({ text: template.slice(last) });
    return {
        slots: order.map(name => ({ name, default: defaults[name] })),
        values: next,
        text: compilePrompt(template, next),
        segments
    };
}

module.exports = { SLOT_RE, parseSlots, compilePrompt, compileView };
