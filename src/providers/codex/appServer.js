// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import '../../misc/promisify.js';
import {isRecord} from '../../misc/values.js';
import {createExecutableLauncher, findExecutable, SIGTERM} from '../executable.js';
import {createAppServerError, ErrorKind} from './errors.js';

const REQUEST_TIMEOUT_SECONDS = 20;
const STDERR_TAIL_BYTES = 4096;
const STDERR_DRAIN_MILLISECONDS = 100;
// A message is a few kilobytes; a longer line means a broken or wrapped CLI.
const MAX_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

function requestError(error, method) {
    if (error.method || !method) return error;

    // One failure can reject several requests; copy it rather than mutate it.
    const contextualError = new Error(error.message);
    contextualError.method = method;
    if (typeof error.kind === 'string') contextualError.kind = error.kind;
    if (Number.isFinite(error.code)) contextualError.code = error.code;
    if (typeof error.stderr === 'string') contextualError.stderr = error.stderr;
    return contextualError;
}

// One `codex app-server` process. Single use: after onClosed() the provider
// creates a new connection. A configDirectory selects the login in CODEX_HOME;
// an empty one keeps Codex's default.
export class AppServerConnection {
    constructor({version, configDirectory, executableSearch, onClosed}) {
        this._version = version;
        this._configDirectory = configDirectory;
        this._executableSearch = executableSearch;
        this._onClosed = onClosed;
        this._cancellable = new Gio.Cancellable();
        this._process = null;
        this._input = null;
        this._reader = null;
        this._stderr = null;
        this._nextRequestId = 1;
        this._pending = new Map();
        this._writeChain = Promise.resolve();
        this._readTask = Promise.resolve();
        this._stderrTask = Promise.resolve();
        this._stderrTail = new Uint8Array();
        this._stderrDrainId = 0;
        this._resolveStderrDrain = null;
    }

    /** Called once by the owner, right after construction. */
    async start() {
        const cancellable = this._cancellable;
        try {
            // The user's installed Codex CLI; `codex app-server` speaks JSON-RPC over stdio.
            const executable = await findExecutable('codex', cancellable, this._executableSearch);
            cancellable.set_error_if_cancelled();
            if (!executable)
                throw createAppServerError(
                    ErrorKind.EXECUTABLE_NOT_FOUND,
                    'Codex was not found in PATH.',
                );
            const flags =
                Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE;
            const launcher = createExecutableLauncher(executable, flags);
            if (this._configDirectory) launcher.setenv('CODEX_HOME', this._configDirectory, true);
            this._process = launcher.spawnv([executable, 'app-server']);
            this._input = this._process.get_stdin_pipe();
            this._reader = this._process.get_stdout_pipe();
            this._stderr = this._process.get_stderr_pipe();
            this._readTask = this._readMessages(this._reader, cancellable);
            this._stderrTask = this._readStderr(this._stderr, cancellable);

            await this.request('initialize', {
                clientInfo: {
                    name: 'gnome_extension_codex_limit_indicator',
                    title: 'Agent Usage Indicator',
                    version: this._version,
                },
            });
            cancellable.set_error_if_cancelled();
            await this._queueMessageWrite({method: 'initialized', params: {}});
            cancellable.set_error_if_cancelled();
        } catch (error) {
            if (!cancellable.is_cancelled()) this.destroy(error);
            throw error;
        }
    }

