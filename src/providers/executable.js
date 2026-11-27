// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {childNames} from '../misc/files.js';
import '../misc/promisify.js';

// GLib exposes no POSIX signal numbers.
export const SIGTERM = 15;

const EXECUTABLE_ATTRIBUTES = [
    Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
    Gio.FILE_ATTRIBUTE_ACCESS_CAN_EXECUTE,
].join(',');

/**
 * Returns the path of the CLI named `name`, or null when it is not installed.
 * `environment` replaces the searched locations listed in executableCandidates().
 */
export async function findExecutable(name, cancellable, environment) {
    for await (const path of executableCandidates(name, cancellable, environment)) {
        let info;
        try {
            info = await Gio.File.new_for_path(path).query_info_async(
                EXECUTABLE_ATTRIBUTES,
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable,
            );
        } catch (error) {
            if (isExpectedLookupError(error)) continue;
            throw error;
        }
        cancellable.set_error_if_cancelled();

        if (
            info.get_file_type() === Gio.FileType.REGULAR &&
            info.get_attribute_boolean(Gio.FILE_ATTRIBUTE_ACCESS_CAN_EXECUTE)
        )
            return path;
    }

    return null;
}

/**
 * The CLI runs outside any project, in the user's private runtime directory,
 * which other users cannot write to. npm CLIs start with `#!/usr/bin/env node`,
 * so the executable's directory is prepended to the child's PATH.
 */
export function createExecutableLauncher(executable, flags) {
    const launcher = new Gio.SubprocessLauncher({flags});
    launcher.set_cwd(GLib.get_user_runtime_dir());
    const directory = GLib.path_get_dirname(GLib.canonicalize_filename(executable, null));
    const inheritedPath = GLib.getenv('PATH') ?? '/usr/local/bin:/usr/bin:/bin';
    launcher.setenv('PATH', `${directory}${GLib.SEARCHPATH_SEPARATOR_S}${inheritedPath}`, true);
    return launcher;
}

async function* executableCandidates(
    name,
    cancellable,
    {
        home = GLib.get_home_dir(),
        path = GLib.getenv('PATH') ?? '',
        nvmDir = GLib.getenv('NVM_DIR'),
        fallbackDirectories = [
            GLib.build_filenamev([home, '.local', 'bin']),
            GLib.build_filenamev([home, '.npm-global', 'bin']),
            GLib.build_filenamev([home, '.local', 'share', 'pnpm']),
            '/usr/local/bin',
        ],
    } = {},
) {
    // Empty and relative PATH entries depend on the working directory; skip them.
    const directories = path
        .split(GLib.SEARCHPATH_SEPARATOR_S)
        .filter(directory => GLib.path_is_absolute(directory));
    yield* new Set(
        [...directories, ...fallbackDirectories].map(directory =>
            GLib.build_filenamev([directory, name]),
        ),
    );

    // Shell's PATH lacks NVM's shell setup: try its current link, then the
    // newest version.
    const nvm = nvmDir || GLib.build_filenamev([home, '.nvm']);
    yield GLib.build_filenamev([nvm, 'current', 'bin', name]);
    const versionsDirectory = GLib.build_filenamev([nvm, 'versions', 'node']);
    const versions = (await versionNames(versionsDirectory, cancellable))
        .filter(name => /^v\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => {
            const left = a.slice(1).split('.').map(Number);
            const right = b.slice(1).split('.').map(Number);
            return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
        });
    for (const version of versions)
        yield GLib.build_filenamev([versionsDirectory, version, 'bin', name]);
}

// The names in NVM's versions directory; none when it is missing, is not a
// directory or may not be read.
async function versionNames(path, cancellable) {
    try {
        return await childNames(Gio.File.new_for_path(path), cancellable);
    } catch (error) {
        if (isExpectedLookupError(error)) return [];
        throw error;
    }
}

function isExpectedLookupError(error) {
    return [
        Gio.IOErrorEnum.NOT_FOUND,
        Gio.IOErrorEnum.NOT_DIRECTORY,
        Gio.IOErrorEnum.PERMISSION_DENIED,
    ].some(code => error.matches(Gio.IOErrorEnum, code));
}
