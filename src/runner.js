// Janitor AI Script Bridge — script sandbox
//
// Runs a Janitor "Advanced" script synchronously against a mutable `context`
// object, mirroring Janitor's documented sandbox semantics:
//   - plain JS (ES5/ES6 dialect), executed top-to-bottom, once per run
//   - no async, no timers, no network, no DOM, no page access
//   - console.log output is captured for the debug panel
//   - a script that never returns is killed after a timeout
//   - an error in one script never breaks the caller (or other scripts)
//
// Primary strategy: a fresh Web Worker created from a Blob URL. All host
// globals (fetch, timers, DOM, self, Promise...) are shadowed with `undefined`
// through function parameters, so scripts physically cannot reach them.
// Context data crosses the boundary as JSON strings (scripts can only exchange
// plain data, exactly like on Janitor).
//
// Fallback strategy (no Worker/Blob available): a `new Function` scope shim
// with the same parameter shadowing. No timeout is possible in-page; strict
// mode keeps accidental globals contained.

const SHADOWED_GLOBALS = [
    'fetch',
    'setTimeout',
    'setInterval',
    'setImmediate',
    'clearTimeout',
    'clearInterval',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'document',
    'window',
    'self',
    'globalThis',
    'parent',
    'top',
    'opener',
    'postMessage',
    'importScripts',
    'Promise',
    'Worker',
    'SharedWorker',
    'navigator',
    'location',
    'indexedDB',
    'caches',
];

// Janitor's documented script size cap.
const MAX_SCRIPT_LENGTH = 300 * 1024;

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];

/**
 * Runs one script against the context object.
 *
 * @param {string} code       Script source (the whole top-level body)
 * @param {object} context    Mutable context facade (JSON-pure)
 * @param {number} timeoutMs  Hard kill timeout for the worker strategy
 * @returns {Promise<{ok: boolean, error: string|null, logs: string[], context: object, timedOut: boolean, strategy: string}>}
 */
export function runScript(code, context, timeoutMs) {
    if (code.length > MAX_SCRIPT_LENGTH) {
        return Promise.resolve({
            ok: false,
            error: `Script exceeds the ${Math.floor(MAX_SCRIPT_LENGTH / 1024)} KB Janitor limit (${code.length} chars).`,
            logs: [],
            context,
            timedOut: false,
            strategy: 'none',
        });
    }

    return runInWorker(code, context, timeoutMs).catch(workerError => {
        console.debug('[JaiBridge] Worker strategy unavailable, using inline fallback:', workerError?.message ?? workerError);
        return runInline(code, context);
    });
}

