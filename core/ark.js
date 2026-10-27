// BytePlus ModelArk transport: the endpoints, and the one key-rotation loop every call
// goes through. Callers keep their own error semantics — the loop only reports what
// happened and leaves the response unread unless it had to read it.
//
// The base URL is hard-coded to the AP-Southeast region.
const ARK_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const IMAGE_URL = `${ARK_BASE}/images/generations`;
const TASKS_URL = `${ARK_BASE}/contents/generations/tasks`;

// Quota / rate-limit / auth → rotate. 401 also disables the key.
const ROTATE_STATUSES = [401, 402, 403, 429];

/**
 * Try the request with each active key in turn.
 * Resolves to one of:
 *   { type: 'ok', res }
 *   { type: 'error', res }                — non-rotating failure, body unread
 *   { type: 'exhausted', res?, lastText } — every attempt rotated (res = the last one
 *                                            when rotation ran out of keys)
 *   { type: 'nokey' }                     — every key is disabled
 * Network failures reject, as fetch does.
 *
 * @param {import('./keys').KeyManager} keys
 * @param {{ url: string, method?: string, body?: string, readRotatedText?: boolean, onRotate?: (status: number, text: string|null) => void }} req
 */
async function rotatingFetch(keys, { url, method, body, readRotatedText = false, onRotate }) {
    let attempts = 0;
    const maxAttempts = await keys.activeCount();
    let lastText = null;
    while (attempts < maxAttempts) {
        const current = await keys.acquire();
        if (!current) return { type: 'nokey' };
        const init = {
            headers: { 'Authorization': `Bearer ${current.key}`, 'Content-Type': 'application/json' }
        };
        if (method) init.method = method;
        if (body !== undefined) init.body = body;
        const res = await fetch(url, init);
        if (res.ok) {
            await keys.recordSuccess(current.hash);
            return { type: 'ok', res };
        }
        if (ROTATE_STATUSES.includes(res.status)) {
            const rotated = await keys.rotate(current.hash, { disable: res.status === 401, status: res.status });
            attempts++;
            lastText = readRotatedText ? await res.text().catch(() => '') : null;
            if (onRotate) onRotate(res.status, lastText);
            if (!rotated) return { type: 'exhausted', res, lastText };
            continue;
        }
        return { type: 'error', res };
    }
    return { type: 'exhausted', lastText };
}

module.exports = { ARK_BASE, IMAGE_URL, TASKS_URL, ROTATE_STATUSES, rotatingFetch };
