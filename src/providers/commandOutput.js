// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {codedError} from '../misc/errors.js';
import '../misc/promisify.js';
import {SIGTERM} from './executable.js';

const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MILLISECONDS = 30000;

async function readOutput(output, programName, cancellable) {
    const chunks = [];
    let length = 0;
    while (true) {
        const bytes = (
            await output.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable)
        ).get_data();
        if (bytes.length === 0) break;
        length += bytes.length;
        if (length > MAX_OUTPUT_BYTES)
            throw codedError('output-too-large', `${programName} returned too much output.`);
        chunks.push(bytes);
    }
    // Decode once: a multi-byte character can span two chunks.
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
}

/**
 * Collects the stdout of one running process, bounded in size and time. Its
 * owner destroys it after collect().
 */
export class CommandOutput {
    /**
     * @param {Gio.Subprocess} process Started with a stdout pipe.
     * @param {string} programName Names the program in errors and logs.
     */
    constructor(process, programName) {
        this._process = process;
        this._programName = programName;
        this._output = process.get_stdout_pipe();
        this._cancellable = new Gio.Cancellable();
        this._readTask = null;
        this._timeoutId = 0;
        this._timeoutError = null;
    }

    async collect() {
        const cancellable = this._cancellable;
        const programName = this._programName;
        if (this._timeoutId) GLib.Source.remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MILLISECONDS, () => {
            this._timeoutId = 0;
            this._timeoutError = codedError('timeout', `${programName} did not finish in time.`);
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        try {
            this._readTask = readOutput(this._output, programName, cancellable);
            const [output] = await Promise.all([
                this._readTask,
                this._process.wait_async(cancellable),
            ]);
            cancellable.set_error_if_cancelled();
            return {output, success: this._process.get_successful()};
        } catch (error) {
            if (this._timeoutError) throw this._timeoutError;
            cancellable.set_error_if_cancelled();
            // Read and wait errors can contain paths; report fixed text instead.
            if (error instanceof GLib.Error)
                throw codedError('command-failed', `Unable to run ${programName}.`);
            throw error;
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._process.send_signal(SIGTERM);
        this._process = null;
        // Close after the pending read settles; closing earlier fails with
        // PENDING and leaves the pipe open.
        const output = this._output;
        const programName = this._programName;
        this._readTask
            .catch(() => undefined)
            .then(() => output.close_async(GLib.PRIORITY_DEFAULT, null))
            .catch(error => logError(error, `Failed to close ${programName} output`));
        this._output = null;
        this._readTask = null;
    }
}