    // Runs once, from the owner or the first failure. Later failures see the
    // cancelled cancellable and do not call it.
    destroy(error = createAppServerError(ErrorKind.PROCESS_CLOSED, 'Codex app-server stopped.')) {
        this._cancellable.cancel();
        this._cancellable = null;
        if (this._stderrTail.length > 0) error.stderr = new TextDecoder().decode(this._stderrTail);
        this._stderrTail = new Uint8Array();

        if (this._stderrDrainId) {
            GLib.Source.remove(this._stderrDrainId);
            this._stderrDrainId = 0;
        }
        const resolveDrain = this._resolveStderrDrain;
        this._resolveStderrDrain = null;
        if (resolveDrain) resolveDrain();
        for (const entry of this._pending.values()) {
            if (entry.timeoutId) {
                GLib.Source.remove(entry.timeoutId);
                entry.timeoutId = 0;
            }
            entry.reject(requestError(error, entry.method));
        }
        this._pending.clear();

        const process = this._process;
        const input = this._input;
        const reader = this._reader;
        const stderr = this._stderr;
        this._process = null;
        this._input = null;
        this._reader = null;
        this._stderr = null;
        // Startup can fail before the process is spawned.
        if (process) {
            // SIGTERM stops the npm wrapper; its native child exits when stdin closes.
            process.send_signal(SIGTERM);
            // Close each pipe after its pending operation settles; closing earlier
            // fails with PENDING and leaves it open.
            this._writeChain
                .then(() => input.close_async(GLib.PRIORITY_DEFAULT, null))
                .catch(closeError =>
                    logError(closeError, 'Failed to close Codex app-server input'),
                );
            this._readTask
                .then(() => reader.close_async(GLib.PRIORITY_DEFAULT, null))
                .catch(closeError =>
                    logError(closeError, 'Failed to close Codex app-server output'),
                );
            this._stderrTask
                .then(() => stderr.close_async(GLib.PRIORITY_DEFAULT, null))
                .catch(closeError =>
                    logError(closeError, 'Failed to close Codex app-server diagnostics'),
                );
        }
        this._writeChain = null;
        this._readTask = null;
        this._stderrTask = null;
        const onClosed = this._onClosed;
        this._onClosed = null;
        onClosed();
    }

