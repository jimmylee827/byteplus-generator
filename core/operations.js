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
const { loadMedia, readTextFile, resolveOutDir, resolvePath } = require('./media');
const { runBatch } = require('./batch');
const tools = require('./imagetools');
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

// Everything image generate (and each batch job) accepts.
const generateProps = {
    prompt: str('The prompt; may contain {{name:default}} slots. "-" reads stdin on the CLI.', { cli: { short: 'p' } }),
    promptFile: str('Read the prompt from this file ("-" = stdin on the CLI).'),
    fromPrompt: str('Use the current body of this saved prompt (library id).'),
    slots: slotsProp,
    images: {
        type: 'array', items: { type: 'string' }, maxItems: 9,
        description: 'Up to 9 local reference images, in order. Name what each shows with role=path (e.g. garment=a.jpg, character=b.jpg): the prompt then starts with "Image 1 is the garment; images 2 and 3 are the character." and the roles are recorded.',
        cli: { flag: 'image', multiple: true }
    },
    legend: bool('Start the prompt with which named reference is which (default on when references have roles).', { cli: { negatable: true } }),
    model: str('"endpoint" (Seedream 4.5, default) or a ModelArk model id — see `models`.'),
    resolution: str('A resolution the model offers (default: the model default). On Seedream 5.0 Pro, 1.5K costs half of 2K.'),
    ratio: str('Aspect ratio such as 3:4, or auto (default auto).'),
    size: str('Exact WIDTHxHEIGHT (or a bare resolution); overrides resolution/ratio.'),
    format: str('jpeg | png (only some models accept png).', { enum: ['jpeg', 'png'] }),
    watermark: bool('Add the BytePlus watermark.'),
    seed: int('Seed for a repeatable result. Refused for models without one — no current Seedream model (5.0, 4.5, 4.0) has a seed parameter.'),
    group: int('Ask for up to N related images in one call (a consistent set). Seedream 4.5, 4.0 and 5.0 Lite only; references + N may not exceed 15. Billed per image returned.'),
    tags: { type: 'array', items: { type: 'string' }, description: 'Tags saved on the image, for gallery list --tag, usage --tag and gallery prune --tag.', cli: { flag: 'tag', multiple: true } },
    meta: { type: 'object', additionalProperties: { type: 'string' }, description: 'Free-form key=value metadata saved on the image.', cli: { flag: 'meta', multiple: true, kv: true } },
    out: str('Also copy the result here: a folder, or an exact file path ending in .jpeg/.jpg/.png/.webp (a group adds -1, -2, …).'),
    dryRun: bool('Print the exact request and its estimated cost (keys never shown) and stop — no call, no cost.')
};

// "garment=/a.jpg" → { role: 'garment', path: '/a.jpg' }; a plain path has no role.
function parseImageRef(v) {
    const m = /^([A-Za-z][\w-]*)=(.+)$/.exec(String(v));
    return m ? { role: m[1], path: m[2] } : { role: null, path: String(v) };
}

