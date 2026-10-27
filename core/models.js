// Image model catalogue and pixel-size matrix (moved here from public/app.js so the
// CLI, the HTTP API and the UI all compute sizes the same way).
//
// Per-model image configuration. The "endpoint" model resolves to the Seedream
// endpoint ID configured on the server (.env ENDPOINT_ID); every other entry is a
// ModelArk model ID forwarded verbatim. Resolutions and exact pixel dimensions
// differ between models (e.g. 5.0 Pro tops out at 2K, 4.5 reaches 4K), so the
// matrix is keyed per model.
const SEEDREAM_MODELS = {
    endpoint: {
        label: 'Seedream 4.5 (endpoint)',
        resolutions: ['2K', '4K'],
        defaultResolution: '4K',
        // outputFormat null → let the endpoint default (jpeg)
        outputFormat: null,
        matrix: {
            '2K': {
                '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304',
                '16:9': '2848x1600', '9:16': '1600x2848', '3:2': '2496x1664',
                '2:3': '1664x2496', '21:9': '3136x1344'
            },
            '4K': {
                '1:1': '4096x4096', '4:3': '4704x3520', '3:4': '3520x4704',
                '16:9': '5504x3040', '9:16': '3040x5504', '3:2': '4992x3328',
                '2:3': '3328x4992', '21:9': '6240x2656'
            }
        }
    },
    'dola-seedream-5-0-pro-260628': {
        label: 'Seedream 5.0 Pro',
        resolutions: ['1K', '1.5K', '2K'],
        defaultResolution: '2K',
        // 5.0 Pro supports png & jpeg; pin jpeg so gallery files stay consistent.
        outputFormat: 'jpeg',
        matrix: {
            '1K': {
                '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152',
                '16:9': '1424x800', '9:16': '800x1424', '3:2': '1248x832',
                '2:3': '832x1248', '21:9': '1568x672'
            },
            '1.5K': {
                '1:1': '1536x1536', '4:3': '1792x1344', '3:4': '1344x1792',
                '16:9': '2048x1152', '9:16': '1152x2048', '3:2': '1872x1248',
                '2:3': '1248x1872', '21:9': '2352x1008'
            },
            '2K': {
                '1:1': '2048x2048', '4:3': '2368x1776', '3:4': '1776x2368',
                '16:9': '2816x1584', '9:16': '1584x2816', '3:2': '2496x1664',
                '2:3': '1664x2496', '21:9': '3136x1344'
            }
        }
    }
};

// The aspect-ratio menu, in the order (and with the labels) the composer shows it.
// "auto" sends the bare resolution and lets the model decide.
const IMAGE_RATIOS = [
    { id: 'auto', label: 'Auto (let model decide)' },
    { id: '1:1', label: '1:1 Square' },
    { id: '4:3', label: '4:3 Landscape' },
    { id: '3:4', label: '3:4 Portrait' },
    { id: '16:9', label: '16:9 Wide' },
    { id: '9:16', label: '9:16 Tall' },
    { id: '3:2', label: '3:2 Landscape' },
    { id: '2:3', label: '2:3 Portrait' },
    { id: '21:9', label: '21:9 Cinema' }
];
const DEFAULT_IMAGE_MODEL = 'endpoint';
// What the composer preselects. Callers that send no ratio at all get 'auto' instead
// (resolveImageSize), which keeps a size-less API call sending the bare resolution.
const UI_DEFAULT_RATIO = '3:4';
const MAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

function modelConfig(modelKey) {
    return SEEDREAM_MODELS[modelKey || DEFAULT_IMAGE_MODEL] || SEEDREAM_MODELS.endpoint;
}

/** Pixel size for a model / resolution / ratio. 'auto' or an unknown ratio → the resolution. */
function buildSize(modelKey, resolution, ratio) {
    const cfg = modelConfig(modelKey);
    if (ratio === 'auto') return resolution;
    return cfg.matrix[resolution]?.[ratio] || resolution;
}

/**
 * The `size` sent upstream. An explicit size (the original HTTP field) wins; otherwise
 * resolution defaults to the model's (4K for a model we don't know) and ratio to 'auto'.
 */
function resolveImageSize({ model, size, resolution, ratio }) {
    if (size) return size;
    const key = model || DEFAULT_IMAGE_MODEL;
    const known = SEEDREAM_MODELS[key];
    const res = resolution || (known ? known.defaultResolution : '4K');
    return buildSize(key, res, ratio || 'auto');
}

/** output_format: an explicit choice (not 'auto') wins, else the model's catalogue default. */
function resolveOutputFormat(model, outputFormat) {
    if (outputFormat && outputFormat !== 'auto') return outputFormat;
    const known = SEEDREAM_MODELS[model || DEFAULT_IMAGE_MODEL];
    return known ? known.outputFormat : null;
}

/** The image half of `ai-media-studio models`. */
function imageCatalogue() {
    return {
        defaultModel: DEFAULT_IMAGE_MODEL,
        defaultRatio: UI_DEFAULT_RATIO,
        maxReferenceImages: MAX_REFERENCE_IMAGES,
        maxReferenceImageBytes: MAX_REFERENCE_IMAGE_BYTES,
        ratios: IMAGE_RATIOS,
        models: Object.entries(SEEDREAM_MODELS).map(([id, cfg]) => ({
            id,
            label: cfg.label,
            resolutions: cfg.resolutions,
            defaultResolution: cfg.defaultResolution,
            outputFormat: cfg.outputFormat,
            sizes: cfg.matrix
        })),
        // Any other ModelArk image model id is forwarded verbatim; sizes for it fall
        // back to the endpoint matrix.
        passThrough: true
    };
}

module.exports = {
    SEEDREAM_MODELS, IMAGE_RATIOS, DEFAULT_IMAGE_MODEL, UI_DEFAULT_RATIO,
    MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES,
    buildSize, resolveImageSize, resolveOutputFormat, imageCatalogue
};
