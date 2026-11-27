// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import './promisify.js';

/**
 * Asks for the configuration directory of a CLI.
 *
 * @param {Gtk.Widget} widget  A widget of the window that the dialog belongs to.
 * @param {string} startDirectory  The folder the dialog opens in; '' leaves it to the dialog.
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<string|null>} The chosen folder's path. Null when none was chosen, and for a folder without a
 *     local path, such as one on a remote share, which cannot be given to the CLI.
 */
export async function chooseConfigurationDirectory(widget, startDirectory, cancellable) {
    const dialog = new Gtk.FileDialog({title: _('Choose Configuration Directory')});
    if (startDirectory !== '') dialog.initial_folder = Gio.File.new_for_path(startDirectory);
    try {
        return (await dialog.select_folder(widget.get_root(), cancellable)).get_path();
    } catch (error) {
        if (
            !cancellable.is_cancelled() &&
            !error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)
        )
            logError(error, 'Cannot choose a configuration directory');
        return null;
    }
}