    request(method, params) {
        if (!this._process)
            return Promise.reject(
                requestError(
                    createAppServerError(
                        ErrorKind.PROCESS_CLOSED,
                        'Codex app-server is not running.',
                    ),
                    method,
                ),
            );
        const cancellable = this._cancellable;
        const id = this._nextRequestId++;
        const message = {method, id};
        if (params !== undefined) message.params = params;

        const promise = new Promise((resolve, reject) => {
            const entry = {resolve, reject, method, timeoutId: 0};
            entry.timeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                REQUEST_TIMEOUT_SECONDS,
                () => {
                    entry.timeoutId = 0;
                    this.destroy(
                        createAppServerError(
                            ErrorKind.REQUEST_TIMEOUT,
                            'Codex did not respond in time.',
                        ),
                    );
                    return GLib.SOURCE_REMOVE;
                },
            );
            this._pending.set(id, entry);
        });
        this._queueMessageWrite(message).catch(error => {
            if (!cancellable.is_cancelled()) this.destroy(error);
        });
        return promise;
    }

    _queueMessageWrite(message) {
        const cancellable = this._cancellable;
        const input = this._input;
        const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
        const write = this._writeChain
            .then(() => {
                cancellable.set_error_if_cancelled();
                return input.write_all_async(bytes, GLib.PRIORITY_DEFAULT, cancellable);
            })
            .catch(error => {
                throw requestError(error, message.method);
            });
        // Later writes still run after a failed one; the caller gets the rejection.
        this._writeChain = write.then(
            () => undefined,
            () => undefined,
        );
        return write;
    }

    // Returns a function that reads the next line of `reader` in bounded chunks,
    // or null at the end of the stream. Unlike read_line_async() it rejects a
    // line longer than MAX_LINE_BYTES instead of buffering it.
    _createLineReader(reader, cancellable) {
        let buffered = new Uint8Array();
        let ended = false;
        return async () => {
            let scanned = 0;
            while (true) {
                const newline = buffered.indexOf(NEWLINE, scanned);
                if (newline !== -1) {
                    const line = buffered.slice(0, newline);
                    buffered = buffered.slice(newline + 1);
                    return line;
                }
                scanned = buffered.length;
                if (buffered.length > MAX_LINE_BYTES)
                    throw createAppServerError(
                        ErrorKind.INVALID_RESPONSE,
                        'Codex app-server returned too much data.',
                    );
                if (ended || cancellable.is_cancelled()) break;
                const chunk = (
                    await reader.read_bytes_async(
                        READ_CHUNK_BYTES,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                    )
                ).get_data();
                if (chunk.length === 0) {
                    ended = true;
                    continue;
                }
                const joined = new Uint8Array(buffered.length + chunk.length);
                joined.set(buffered);
                joined.set(chunk, buffered.length);
                buffered = joined;
            }
            // An unterminated last line is still a message.
            if (buffered.length === 0) return null;
            const line = buffered;
            buffered = new Uint8Array();
            return line;
        };
    }

    async _readMessages(reader, cancellable) {
        const decoder = new TextDecoder();
        const readLine = this._createLineReader(reader, cancellable);
        try {
            while (!cancellable.is_cancelled()) {
                const lineBytes = await readLine();
                if (cancellable.is_cancelled()) return;
                if (lineBytes === null) {
                    await this._waitForStderrDrain(cancellable);
                    if (cancellable.is_cancelled()) return;
                    throw createAppServerError(
                        ErrorKind.PROCESS_CLOSED,
                        'Codex app-server closed unexpectedly.',
                    );
                }

                let message;
                try {
                    message = JSON.parse(decoder.decode(lineBytes));
                } catch {
                    // Parser errors can quote the response, so use a fixed message.
                    throw createAppServerError(
                        ErrorKind.INVALID_RESPONSE,
                        'Codex app-server returned invalid JSON.',
                    );
                }
                if (!isRecord(message))
                    throw createAppServerError(
                        ErrorKind.INVALID_RESPONSE,
                        'Codex app-server returned an invalid message.',
                    );
                if (Object.hasOwn(message, 'method')) {
                    if (typeof message.method !== 'string')
                        throw createAppServerError(
                            ErrorKind.INVALID_NOTIFICATION,
                            'Codex app-server returned an invalid notification.',
                        );
                    // Server requests have their own IDs; reply that they are unsupported.
                    if (Object.hasOwn(message, 'id')) {
                        this._queueMessageWrite({
                            id: message.id,
                            error: {code: -32601, message: 'Unsupported app-server request.'},
                        }).catch(error => {
                            if (!cancellable.is_cancelled()) this.destroy(error);
                        });
                    }
                    continue;
                }
                if (!Object.hasOwn(message, 'id'))
                    throw createAppServerError(
                        ErrorKind.INVALID_RESPONSE,
                        'Codex app-server returned an invalid response.',
                    );
                const entry = this._pending.get(message.id);
                if (!entry) continue;
                if (!message.error && !Object.hasOwn(message, 'result'))
                    throw createAppServerError(
                        ErrorKind.INVALID_RESPONSE,
                        'Codex app-server returned an invalid response.',
                    );

                this._pending.delete(message.id);
                if (entry.timeoutId) {
                    GLib.Source.remove(entry.timeoutId);
                    entry.timeoutId = 0;
                }
                if (message.error) {
                    const detail = message.error.message;
                    const error = new Error(
                        typeof detail === 'string' && detail
                            ? detail
                            : 'Codex app-server returned an error.',
                    );
                    error.method = entry.method;
                    // JSON-RPC codes are numbers; text could name the account
                    // in the journal, which logs the code.
                    if (Number.isFinite(message.error.code)) error.code = message.error.code;
                    entry.reject(error);
                } else {
                    entry.resolve(message.result);
                }
            }
        } catch (error) {
            if (!cancellable.is_cancelled()) this.destroy(error);
        }
    }

    async _readStderr(stderr, cancellable) {
        try {
            while (!cancellable.is_cancelled()) {
                const bytes = (
                    await stderr.read_bytes_async(
                        STDERR_TAIL_BYTES,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                    )
                ).get_data();
                if (cancellable.is_cancelled()) return;
                if (bytes.length === 0) return;
                // Keep only the tail, even without line breaks.
                const previous = this._stderrTail;
                const retained = Math.min(previous.length, STDERR_TAIL_BYTES - bytes.length);
                const tail = new Uint8Array(retained + bytes.length);
                tail.set(previous.subarray(previous.length - retained));
                tail.set(bytes, retained);
                this._stderrTail = tail;
            }
        } catch (error) {
            if (!cancellable.is_cancelled()) this.destroy(error);
        }
    }

    _waitForStderrDrain(cancellable) {
        // stdout can close before stderr's last read; wait briefly for it.
        return new Promise(resolve => {
            this._resolveStderrDrain = resolve;
            if (this._stderrDrainId) GLib.Source.remove(this._stderrDrainId);
            this._stderrDrainId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                STDERR_DRAIN_MILLISECONDS,
                () => {
                    this._stderrDrainId = 0;
                    this._resolveStderrDrain = null;
                    resolve();
                    return GLib.SOURCE_REMOVE;
                },
            );
            this._stderrTask.then(() => {
                if (cancellable.is_cancelled()) return;
                if (this._stderrDrainId) {
                    GLib.Source.remove(this._stderrDrainId);
                    this._stderrDrainId = 0;
                }
                this._resolveStderrDrain = null;
                resolve();
            });
        });
    }
}
