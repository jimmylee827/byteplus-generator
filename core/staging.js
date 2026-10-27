// IMPORTANT — how reference media reaches BytePlus:
// The tasks API accepts exactly these content types (per its own validator):
// `text`, `image_url`, `audio_url`, `video_url`, `draft_task`. There is NO file_id
// block, and video_url.url must be a real, fetchable URL — data URIs are rejected
// ("must be provided as a web url"). The ModelArk Files API is *not* a way around
// this: uploads reach status "active" but never return a download_url, so a file_id
// can't be turned into a URL either.
//
// Consequence: a local upload can only be used if BytePlus can download it from us.
// We stage the upload into videos/staging/ and hand the task a PUBLIC_BASE_URL link
// to it. Staged files are cleaned up once the task reaches a terminal state — by
// whichever process polls it to the end, since the record holds absolute paths.
// A pasted URL skips staging entirely and is passed through verbatim.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

// Write an uploaded buffer into the publicly-served staging dir and return both the
// absolute URL to hand upstream and the on-disk path so we can delete it later.
async function stageLocalFile(config, publicBaseUrl, buffer, originalname, fallbackExt) {
    await fsp.mkdir(config.stagingDir, { recursive: true });
    const ext = (path.extname(originalname || '') || fallbackExt).toLowerCase();
    const name = `${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
    await fsp.writeFile(path.join(config.stagingDir, name), buffer);
    return { url: `${publicBaseUrl}/videos/staging/${name}`, file: path.join(config.stagingDir, name) };
}

// Best-effort removal of staged inputs once upstream no longer needs them.
async function unstageFiles(paths) {
    for (const p of paths || []) {
        try { await fsp.unlink(p); } catch { /* already gone */ }
    }
}

// A task that is never polled to completion (server restart, closed tab) leaves its
// staged input behind. Nothing upstream needs a clip older than the longest plausible
// render, so sweep stale files on boot and hourly to keep the dir from growing.
const STAGING_TTL_MS = 6 * 60 * 60 * 1000; // 6h
async function sweepStaging(config, log = console) {
    let removed = 0;
    try {
        for (const name of await fsp.readdir(config.stagingDir)) {
            const fp = path.join(config.stagingDir, name);
            try {
                const st = await fsp.stat(fp);
                if (Date.now() - st.mtimeMs > STAGING_TTL_MS) { await fsp.unlink(fp); removed++; }
            } catch { /* raced with a delete */ }
        }
    } catch { /* dir missing — recreated on next upload */ }
    if (removed) log.log(`[VIDEO] swept ${removed} stale staged file(s).`);
    return removed;
}

function ensureStagingDir(config) {
    if (!fs.existsSync(config.stagingDir)) fs.mkdirSync(config.stagingDir, { recursive: true });
}

module.exports = { stageLocalFile, unstageFiles, sweepStaging, ensureStagingDir, STAGING_TTL_MS };
