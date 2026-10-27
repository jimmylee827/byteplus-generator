// Effective configuration, read from the environment (plus .env) once per process.
// Nothing here validates eagerly: commands that never call BytePlus (gallery, prompts,
// models) work without keys; requireUpstream() is called by those that do.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioError } = require('./errors');

const REPO_ROOT = path.resolve(__dirname, '..');

function loadEnvFile(envFile) {
    // quiet: dotenv 17 otherwise prints a banner to stdout, which would corrupt --json.
    if (fs.existsSync(envFile)) require('dotenv').config({ path: envFile, quiet: true });
}

function buildConfig(env = process.env) {
    const dataDir = path.resolve(env.AI_MEDIA_STUDIO_DATA_DIR || REPO_ROOT);
    const envFile = path.resolve(env.AI_MEDIA_STUDIO_ENV_FILE || path.join(REPO_ROOT, '.env'));
    const videoDir = path.join(dataDir, 'videos');
    const galleryDir = path.join(dataDir, 'gallery');
    const promptsDir = path.join(dataDir, 'prompts');
    const stateDir = path.join(dataDir, '.state');
    const allowed = (env.AI_MEDIA_STUDIO_ALLOWED_DIRS || '')
        .split(path.delimiter).map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));
    return {
        repoRoot: REPO_ROOT,
        publicDir: path.join(REPO_ROOT, 'public'),
        dataDir,
        envFile,
        galleryDir,
        galleryManifest: path.join(galleryDir, 'manifest.json'),
        promptsDir,
        promptsFile: path.join(promptsDir, 'library.json'),
        videoDir,
        videoManifest: path.join(videoDir, 'manifest.json'),
        stagingDir: path.join(videoDir, 'staging'),
        stateDir,
        locksDir: path.join(stateDir, 'locks'),
        keysStateFile: path.join(stateDir, 'keys.json'),
        tunnelStateFile: path.join(stateDir, 'tunnel.json'),

        endpointId: env.ENDPOINT_ID || '',
        apiKeys: (env.BYTEPLUS_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
        port: Number(env.PORT || 3000),
        // Video editing drives Seedance 2.5 via the ModelArk "contents/generations/tasks"
        // API — the same BytePlus ARK host and the same rotating API keys image gen uses,
        // so no separate credentials are required. The default model id can be overridden
        // with VIDEO_MODEL (e.g. a specific snapshot) if BytePlus ships a newer alias.
        videoModel: (env.VIDEO_MODEL || 'dreamina-seedance-2-5-260628').trim(),
        videoUploadLimitMb: Number(env.VIDEO_UPLOAD_LIMIT_MB || 200),
        // Multiplies every video polling delay. Only tests change it.
        pollScale: Number(env.AI_MEDIA_STUDIO_POLL_SCALE || 1),

        // See core/publicUrl.js for how these combine.
        publicBaseUrlEnv: (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
        autoTunnel: env.AUTO_TUNNEL !== '0' && env.AUTO_TUNNEL !== 'false',
        tunnelName: env.TUNNEL_NAME || null,
        tunnelHostname: env.TUNNEL_HOSTNAME || null,

        // MCP file inputs must resolve inside one of these (core/allowlist.js).
        allowedDirs: allowed.length ? allowed : [REPO_ROOT, os.homedir()]
    };
}

let cached = null;
/** Loads .env (without overriding real env vars) and returns the effective config. */
function getConfig() {
    if (cached) return cached;
    const envFile = path.resolve(process.env.AI_MEDIA_STUDIO_ENV_FILE || path.join(REPO_ROOT, '.env'));
    loadEnvFile(envFile);
    cached = buildConfig(process.env);
    return cached;
}

/** Throws unless the config can call BytePlus at all. */
function requireKeys(config) {
    if (config.apiKeys.length === 0) {
        throw new StudioError('CONFIG', 'Missing BYTEPLUS_API_KEYS in .env file.');
    }
}

/** Last four characters only, for anything shown to a person or an agent. */
function mask(value) {
    if (!value) return null;
    const s = String(value);
    return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}

/** `config show`: the effective configuration with every secret masked. */
function describeConfig(config) {
    return {
        dataDir: config.dataDir,
        envFile: config.envFile,
        envFileExists: fs.existsSync(config.envFile),
        endpointId: mask(config.endpointId),
        apiKeys: config.apiKeys.map(mask),
        port: config.port,
        videoModel: config.videoModel,
        videoUploadLimitMb: config.videoUploadLimitMb,
        autoTunnel: config.autoTunnel,
        publicBaseUrl: config.autoTunnel ? null : (config.publicBaseUrlEnv || null),
        tunnelName: config.tunnelName,
        tunnelHostname: config.tunnelHostname,
        allowedDirs: config.allowedDirs
    };
}

module.exports = { getConfig, buildConfig, requireKeys, mask, describeConfig, REPO_ROOT };
