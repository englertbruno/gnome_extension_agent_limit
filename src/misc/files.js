// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {codedError} from './errors.js';
import './promisify.js';

/**
 * Returns the names of the directory's children; none when it is missing.
 * Rejects with Gio's error when it cannot be listed.
 */
export async function childNames(directory, cancellable) {
    let enumerator;
    try {
        enumerator = await directory.enumerate_children_async(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            cancellable,
        );
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return [];
        throw error;
    }
    const names = [];
    try {
        while (true) {
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable);
            if (infos.length === 0) return names;
            names.push(...infos.map(info => info.get_name()));
        }
    } finally {
        // Close without the cancellable so cancellation cannot leak the enumerator.
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
    }
}

/**
 * Returns the contents of a regular file of at most `maxBytes`. The type and
 * size are checked first: a device or a huge file would grow Shell's memory
 * without bound. Rejects with Gio's error when the file is missing or cannot
 * be read, and with an 'unusable-file' error when it is of another type or
 * larger.
 */
export async function loadRegularFile(file, maxBytes, cancellable) {
    const unusable = () =>
        codedError('unusable-file', 'The file is not a regular file of an accepted size');
    const info = await file.query_info_async(
        `${Gio.FILE_ATTRIBUTE_STANDARD_TYPE},${Gio.FILE_ATTRIBUTE_STANDARD_SIZE}`,
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        GLib.PRIORITY_DEFAULT,
        cancellable,
    );
    if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > maxBytes)
        throw unusable();
    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
    try {
        // The file can grow after the query; one byte past the limit shows it.
        let contents = new Uint8Array();
        while (contents.length <= maxBytes) {
            const chunk = (
                await stream.read_bytes_async(
                    maxBytes + 1 - contents.length,
                    GLib.PRIORITY_DEFAULT,
                    cancellable,
                )
            ).get_data();
            if (chunk.length === 0) return contents;
            const joined = new Uint8Array(contents.length + chunk.length);
            joined.set(contents);
            joined.set(chunk, contents.length);
            contents = joined;
        }
        throw unusable();
    } finally {
        // Close without the cancellable so cancellation cannot leak the stream.
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    }
}
