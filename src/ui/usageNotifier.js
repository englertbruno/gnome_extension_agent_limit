// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Shows an account's notifications under its own message-tray source, created
// on first use. Shell destroys the source once its last notification is gone.
export class UsageNotifier {
    constructor({title, iconFile}) {
        this._title = title;
        this._iconFile = iconFile;
        this._source = null;
        this._sourceDestroyId = 0;
    }

    /** @param {{title: string, body: string}} notification From accounts/presentation.js. */
    show({title, body}) {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: this._title,
                icon: new Gio.FileIcon({file: this._iconFile}),
            });
            this._sourceDestroyId = this._source.connect('destroy', source => {
                source.disconnect(this._sourceDestroyId);
                this._source = null;
                this._sourceDestroyId = 0;
            });
            Main.messageTray.add(this._source);
        }
        this._source.addNotification(
            new MessageTray.Notification({source: this._source, title, body}),
        );
    }

    destroy() {
        if (this._source) {
            this._source.disconnect(this._sourceDestroyId);
            this._source.destroy();
        }
        this._source = null;
        this._sourceDestroyId = 0;
        this._iconFile = null;
    }
}
