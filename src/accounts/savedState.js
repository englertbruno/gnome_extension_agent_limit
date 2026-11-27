// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {wallSeconds} from '../misc/clock.js';
import {sha256} from '../misc/digest.js';
import {codedError} from '../misc/errors.js';
import {childNames, loadRegularFile} from '../misc/files.js';
import '../misc/promisify.js';
import {ACCOUNT_SLOTS} from '../shared/accountSettings.js';
import {
    MAX_HISTORY_FILE_BYTES,
    MAX_READING_FILE_BYTES,
    parseSavedHistory,
    parseSavedReading,
    serializeSavedHistory,
    serializeSavedReading,
} from './savedStateFormat.js';

// Queued in place of file contents to delete the file.
const DELETE = Symbol('delete');
// Written to a temporary file that replaces the destination, with mode 0600
// even when an existing file had another mode.
const PRIVATE_FILE_FLAGS = Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;

const EMPTY_READING = Object.freeze({
    reading: null,
    readAt: null,
    requestedAt: null,
    retryAt: null,
    providerState: null,
    notified: null,
});

/**
 * The state an account saved in an earlier session: the fields of its
 * reading file, null when that file is missing or not usable, and its
 * history, null likewise.
 *
 * @typedef {SavedReading & {history: UsageHistory|null}} SavedAccount
 */

const readingFileName = slot => `${slot}.json`;
const historyFileName = slot => `${slot}-history.json`;
// The temporary file GIO writes a replacement to before renaming it.
const TEMPORARY_FILE_NAME = /^\.goutputstream-[A-Za-z0-9]{6}$/;

/**
 * Returns the contents of a regular file of at most `maxBytes`, or null when
 * the file is missing, larger, of another type or cannot be read.
 */
async function loadFile(file, maxBytes, cancellable) {
    try {
        return await loadRegularFile(file, maxBytes, cancellable);
    } catch (error) {
        if (cancellable.is_cancelled()) throw error;
        return null;
    }
}

// Creates the directory and missing parents with mode 0700, as the XDG base
// directory specification asks. Existing directories keep their mode.
async function makePrivateDirectory(directory, cancellable) {
    try {
        await directory.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) return;
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error;
        await makePrivateDirectory(directory.get_parent(), cancellable);
        try {
            await directory.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
        } catch (secondError) {
            // Another slot saving at once created it first.
            if (!secondError.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) throw secondError;
        }
    }
    const info = new Gio.FileInfo();
    info.set_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o700);
    await directory.set_attributes_async(
        info,
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        GLib.PRIORITY_DEFAULT,
        cancellable,
    );
}

/** Replaces the file atomically, creating its directory when it is missing. */
async function writePrivateFile(file, contents, cancellable) {
    const bytes = new GLib.Bytes(contents);
    try {
        await file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            PRIVATE_FILE_FLAGS,
            cancellable,
        );
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error;
        await makePrivateDirectory(file.get_parent(), cancellable);
        await file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            PRIVATE_FILE_FLAGS,
            cancellable,
        );
    }
}

async function deleteFile(file, cancellable) {
    try {
        await file.delete_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error;
    }
}

/**
 * Keeps each account's last reading in the user's cache directory and its
 * usage history in the user's state directory, one private file each. Saves
 * and deletions run in the background, in order per file; the store cancels
 * them when it is destroyed. A write cancelled while it opens its file can
 * leave the file empty, which loads as unusable.
 */
export class SavedStateStore {
    /** @param {{cacheDirectory: string, stateDirectory: string}} directories The extension's own. */
    constructor({cacheDirectory, stateDirectory}) {
        this._cacheDirectory = Gio.File.new_for_path(cacheDirectory);
        this._stateDirectory = Gio.File.new_for_path(stateDirectory);
        this._cancellable = new Gio.Cancellable();
        // Path → {next, finished} while operations on that file run: next is
        // the newest contents queued for it, DELETE or null, and finished
        // resolves when they have run.
        this._operations = new Map();
        this._failureLogged = false;
    }

    /**
     * Reads the state the slot saved for the provider configuration
     * `configKey`, after the saves and deletions queued for the slot have
     * run. Rejects only when `cancellable` is cancelled.
     *
     * @returns {Promise<SavedAccount|null>} Null when neither file is usable.
     */
    async loadAccount(slot, configKey, cancellable) {
        const readingFile = this._cacheDirectory.get_child(readingFileName(slot));
        const historyFile = this._stateDirectory.get_child(historyFileName(slot));
        await Promise.all(
            [readingFile, historyFile].map(file => this._operations.get(file.get_path())?.finished),
        );
        const [readingContents, historyContents] = await Promise.all([
            loadFile(readingFile, MAX_READING_FILE_BYTES, cancellable),
            loadFile(historyFile, MAX_HISTORY_FILE_BYTES, cancellable),
        ]);
        const config = sha256(configKey);
        const saved =
            readingContents === null
                ? null
                : parseSavedReading(readingContents, {
                      config,
                      nowSeconds: Math.floor(wallSeconds()),
                  });
        const history =
            historyContents === null ? null : parseSavedHistory(historyContents, {config});
        if (saved === null && history === null) return null;
        return {...(saved ?? EMPTY_READING), history};
    }

