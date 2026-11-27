// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

// Lets the preferences await these methods, which GNOME Shell promisifies only
// in its own process. Importing this module applies the change.
Gio._promisify(Gio.DBus, 'get');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');
