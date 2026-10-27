// `ai-media-studio mcp`: the MCP adapter over stdio. Tools are generated from the
// operation table (core/operations.js) — same names, same JSON Schemas, same results
// as the CLI's --json output. Configuration, keys and long-running commands are not
// exposed. File inputs go through the path allow-list (core/media.js).
//
// stdout belongs to the protocol: nothing else may print there.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { OPERATIONS, runOperation, validateInput } = require('../core/operations');
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
            ? Object.fromEntries(Object.entries(v).filter(([, s]) => !(s.cli && s.cli.only)).map(([p, s]) => [p, protocolSchema(s)]))
            : protocolSchema(v);
    }
    return out;
}

const PATH_NOTE = ' Local file inputs must be absolute paths inside the allowed folders (AI_MEDIA_STUDIO_ALLOWED_DIRS).';
const WAIT_NOTE = ' Pass timeout (seconds): clients often cancel tool calls after a few minutes; the task keeps running and can be resumed.';

function toolDefinition(op) {
    const h = op.hints || {};
    let description = op.summary;
    if (['image.generate', 'image.batch', 'image.trim', 'image.tile', 'image.compare', 'video.create', 'video.plan'].includes(op.name)) description += PATH_NOTE;
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

function createMcpServer(ctx) {
    const server = new Server({ name: 'ai-media-studio', version: VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(toolDefinition) }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const op = TOOLS.find(o => o.tool === request.params.name);
        try {
            if (!op) throw new StudioError('USAGE', `Unknown tool ${request.params.name}.`);
            const args = request.params.arguments || {};
            validateInput(op, args);
            const result = await runOperation(ctx, op.name, args);
            const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
            if (op.name === 'image.generate' && !result.dryRun) {
                // Previews for what was made (a group returns several, capped at 4).
                const made = result.items || (result.item ? [result.item] : []);
                for (const rec of made.slice(0, 4)) {
                    const preview = rec.paths && await imagePreview(rec.paths.output);
                    if (preview) content.push({ type: 'image', data: preview.data, mimeType: preview.mimeType });
                }
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
