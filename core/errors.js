// Typed errors with stable codes. Every adapter turns a StudioError into the same
// envelope — { success: false, error, code, raw? } — and reads the HTTP status and
// CLI exit code from here, so no adapter decides how a failure is reported.
const CODES = {
    USAGE:                 { exit: 2, http: 400 },
    VALIDATION:            { exit: 2, http: 400 },
    PATH_NOT_ALLOWED:      { exit: 2, http: 400 },
    UPSTREAM_REJECTED:     { exit: 3, http: 502 }, // usually overridden with the upstream status
    UPSTREAM_BAD_RESPONSE: { exit: 3, http: 502 },
    TASK_FAILED:           { exit: 3, http: 502 },
    KEYS_EXHAUSTED:        { exit: 4, http: 503 },
    NOT_FOUND:             { exit: 5, http: 404 },
    UPLOADS_UNAVAILABLE:   { exit: 6, http: 400 },
    WAIT_TIMEOUT:          { exit: 7, http: 504 },
    DOWNLOAD_FAILED:       { exit: 1, http: 502 },
    NETWORK:               { exit: 1, http: 500 },
    CONFIG:                { exit: 1, http: 500 },
    INTERNAL:              { exit: 1, http: 500 }
};

class StudioError extends Error {
    /**
     * @param {keyof CODES} code
     * @param {string} message  shown to the user verbatim
     * @param {{ httpStatus?: number, raw?: string|null, retryable?: boolean, extra?: object }} [opts]
     */
    constructor(code, message, opts = {}) {
        super(message);
        if (!CODES[code]) throw new Error(`Unknown error code ${code}`);
        this.code = code;
        this.httpStatus = opts.httpStatus || CODES[code].http;
        this.exitCode = CODES[code].exit;
        if (opts.raw !== undefined) this.raw = opts.raw;
        if (opts.retryable) this.retryable = true;
        this.extra = opts.extra || null;
    }
}

/** Any thrown value → a StudioError (unknown errors become INTERNAL with their message). */
function asStudioError(err) {
    if (err instanceof StudioError) return err;
    return new StudioError('INTERNAL', (err && err.message) || 'Internal server error');
}

function errorEnvelope(err) {
    const e = asStudioError(err);
    const out = { success: false, error: e.message, code: e.code };
    if (e.raw !== undefined) out.raw = e.raw;
    if (e.retryable) out.retryable = true;
    if (e.extra) Object.assign(out, e.extra);
    return out;
}

module.exports = { StudioError, asStudioError, errorEnvelope, CODES };
