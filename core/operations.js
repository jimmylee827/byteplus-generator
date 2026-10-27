// The one table of everything ai-media-studio can do. The CLI builds its commands and
// flags from it, and the MCP server its tools and JSON Schemas, so the two can't drift.
// The HTTP routes call the same core functions with the same presenter.
//
// Each operation:
//   name        dotted id, also the CLI command path ("video.create" → `video create`)
//   tool        MCP tool name, or null when not exposed to MCP
//   summary     one line for help and tool descriptions
//   hints       { readOnly, destructive, openWorld, billed }
//   input       JSON Schema (object). Property extras, used by the CLI only:
//                 cli: { flag, short, multiple, kv, negatable, positional }
//   present     which presenter decorates the result ('image' | 'video' | 'plain')
//   run(ctx, input, io)  → result object ({ success: true, ... })
//   longRunning true for serve / mcp / tunnel up (CLI only, never returns a result)
const { StudioError } = require('./errors');
const system = require('./system');
const images = require('./images');
const prompts = require('./prompts');
const videos = require('./videos');
const { loadMedia, readTextFile, resolveOutDir } = require('./media');
const { present, absPath } = require('./serialize');

const BILLED = 'BILLED: each call is a paid BytePlus generation. ';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const idArg = (what) => str(`${what} id.`, { cli: { positional: true } });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const slotsProp = {
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Values for {{name:default}} slots in the prompt. A slot you leave out gets its default; an empty string is used as-is.',
    cli: { flag: 'slot', multiple: true, kv: true }
};

// Shared by video plan / create.
const videoInputProps = {
    mode: str('"edit" (a reference clip, or a reference image alone) or "first-last" (keyframes).', { enum: ['edit', 'first-last', 'firstLast'], default: 'edit' }),
    prompt: str('The edit instruction (edit mode) or motion prompt (first-last). "-" reads stdin on the CLI.', { cli: { short: 'p' } }),
    video: str('Reference clip: a local path (needs a live public URL — see tunnel status) or a public https:// URL.'),
    image: str('Reference image (edit mode): local path or https:// URL.'),
    firstFrame: str('First frame image (first-last mode, required): local path or https:// URL.'),
    lastFrame: str('Last frame image (first-last mode, optional): local path or https:// URL.'),
    model: str('Seedance model id (see `video modes`).'),
    resolution: str('480p | 720p | 1080p (default 1080p).'),
    ratio: str('Aspect ratio — only honoured for a reference image without a clip (see `video modes`).'),
    duration: int('Seconds, 4–30 — not accepted when a clip dictates it.'),
    audio: bool('Generate an audio track (omit to use the model default).', { cli: { negatable: true } }),
    seed: int('Seed for reproducibility. 0 is not sent.'),
    watermark: bool('Add the BytePlus watermark.')
};

async function videoCoreInput(ctx, input) {
    return {
        mode: input.mode === 'first-last' ? 'firstLast' : input.mode,
        prompt: input.prompt,
        model: input.model,
        resolution: input.resolution,
        ratio: input.ratio,
        duration: input.duration,
        watermark: input.watermark,
        generateAudio: input.audio,
        seed: input.seed,
        video: await loadMedia(ctx, input.video),
        image: await loadMedia(ctx, input.image),
        firstFrame: await loadMedia(ctx, input.firstFrame),
        lastFrame: await loadMedia(ctx, input.lastFrame)
    };
}

const timeoutProp = int('Give up waiting after this many seconds (the task keeps running; resume later).');

