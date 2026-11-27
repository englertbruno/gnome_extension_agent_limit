// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {
    Extension,
    gettext,
    ngettext,
    pgettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AccountManager} from './accounts/accountManager.js';

export default class CodexLimitIndicatorExtension extends Extension {
    enable() {
        this._accountManager = new AccountManager({
            extension: this,
            settings: this.getSettings(),
            i18n: {gettext, ngettext, pgettext},
        });
        this._accountManager.start();
    }

    disable() {
        this._accountManager.destroy();
        this._accountManager = null;
    }
}