async function runImageGenerate(ctx, i, { dryRun }) {
    let prompt = i.prompt;
    const sources = [i.prompt !== undefined, Boolean(i.promptFile), Boolean(i.fromPrompt)].filter(Boolean).length;
    if (sources !== 1) throw new StudioError('USAGE', 'Give exactly one of --prompt, --prompt-file or --from-prompt.');
    if (i.promptFile) prompt = await readTextFile(ctx, i.promptFile);
    if (i.fromPrompt) prompt = await prompts.resolveTemplate(ctx, { id: i.fromPrompt });
    const refs = [];
    for (const v of i.images || []) {
        const { role, path: p } = parseImageRef(v);
        refs.push({ ...(await loadMedia(ctx, p, { allowUrl: false })), role });
    }
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
        seed: i.seed,
        group: i.group,
        legend: i.legend,
        tags: i.tags,
        meta: i.meta,
        images: refs,
        out: resolveOutDir(ctx, i.out)
    }, { dryRun });
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
        summary: BILLED + 'Generate one image (or a group of related images) with Seedream and save it to the gallery. The result includes its cost. Check the request first with a dry run.',
        hints: { openWorld: true, billed: true }, present: 'image',
        input: obj(generateProps),
        run: (ctx, i) => runImageGenerate(ctx, i, { dryRun: Boolean(i.dryRun) })
    },
    {
        name: 'image.batch', tool: 'ai_media_studio_image_batch',
        summary: BILLED + 'Run a file of image-generate jobs (JSON Lines, or a .json array) with a concurrency limit, an optional spend cap, and resume. Progress is kept in <file>.status.json. Dry-run it first to see the estimated spend.',
        hints: { openWorld: true, billed: true },
        input: obj({
            file: str('The jobs file. Each job takes the same fields as image generate, plus an optional id; relative paths are relative to the file.', { cli: { positional: true } }),
            concurrency: int('Jobs at a time (default 4, at most 16).'),
            maxSpend: { type: 'number', description: 'Stop before the batch\'s recorded spend (this run plus earlier resumed runs) would pass this many US dollars. Jobs with no known price are skipped when set.' },
            resume: bool('Skip jobs already done (per the status file) or whose `out` file exists.'),
            restart: bool('Run every job again even though the status file records some as done (pays again).'),
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags added to every image in the batch.', cli: { flag: 'tag', multiple: true } },
            dryRun: bool('Check every job and total the estimated spend; nothing is called or paid.'),
            jsonl: bool('Print one JSON line per finished job, then a summary line.', { cli: { only: true } })
        }, ['file']),
        async run(ctx, i, io = {}) {
            const op = BY_NAME.get('image.generate');
            const file = resolvePath(ctx, i.file);
            return runBatch(ctx, { ...i, file }, {
                validate: (job) => validateInput(op, job),
                estimate: (job) => runImageGenerate(ctx, job, { dryRun: true }),
                generate: async (job) => present.image(ctx.config, await runImageGenerate(ctx, job, { dryRun: false })),
                onJob: io.onJob
            });
        }
    },
    {
        name: 'usage', tool: 'ai_media_studio_usage',
        summary: 'Total image spend from the gallery: per model, with filters by date and tag. Images made before costs were recorded are priced from their model, size and inputs (marked as estimated).',
        hints: { readOnly: true },
        input: obj({
            since: str('Only images from this date/time, or this long ago (30d, 12h, 2w).'),
            until: str('Only images before this date/time, or this long ago.'),
            tag: { type: 'array', items: { type: 'string' }, description: 'Only images with every one of these tags.', cli: { flag: 'tag', multiple: true } }
        }),
        run: (ctx, i) => images.usage(ctx, i)
    },
    {
        name: 'image.trim', tool: 'ai_media_studio_image_trim',
        summary: 'Crop the empty margin around the subject (local, free) — works on studio backdrops with gradients and soft shadows, not just flat colour. Reports `unchanged` when content reaches every edge. Writes <name>-trim<ext> beside the input unless --out is given.',
        hints: {},
        input: obj({
            input: str('The image to trim.', { cli: { positional: true } }),
            out: str('Where to write the result (.png/.jpg/.webp).'),
            threshold: int('How strong an edge must be to count as subject (0–255, default 16). Raise it to trim less aggressively.'),
            margin: { type: 'number', description: 'Breathing room kept around the subject, as a % of the long edge (default 1.5).' },
            minContent: { type: 'number', description: 'How much of a row or column must be edges for it to hold the subject, in % (default 4).' },
            pad: int('Extra background pixels added back around the result (default 0).'),
            background: str('Background colour for --pad, e.g. #ffffff (default: the original corner colour).')
        }, ['input']),
        run: (ctx, i) => tools.trimImage({ ...i, input: resolvePath(ctx, i.input), out: i.out && resolvePath(ctx, i.out) })
    },
    {
        name: 'image.tile', tool: 'ai_media_studio_image_tile',
        summary: 'Lay images out in a grid with no gaps, e.g. a character sheet (local, free).',
        hints: {},
        input: obj({
            images: { type: 'array', items: { type: 'string' }, description: 'The images, in reading order.', cli: { positional: true } },
            out: str('The sheet to write (.png/.jpg/.webp).'),
            columns: int('Images per row (default: all in one row).'),
            cell: str('Cell size WIDTHxHEIGHT (default: the first image\'s size).'),
            fit: str('contain (whole image, background around it) or cover (fill the cell, cropping).', { enum: ['contain', 'cover'] }),
            background: str('Background colour for contain, e.g. #ffffff.')
        }, ['images', 'out']),
        run: (ctx, i) => tools.tileImages({ ...i, inputs: i.images.map(p => resolvePath(ctx, p)), out: resolvePath(ctx, i.out) })
    },
    {
        name: 'image.compare', tool: 'ai_media_studio_image_compare',
        summary: 'A labelled side-by-side sheet of images for human review (local, free).',
        hints: {},
        input: obj({
            images: { type: 'array', items: { type: 'string' }, description: 'The images to compare.', cli: { positional: true } },
            out: str('The sheet to write (.png/.jpg/.webp).'),
            labels: { type: 'array', items: { type: 'string' }, description: 'One label per image (default: file names).', cli: { flag: 'label', multiple: true } },
            height: int('Height each image is scaled to (default 640).'),
            columns: int('Images per row (default: all in one row).')
        }, ['images', 'out']),
        run: (ctx, i) => tools.compareImages({ ...i, inputs: i.images.map(p => resolvePath(ctx, p)), out: resolvePath(ctx, i.out) })
    },
    {
        name: 'gallery.list', tool: 'ai_media_studio_gallery_list',
        summary: 'Past images, newest first (all history — the UI\'s panic mode does not apply here).',
        hints: { readOnly: true }, present: 'image',
        input: obj({
            search: str('Case-insensitive text to find in the prompt.'),
            tag: { type: 'array', items: { type: 'string' }, description: 'Only images with every one of these tags.', cli: { flag: 'tag', multiple: true } },
            limit: int('At most this many.')
        }),
        run: (ctx, i) => images.listGallery(ctx, i)
    },
    {
        name: 'gallery.prune', tool: 'ai_media_studio_gallery_prune',
        summary: 'Delete gallery images by tag and/or age. A dry run unless yes is given; needs at least one filter.',
        hints: { destructive: true }, selfConfirm: true,
        input: obj({
            tag: { type: 'array', items: { type: 'string' }, description: 'Only images with every one of these tags.', cli: { flag: 'tag', multiple: true } },
            olderThan: str('Only images older than this: a duration (30d, 12h, 2w) or a date.'),
            yes: bool('Actually delete. Without it, only report what would be deleted.')
        }),
        run: (ctx, i) => images.pruneGallery(ctx, i)
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

// The subset of JSON Schema the table uses: types, required, enums, additionalProperties
// false. Used for MCP arguments and batch jobs (the CLI coerces its own flags).
function validateInput(op, args) {
    const schema = op.input;
    const props = schema.properties || {};
    const typeOk = (s, v) => {
        switch (s.type) {
            case 'string': return typeof v === 'string';
            case 'boolean': return typeof v === 'boolean';
            case 'integer': return Number.isInteger(v);
            case 'number': return typeof v === 'number' && Number.isFinite(v);
            case 'array': return Array.isArray(v) && (!s.items || v.every(x => typeOk(s.items, x))) && (!s.maxItems || v.length <= s.maxItems);
            case 'object': return Boolean(v) && typeof v === 'object' && !Array.isArray(v) &&
                (!s.additionalProperties || typeof s.additionalProperties !== 'object' || Object.values(v).every(x => typeOk(s.additionalProperties, x)));
            default: return true;
        }
    };
    const what = (s) => (s.type === 'array' ? `an array of ${(s.items || {}).type}s${s.maxItems ? ` (at most ${s.maxItems})` : ''}` : `a ${s.type}`);
    for (const k of Object.keys(args)) {
        if (!props[k] || (props[k].cli && props[k].cli.only)) throw new StudioError('USAGE', `Unknown field "${k}".`);
        if (!typeOk(props[k], args[k])) throw new StudioError('USAGE', `"${k}" must be ${what(props[k])}.`);
        if (props[k].enum && !props[k].enum.includes(args[k])) throw new StudioError('USAGE', `"${k}" must be one of ${props[k].enum.join(', ')}.`);
    }
    for (const r of schema.required || []) {
        if (args[r] === undefined) throw new StudioError('USAGE', `Missing required field "${r}".`);
    }
}

/** Run an operation and decorate its result exactly as the HTTP route does. */
async function runOperation(ctx, name, input = {}, io) {
    const op = BY_NAME.get(name);
    if (!op || op.longRunning) throw new StudioError('USAGE', `Unknown operation ${name}.`);
    const result = await op.run(ctx, input, io);
    return present[op.present || 'plain'](ctx.config, result);
}

module.exports = { OPERATIONS, BY_NAME, runOperation, validateInput, parseImageRef };
