// `ai-media-studio mcp`: the MCP adapter over stdio. Tools are generated from the
// operation table (core/operations.js) — same names, same JSON Schemas, same results
// as the CLI's --json output. Configuration, keys and long-running commands are not
// exposed. File inputs go through the path allow-list (core/media.js).
//
// stdout belongs to the protocol: nothing else may print there.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { OPERATIONS, runOperation } = require('../core/operations');
const { createContext } = require('../core/context');
const { StudioError, errorEnvelope } = require('../core/errors');
const { imagePreview } = require('../core/preview');

const VERSION = require('../package.json').version;
const TOOLS = OPERATIONS.filter(op => op.tool && !op.longRunning);

// JSON Schema for the protocol: the operation's schema without the CLI-only hints.
function protocolSchema(schema) {
    if (Array.isArray(schema)) return schema.map(protocolSchema);
    if (!schema || typeof schema !== 'object') return schema;
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (k === 'cli') continue;
        out[k] = (k === 'properties')
            ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, protocolSchema(s)]))
            : protocolSchema(v);
    }
    return out;
}

const PATH_NOTE = ' Local file inputs must be absolute paths inside the allowed folders (AI_MEDIA_STUDIO_ALLOWED_DIRS).';
const WAIT_NOTE = ' Pass timeout (seconds): clients often cancel tool calls after a few minutes; the task keeps running and can be resumed.';

function toolDefinition(op) {
    const h = op.hints || {};
    let description = op.summary;
    if (op.name === 'image.generate' || op.name.startsWith('video.create') || op.name === 'video.plan') description += PATH_NOTE;
    if (op.name === 'video.wait' || op.name === 'video.resume' || op.name === 'video.create') description += WAIT_NOTE;
    return {
        name: op.tool,
        description,
        inputSchema: protocolSchema(op.input),
        annotations: {
            title: op.name.replace('.', ' '),
            readOnlyHint: Boolean(h.readOnly),
            destructiveHint: Boolean(h.destructive),
            openWorldHint: Boolean(h.openWorld),
            idempotentHint: Boolean(h.readOnly)
        }
    };
}

// The subset of JSON Schema the operation table uses: types, required, enums,
// additionalProperties:false. Anything else is the core's to judge.
function checkArguments(op, args) {
    const schema = op.input;
    const props = schema.properties || {};
    const typeOk = (s, v) => {
        switch (s.type) {
            case 'string': return typeof v === 'string';
            case 'boolean': return typeof v === 'boolean';
            case 'integer': return Number.isInteger(v);
            case 'number': return typeof v === 'number' && Number.isFinite(v);
            case 'array': return Array.isArray(v) && (!s.items || v.every(x => typeOk(s.items, x))) && (!s.maxItems || v.length <= s.maxItems);
            case 'object': return v && typeof v === 'object' && !Array.isArray(v) &&
                (!s.additionalProperties || typeof s.additionalProperties !== 'object' || Object.values(v).every(x => typeOk(s.additionalProperties, x)));
            default: return true;
        }
    };
    for (const k of Object.keys(args)) {
        if (!props[k]) throw new StudioError('USAGE', `Unknown argument "${k}" for ${op.tool}.`);
        if (!typeOk(props[k], args[k])) throw new StudioError('USAGE', `Argument "${k}" must be ${props[k].type === 'array' ? 'an array of ' + (props[k].items || {}).type : 'a ' + props[k].type}.`);
        if (props[k].enum && !props[k].enum.includes(args[k])) throw new StudioError('USAGE', `Argument "${k}" must be one of ${props[k].enum.join(', ')}.`);
    }
    for (const r of schema.required || []) {
        if (args[r] === undefined) throw new StudioError('USAGE', `Missing required argument "${r}".`);
    }
}

function createMcpServer(ctx) {
    const server = new Server({ name: 'ai-media-studio', version: VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(toolDefinition) }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const op = TOOLS.find(o => o.tool === request.params.name);
        try {
            if (!op) throw new StudioError('USAGE', `Unknown tool ${request.params.name}.`);
            const args = request.params.arguments || {};
            checkArguments(op, args);
            const result = await runOperation(ctx, op.name, args);
            const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
            if (op.name === 'image.generate' && result.item && result.item.paths) {
                const preview = await imagePreview(result.item.paths.output);
                if (preview) content.push({ type: 'image', data: preview.data, mimeType: preview.mimeType });
            }
            return { content };
        } catch (e) {
            return { content: [{ type: 'text', text: JSON.stringify(errorEnvelope(e), null, 2) }], isError: true };
        }
    });
    return server;
}

async function start() {
    const verbose = process.env.AI_MEDIA_STUDIO_VERBOSE === '1';
    const log = verbose
        ? { log: (...a) => console.error(...a), error: (...a) => console.error(...a) }
        : { log() {}, error() {} };
    const ctx = createContext({ surface: 'mcp', log });
    const server = createMcpServer(ctx);
    await server.connect(new StdioServerTransport());
}

module.exports = { start, createMcpServer, toolDefinition, TOOLS };
