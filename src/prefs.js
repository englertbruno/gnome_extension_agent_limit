// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PreferencesView} from './preferences/preferencesView.js';

export default class LimitIndicatorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // The Extensions app requires a page, and shows its error page when this
        // method throws. The view replaces the window's content only once it is
        // built, because that error page is hidden afterwards. The placeholder
        // page is also how the sidebar layout is installed, as in EGO 6682.
        window.add(new Adw.PreferencesPage());
        const view = new PreferencesView(
            this.getSettings(),
            this.metadata.name,
            this.dir.get_child('icons'),
        );

        window.set_default_size(860, 700);
        let closeRequestId = window.connect('close-request', () => {
            window.disconnect(closeRequestId);
            closeRequestId = 0;
            view.release();
            return false;
        });
        window.set_content(view);
    }
}
