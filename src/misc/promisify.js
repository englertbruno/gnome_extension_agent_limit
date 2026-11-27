// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

// Lets the extension await these methods, as GNOME Shell does for its own in
// ui/environment.js. Importing this module applies the change.
Gio._promisify(Gio.AppInfo, 'launch_default_for_uri_async');
Gio._promisify(Gio.DBus, 'get');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'set_attributes_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Soup.Session.prototype, 'send_async');