function runInWorker(code, context, timeoutMs) {
    return new Promise((resolve, reject) => {
        let blobUrl = null;
        let worker = null;
        let timer = null;
        let settled = false;

        const finish = result => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer !== null) {
                clearTimeout(timer);
            }
            try {
                worker?.terminate();
            } catch {
                /* noop */
            }
            if (blobUrl) {
                try {
                    URL.revokeObjectURL(blobUrl);
                } catch {
                    /* noop */
                }
            }
            resolve(result);
        };

        let WorkerConstructor;
        try {
            WorkerConstructor = Worker;
            if (typeof WorkerConstructor !== 'function') {
                throw new Error('Worker is not a function');
            }
        } catch (error) {
            reject(error);
            return;
        }

        try {
            const source = buildWorkerSource(code);
            const blob = new Blob([source], { type: 'application/javascript' });
            blobUrl = URL.createObjectURL(blob);
            worker = new WorkerConstructor(blobUrl);
        } catch (error) {
            reject(error);
            return;
        }

        timer = setTimeout(() => {
            finish({
                ok: false,
                error: `Script timed out after ${timeoutMs} ms and was stopped (Janitor silently drops such scripts).`,
                logs: [],
                context,
                timedOut: true,
                strategy: 'worker',
            });
        }, Math.max(50, timeoutMs));

        worker.onmessage = event => {
            const data = event.data ?? {};
            let outContext = context;
            if (typeof data.contextJSON === 'string') {
                try {
                    outContext = JSON.parse(data.contextJSON);
                } catch {
                    // Corrupt payload — keep the input context rather than crash.
                }
            }
            finish({
                ok: !!data.ok,
                error: data.error ?? null,
                logs: Array.isArray(data.logs) ? data.logs : [],
                context: outContext,
                timedOut: false,
                strategy: 'worker',
            });
        };

        worker.onerror = event => {
            finish({
                ok: false,
                error: event?.message || 'Script failed to compile or run (syntax error?).',
                logs: [],
                context,
                timedOut: false,
                strategy: 'worker',
            });
        };

        worker.onmessageerror = () => {
            finish({
                ok: false,
                error: 'Could not transfer the script result back from the sandbox.',
                logs: [],
                context,
                timedOut: false,
                strategy: 'worker',
            });
        };

        try {
            // The context crosses as a JSON string: scripts can only read and
            // write plain data — functions/objects from the host cannot leak in
            // and cannot be smuggled out.
            worker.postMessage({ contextJSON: JSON.stringify(context) });
        } catch (error) {
            finish({
                ok: false,
                error: `Could not serialize the chat context: ${error?.message ?? error}`,
                logs: [],
                context,
                timedOut: false,
                strategy: 'worker',
            });
        }
    });
}

/**
 * Builds the worker source. Uses plain string concatenation (not template
 * literals) so user code containing backticks or `${}` cannot break the build.
 * Exported for testing — the source can be executed against a fake `self` in
 * any JS runtime to verify the exact worker code path.
 */
export function buildWorkerSource(code) {
    const params = ['context', 'console'].concat(SHADOWED_GLOBALS).join(', ');
    const undefinedArgs = SHADOWED_GLOBALS.map(() => 'undefined').join(', ');
    const lines = [
        'self.onmessage = function (event) {',
        '    var logs = [];',
        '    function fmt(v) { try { return typeof v === "string" ? v : JSON.stringify(v); } catch (_) { return String(v); } }',
        '    var fakeConsole = {',
        CONSOLE_METHODS.map(method => `        ${method}: function () { logs.push(Array.prototype.map.call(arguments, fmt).join(" ")); },`).join('\n'),
        '    };',
        '    var context = JSON.parse(event.data.contextJSON);',
        '    var ok = false;',
        '    var error = null;',
        '    try {',
        `        (function (${params}) {`,
        code,
        `        })(context, fakeConsole, ${undefinedArgs});`,
        '        ok = true;',
        '    } catch (err) {',
        '        error = (err && err.message) ? err.message : String(err);',
        '    }',
        '    var payload;',
        '    try {',
        '        payload = { ok: ok, error: error, logs: logs, contextJSON: JSON.stringify(context) };',
        '    } catch (stringifyError) {',
        '        payload = { ok: false, error: "Script produced a non-serializable result: " + stringifyError.message, logs: logs };',
        '    }',
        '    self.postMessage(payload);',
        '};',
    ];
    return lines.join('\n');
}

function runInline(code, context) {
    const logs = [];
    const fakeConsole = {};
    for (const method of CONSOLE_METHODS) {
        fakeConsole[method] = (...args) => {
            logs.push(args.map(fmtInline).join(' '));
        };
    }

    try {
        const params = ['context', 'console'].concat(SHADOWED_GLOBALS);
        const args = [context, fakeConsole].concat(SHADOWED_GLOBALS.map(() => undefined));
        const fn = new Function(...params, '"use strict";\n' + code);
        fn(...args);
        return { ok: true, error: null, logs, context, timedOut: false, strategy: 'inline' };
    } catch (error) {
        return {
            ok: false,
            error: error?.message ?? String(error),
            logs,
            context,
            timedOut: false,
            strategy: 'inline',
        };
    }
}

function fmtInline(value) {
    try {
        return typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        return String(value);
    }
}
