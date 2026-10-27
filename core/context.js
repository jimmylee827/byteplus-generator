// One context per process: config, stores and the key manager, plus who is calling
// (`surface`: 'http' | 'cli' | 'mcp'), which only changes the wording of a few
// messages that tell the user what to do next.
const { getConfig, requireKeys } = require('./config');
const { createStores } = require('./stores');
const { KeyManager } = require('./keys');
const { currentPublicUrl } = require('./publicUrl');

const silent = { log() {}, error() {} };

function createContext({ surface = 'cli', log = silent, config = getConfig() } = {}) {
    let keys = null;
    return {
        config,
        surface,
        log,
        stores: createStores(config),
        /** The key manager; throws CONFIG if no keys are configured. */
        get keys() {
            requireKeys(config);
            if (!keys) keys = new KeyManager(config.apiKeys, { stateFile: config.keysStateFile, locksDir: config.locksDir, log });
            return keys;
        },
        publicUrl: () => currentPublicUrl(config)
    };
}

module.exports = { createContext };