const OPERATIONS = [
    {
        name: 'health', tool: 'ai_media_studio_health',
        summary: 'Keys active/total, whether video and uploads are available, the public URL.',
        hints: { readOnly: true }, input: obj({}),
        run: (ctx) => system.health(ctx)
    },
    {
        name: 'config.show', tool: null,
        summary: 'The effective configuration, with API keys and the endpoint id masked.',
        hints: { readOnly: true }, input: obj({}),
        run: (ctx) => system.configShow(ctx)
    },
    {
        name: 'keys.status', tool: null,
        summary: 'Per-key uses and disabled flags (keys masked).',
        hints: { readOnly: true }, input: obj({}),
        run: (ctx) => system.keysStatus(ctx)
    },
    {
        name: 'keys.reset', tool: null,
        summary: 'Forget rotation state: re-enables 401-disabled keys and zeroes use counts.',
        hints: { destructive: true }, input: obj({}),
        run: (ctx) => system.keysReset(ctx)
    },
    {
        name: 'models', tool: 'ai_media_studio_models',
        summary: 'Image and video models, resolutions, ratios, defaults, output formats and pixel sizes.',
        hints: { readOnly: true }, input: obj({}),
        run: (ctx) => system.models(ctx)
    },
    {
        name: 'size', tool: 'ai_media_studio_size',
        summary: 'The pixel size sent for a model / resolution / ratio, e.g. 1728x2304.',
        hints: { readOnly: true },
        input: obj({
            model: str('Image model id (default "endpoint").'),
            resolution: str('e.g. 2K, 4K, 1.5K.'),
            ratio: str('e.g. 3:4, 16:9, or auto.')
        }, ['resolution', 'ratio']),
        run: (ctx, i) => system.size(ctx, i)
    },
    {
        name: 'image.generate', tool: 'ai_media_studio_image_generate',
        summary: BILLED + 'Generate one image with Seedream and save it to the gallery. Check the request first with a dry run.',
        hints: { openWorld: true, billed: true }, present: 'image',
        input: obj({
            prompt: str('The prompt; may contain {{name:default}} slots. "-" reads stdin on the CLI.', { cli: { short: 'p' } }),
            promptFile: str('Read the prompt from this file ("-" = stdin on the CLI).'),
            fromPrompt: str('Use the current body of this saved prompt (library id).'),
            slots: slotsProp,
            images: { type: 'array', items: { type: 'string' }, maxItems: 9, description: 'Up to 9 local reference image paths.', cli: { flag: 'image', multiple: true } },
            model: str('"endpoint" (Seedream 4.5, default) or a ModelArk model id — see `models`.'),
            resolution: str('A resolution the model offers (default: the model default).'),
            ratio: str('Aspect ratio such as 3:4, or auto (default auto).'),
            size: str('Exact WIDTHxHEIGHT (or a bare resolution); overrides resolution/ratio.'),
            format: str('jpeg | png (only some models accept png).', { enum: ['jpeg', 'png'] }),
            watermark: bool('Add the BytePlus watermark.'),
            out: str('Also copy the result into this folder.'),
            dryRun: bool('Print the exact request (keys never shown) and stop — no call, no cost.')
        }),
        async run(ctx, i) {
            let prompt = i.prompt;
            const sources = [i.prompt !== undefined, Boolean(i.promptFile), Boolean(i.fromPrompt)].filter(Boolean).length;
            if (sources !== 1) throw new StudioError('USAGE', 'Give exactly one of --prompt, --prompt-file or --from-prompt.');
            if (i.promptFile) prompt = await readTextFile(ctx, i.promptFile);
            if (i.fromPrompt) prompt = await prompts.resolveTemplate(ctx, { id: i.fromPrompt });
            const refs = [];
            for (const p of i.images || []) refs.push(await loadMedia(ctx, p, { allowUrl: false }));
            return images.generateImage(ctx, {
                prompt,
                // Always compiled, as the composer does: slots left out get their defaults.
                slots: i.slots || {},
                model: i.model,
                resolution: i.resolution,
                ratio: i.ratio,
                size: i.size,
                outputFormat: i.format,
                watermark: i.watermark,
                images: refs,
                out: resolveOutDir(ctx, i.out)
            }, { dryRun: Boolean(i.dryRun) });
        }
    },
    {
        name: 'gallery.list', tool: 'ai_media_studio_gallery_list',
        summary: 'Past images, newest first (all history — the UI\'s panic mode does not apply here).',
        hints: { readOnly: true }, present: 'image',
        input: obj({ search: str('Case-insensitive text to find in the prompt.'), limit: int('At most this many.') }),
        run: (ctx, i) => images.listGallery(ctx, i)
    },
    {
        name: 'gallery.show', tool: 'ai_media_studio_gallery_get',
        summary: 'One gallery image with its absolute file paths.',
        hints: { readOnly: true }, present: 'image',
        input: obj({ id: idArg('Gallery') }, ['id']),
        run: (ctx, i) => images.getGalleryItem(ctx, i.id)
    },
    {
        name: 'gallery.path', tool: null,
        summary: 'Print the absolute path of a gallery image.',
        hints: { readOnly: true },
        input: obj({ id: idArg('Gallery') }, ['id']),
        async run(ctx, i) {
            const { item } = await images.getGalleryItem(ctx, i.id);
            return { success: true, id: item.id, path: absPath(ctx.config, item.outputPath), webPath: item.outputPath };
        }
    },
    {
        name: 'gallery.delete', tool: 'ai_media_studio_gallery_delete',
        summary: 'Delete a gallery image, its input thumbnails and its record. Cannot be undone.',
        hints: { destructive: true },
        input: obj({ id: idArg('Gallery') }, ['id']),
        run: (ctx, i) => images.deleteGalleryItem(ctx, i.id)
    },
    {
        name: 'prompts.list', tool: 'ai_media_studio_prompts_list',
        summary: 'Saved prompts (title, current body, version), newest first.',
        hints: { readOnly: true },
        input: obj({ search: str('Text to find in the title or body.') }),
        run: (ctx, i) => prompts.listPrompts(ctx, i)
    },
    {
        name: 'prompts.show', tool: 'ai_media_studio_prompts_get',
        summary: 'A saved prompt with every version.',
        hints: { readOnly: true },
        input: obj({ id: idArg('Prompt') }, ['id']),
        run: (ctx, i) => prompts.getPrompt(ctx, i.id)
    },
    {
        name: 'prompts.create', tool: 'ai_media_studio_prompts_create',
        summary: 'Save a new prompt (version 1).',
        hints: {},
        input: obj({
            title: str('Title.'),
            body: str('Body; may contain {{name:default}} slots.'),
            bodyFile: str('Read the body from this file ("-" = stdin on the CLI).')
        }, ['title']),
        async run(ctx, i) {
            const body = i.bodyFile ? await readTextFile(ctx, i.bodyFile) : i.body;
            return prompts.createPrompt(ctx, { title: i.title, body });
        }
    },
    {
        name: 'prompts.update', tool: 'ai_media_studio_prompts_update',
        summary: 'Change a prompt\'s title and/or body; a new body becomes a new version.',
        hints: {},
        input: obj({
            id: idArg('Prompt'),
            title: str('New title.'),
            body: str('New body.'),
            bodyFile: str('Read the new body from this file ("-" = stdin on the CLI).')
        }, ['id']),
        async run(ctx, i) {
            const body = i.bodyFile ? await readTextFile(ctx, i.bodyFile) : i.body;
            return prompts.updatePrompt(ctx, i.id, { title: i.title, body });
        }
    },
    {
        name: 'prompts.restore', tool: 'ai_media_studio_prompts_restore',
        summary: 'Copy an old version forward as the new current version.',
        hints: {},
        input: obj({ id: idArg('Prompt'), version: int('Version number to restore.', { cli: { positional: true } }) }, ['id', 'version']),
        run: (ctx, i) => prompts.restorePrompt(ctx, i.id, i.version)
    },
    {
        name: 'prompts.delete', tool: 'ai_media_studio_prompts_delete',
        summary: 'Delete a prompt and all its versions. Cannot be undone.',
        hints: { destructive: true },
        input: obj({ id: idArg('Prompt') }, ['id']),
        run: (ctx, i) => prompts.deletePrompt(ctx, i.id)
    },
    {
        name: 'prompts.slots', tool: 'ai_media_studio_prompts_slots',
        summary: 'The {{slots}} in a saved prompt or a text, with their defaults.',
        hints: { readOnly: true },
        input: obj({ id: str('Saved prompt id.', { cli: { positional: true } }), text: str('A template instead of a saved prompt.'), textFile: str('Read the template from a file.') }),
        async run(ctx, i) {
            const text = i.textFile ? await readTextFile(ctx, i.textFile) : i.text;
            return prompts.promptSlots(ctx, { id: i.id, text });
        }
    },
    {
        name: 'prompts.compile', tool: 'ai_media_studio_prompts_compile',
        summary: 'Fill a template\'s slots and return the exact prompt that would be sent.',
        hints: { readOnly: true },
        input: obj({
            id: str('Saved prompt id.', { cli: { positional: true } }),
            text: str('A template instead of a saved prompt.'),
            textFile: str('Read the template from a file.'),
            slots: slotsProp
        }),
        async run(ctx, i) {
            const text = i.textFile ? await readTextFile(ctx, i.textFile) : i.text;
            return prompts.compilePromptTemplate(ctx, { id: i.id, text, values: i.slots });
        }
    },
    {
        name: 'video.modes', tool: 'ai_media_studio_video_modes',
        summary: 'Video modes and which parameters each accepts, models, resolutions, ratios, duration bounds.',
        hints: { readOnly: true }, input: obj({}),
        run: (ctx) => videos.videoModes(ctx.config)
    },
    {
        name: 'video.plan', tool: 'ai_media_studio_video_plan',
        summary: 'Free check of a video request: which subtask it becomes, what it accepts, and any problems.',
        hints: { readOnly: true },
        input: obj({ ...videoInputProps }),
        async run(ctx, i) {
            // Planning never reads the files — it only needs to know which inputs exist.
            const m = (v) => (!v ? null : /^https?:\/\//i.test(v) ? { url: v } : { upload: true });
            return videos.planVideo(ctx, {
                mode: i.mode === 'first-last' ? 'firstLast' : i.mode, prompt: i.prompt, duration: i.duration,
                video: m(i.video), image: m(i.image), firstFrame: m(i.firstFrame), lastFrame: m(i.lastFrame)
            });
        }
    },
    {
        name: 'video.create', tool: 'ai_media_studio_video_create',
        summary: BILLED + 'Start a Seedance video task (edit a clip, animate a reference image, or interpolate first/last frames). Check it first with `video plan` or a dry run.',
        hints: { openWorld: true, billed: true }, present: 'video',
        input: obj({
            ...videoInputProps,
            wait: bool('Wait for the task to finish and download the result.'),
            timeout: timeoutProp,
            dryRun: bool('Print the exact request and stop — no staging, no call, no cost.')
        }),
        async run(ctx, i, io = {}) {
            const created = await videos.createVideo(ctx, await videoCoreInput(ctx, i), { dryRun: Boolean(i.dryRun) });
            if (i.dryRun || !i.wait) return created;
            return videos.waitForVideo(ctx, created.taskId, { timeoutMs: i.timeout ? i.timeout * 1000 : null, onProgress: io.onProgress });
        }
    },
    {
        name: 'video.status', tool: 'ai_media_studio_video_status',
        summary: 'Check a task once; on success the clip is downloaded and the record updated.',
        hints: { openWorld: true }, present: 'video',
        input: obj({ id: idArg('Task') }, ['id']),
        run: (ctx, i) => videos.pollOnce(ctx, i.id)
    },
    {
        name: 'video.wait', tool: 'ai_media_studio_video_wait',
        summary: 'Poll a task until it finishes, then download the result.',
        hints: { openWorld: true }, present: 'video',
        input: obj({ id: idArg('Task'), timeout: timeoutProp }, ['id']),
        run: (ctx, i, io = {}) => videos.waitForVideo(ctx, i.id, { timeoutMs: i.timeout ? i.timeout * 1000 : null, onProgress: io.onProgress })
    },
    {
        name: 'video.resume', tool: 'ai_media_studio_video_resume',
        summary: 'Finish every task still queued or running (after a restart or a closed tab).',
        hints: { openWorld: true }, present: 'video',
        input: obj({ timeout: timeoutProp }),
        run: (ctx, i, io = {}) => videos.resumeVideos(ctx, { timeoutMs: i.timeout ? i.timeout * 1000 : null, onProgress: io.onProgress })
    },
    {
        name: 'video.list', tool: 'ai_media_studio_video_list',
        summary: 'Past video tasks, newest first, with the ids still pending.',
        hints: { readOnly: true }, present: 'video', input: obj({}),
        run: (ctx) => videos.listVideos(ctx)
    },
    {
        name: 'video.show', tool: 'ai_media_studio_video_get',
        summary: 'One video record with its absolute file paths.',
        hints: { readOnly: true }, present: 'video',
        input: obj({ id: idArg('Task') }, ['id']),
        run: (ctx, i) => videos.getVideo(ctx, i.id)
    },
    {
        name: 'video.delete', tool: 'ai_media_studio_video_delete',
        summary: 'Delete a video record and its files. Cannot be undone.',
        hints: { destructive: true },
        input: obj({ id: idArg('Task') }, ['id']),
        run: (ctx, i) => videos.deleteVideo(ctx, i.id)
    },
    {
        name: 'tunnel.status', tool: 'ai_media_studio_tunnel_status',
        summary: 'Whether a public URL is live for local uploads, and which process owns it.',
        hints: { readOnly: true }, input: obj({}),
        run: (ctx) => system.tunnel(ctx)
    },
    {
        name: 'tunnel.up', tool: null, longRunning: true,
        summary: 'Run the tunnel (and a staging-only file server) in the foreground so CLI/MCP uploads work.',
        input: obj({ port: int('Local port (default PORT or 3000).') })
    },
    {
        name: 'serve', tool: null, longRunning: true,
        summary: 'Run the web UI and HTTP API (what `npm start` does).',
        input: obj({ port: int('Port (default PORT or 3000).') })
    },
    {
        name: 'mcp', tool: null, longRunning: true,
        summary: 'Run the MCP server over stdio.',
        input: obj({})
    }
];

const BY_NAME = new Map(OPERATIONS.map(op => [op.name, op]));

/** Run an operation and decorate its result exactly as the HTTP route does. */
async function runOperation(ctx, name, input = {}, io) {
    const op = BY_NAME.get(name);
    if (!op || op.longRunning) throw new StudioError('USAGE', `Unknown operation ${name}.`);
    const result = await op.run(ctx, input, io);
    return present[op.present || 'plain'](ctx.config, result);
}

module.exports = { OPERATIONS, BY_NAME, runOperation };
