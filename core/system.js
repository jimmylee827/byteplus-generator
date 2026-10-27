// Health and catalogue: the read-only facts every surface reports the same way.
const { imageCatalogue, buildSize } = require('./models');
const { videoModes } = require('./videos');
const { tunnelStatus } = require('./publicUrl');
const { describeConfig } = require('./config');
const { StudioError } = require('./errors');

async function health(ctx) {
    const { config } = ctx;
    const totalKeys = config.apiKeys.length;
    const activeKeys = totalKeys ? await ctx.keys.activeCount() : 0;
    const publicBaseUrl = ctx.publicUrl();
    return {
        success: true,
        ok: true,
        activeKeys,
        totalKeys,
        videoEnabled: totalKeys > 0,
        // Reference-media uploads only work when BytePlus can reach us (a public URL).
        videoUploadsEnabled: Boolean(publicBaseUrl),
        publicBaseUrl: publicBaseUrl || null
    };
}

function models(ctx) {
    const v = videoModes(ctx.config);
    return {
        success: true,
        image: imageCatalogue(ctx.config.endpointBaseModel),
        video: { models: v.models, resolutions: v.resolutions, defaultResolution: v.defaultResolution, ratios: v.ratios }
    };
}

function size(_ctx, { model, resolution, ratio }) {
    if (!resolution || !ratio) throw new StudioError('USAGE', 'Give --resolution and --ratio (and optionally --model).');
    return { success: true, size: buildSize(model || 'endpoint', resolution, ratio) };
}

function configShow(ctx) {
    return { success: true, config: describeConfig(ctx.config) };
}

function tunnel(ctx) {
    return { success: true, tunnel: tunnelStatus(ctx.config) };
}

async function keysStatus(ctx) {
    return { success: true, ...(await ctx.keys.status()) };
}

async function keysReset(ctx) {
    await ctx.keys.reset();
    return { success: true, ...(await ctx.keys.status()) };
}

module.exports = { health, models, size, configShow, tunnel, keysStatus, keysReset };
