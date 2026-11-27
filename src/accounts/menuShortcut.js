// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SettingsKey} from '../shared/settings.js';
import {LimitIndicator} from '../ui/limitIndicator.js';

// As Panel._toggleMenu() does for Shell's own shortcuts, except that it
// closes whichever account's menu is open, as after Right moved to the second
// account, and opens the first account's only when none is. The top bar is
// hidden over fullscreen windows, and a menu opens only from a visible
// indicator.
function toggleMenu(indicator) {
    const openMenu = Main.panel.menuManager.activeMenu;
    if (openMenu?.sourceActor instanceof LimitIndicator) {
        openMenu.close();
        return;
    }
    if (indicator === null || !indicator.mapped) return;
    const {menu} = indicator;
    menu.toggle();
    if (menu.isOpen) menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
}

/**
 * The keyboard shortcut in `toggle-agent-usage-menu`, which opens the first
 * account's menu and closes whichever account's menu is open as Shell's own shortcut toggles quick settings.
 * Mutter follows changes to the key; an empty key binds nothing.
 */
export class MenuShortcut {
    /**
     * @param {Gio.Settings} settings  The extension's settings.
     * @param {function(): (PanelMenu.Button|null)} firstIndicator  The first running account's indicator.
     */
    constructor(settings, firstIndicator) {
        Main.wm.addKeybinding(
            SettingsKey.TOGGLE_MENU_SHORTCUT,
            settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            // In POPUP, so that the same key closes the menu.
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => toggleMenu(firstIndicator()),
        );
    }

    destroy() {
        Main.wm.removeKeybinding(SettingsKey.TOGGLE_MENU_SHORTCUT);
    }
}