    /**
     * @param {SavedReading} saved Replaces a save of the slot still waiting.
     * @returns {Promise<boolean>} Resolves once the queued writes of the file
     * have run, to whether the newest was written; to false when the store
     * was destroyed first or the reading is too large. Never rejects.
     */
    saveAccount(slot, configKey, saved) {
        const contents = serializeSavedReading(saved, {
            config: sha256(configKey),
            savedAt: Math.floor(wallSeconds()),
        });
        if (contents !== null)
            return this._queue(this._cacheDirectory.get_child(readingFileName(slot)), contents);
        this._reportFailure(codedError('too-large', 'The usage reading is too large to save'));
        return Promise.resolve(false);
    }

    /** @param {UsageHistory} history Replaces a save of the slot still waiting. */
    saveHistory(slot, configKey, history) {
        const contents = serializeSavedHistory(history, {config: sha256(configKey)});
        if (contents === null)
            this._reportFailure(codedError('too-large', 'The usage history is too large to save'));
        else this._queue(this._stateDirectory.get_child(historyFileName(slot)), contents);
    }

    /** Deletes both files of the slot. */
    forget(slot) {
        this._queue(this._cacheDirectory.get_child(readingFileName(slot)), DELETE);
        this._queue(this._stateDirectory.get_child(historyFileName(slot)), DELETE);
    }

    /** Deletes the slot's history file, as when history is turned off. */
    forgetHistory(slot) {
        this._queue(this._stateDirectory.get_child(historyFileName(slot)), DELETE);
    }

    /**
     * Deletes the files of every slot not in `slots`, and the temporary
     * files an interrupted write left. Other files in the directories are
     * kept. Called at start, before anything is saved.
     *
     * @returns {Promise<void>} Resolves once the deletions are queued, so
     * that a load or save of a slot after it comes after them; never rejects.
     */
    async prune(slots) {
        const removed = ACCOUNT_SLOTS.filter(slot => !slots.includes(slot));
        await Promise.all([
            this._pruneDirectory(this._cacheDirectory, removed.map(readingFileName)),
            this._pruneDirectory(this._stateDirectory, removed.map(historyFileName)),
        ]);
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
        this._operations = null;
        this._cacheDirectory = null;
        this._stateDirectory = null;
    }

    async _pruneDirectory(directory, removedNames) {
        const cancellable = this._cancellable;
        let names;
        try {
            names = await childNames(directory, cancellable);
        } catch (error) {
            if (!cancellable.is_cancelled()) this._reportFailure(error);
            return;
        }
        if (cancellable.is_cancelled()) return;
        for (const name of names) {
            if (removedNames.includes(name) || TEMPORARY_FILE_NAME.test(name))
                this._queue(directory.get_child(name), DELETE);
        }
    }

    // Returns the promise that resolves when the operations on the file have
    // run, to whether the newest succeeded.
    _queue(file, next) {
        const path = file.get_path();
        const running = this._operations.get(path);
        if (running) {
            running.next = next;
            return running.finished;
        }
        const operation = {next, finished: null};
        this._operations.set(path, operation);
        operation.finished = this._runOperations(path, file, operation);
        return operation.finished;
    }

    // Runs the operations queued for one file in order and returns whether
    // the last succeeded. Failures are logged, never thrown.
    async _runOperations(path, file, operation) {
        const cancellable = this._cancellable;
        let succeeded = false;
        while (operation.next !== null) {
            const next = operation.next;
            operation.next = null;
            try {
                if (next === DELETE) await deleteFile(file, cancellable);
                else await writePrivateFile(file, next, cancellable);
                succeeded = true;
            } catch (error) {
                succeeded = false;
                if (!cancellable.is_cancelled()) this._reportFailure(error);
            }
            if (cancellable.is_cancelled()) return false;
        }
        this._operations.delete(path);
        return succeeded;
    }

    // The first failure is logged; later ones usually have the same cause.
    // Only the error's domain and code are logged: a Gio error's text holds
    // the full path of the file, with the user name or a private XDG path.
    _reportFailure(error) {
        if (this._failureLogged) return;
        this._failureLogged = true;
        const cause =
            error instanceof GLib.Error
                ? `${GLib.quark_to_string(error.domain)} ${error.code}`
                : (error.code ?? 'unknown');
        logError(new Error(`Failed to save the usage state (${cause})`));
    }
}
