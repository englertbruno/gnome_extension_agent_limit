// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SettingsKey} from '../shared/settings.js';
import {createSpinRow, createSwitchRow} from './rows.js';
import {ShortcutRow} from './shortcutRow.js';

export const BehaviorPage = GObject.registerClass(
    class BehaviorPage extends Adw.PreferencesPage {
        _init(settings) {
            super._init({
                title: _('Menu and Behavior'),
                icon_name: 'preferences-system-symbolic',
            });

            const menuGroup = new Adw.PreferencesGroup({title: _('Menu')});
            menuGroup.add(
                createSwitchRow(
                    settings,
                    SettingsKey.SHOW_RESET_CLOCK,
                    _('Show Reset Clock Time'),
                    _('Show the time of day beside long countdowns'),
                ),
            );
            menuGroup.add(
                createSwitchRow(
                    settings,
                    SettingsKey.SHOW_HISTORY,
                    _('Show Usage History'),
                    _(
                        'Record usage in ~/.local/state and chart it; turning this off deletes the record',
                    ),
                ),
            );
            this.add(menuGroup);

            const behaviorGroup = new Adw.PreferencesGroup({title: _('Behavior')});
            behaviorGroup.add(
                createSpinRow(settings, SettingsKey.GRACE_PERIOD, {
                    /* Translators: row title; the value is a number of seconds that temporary failures are hidden. */
                    title: _('Grace period (seconds)'),
                    subtitle: _(
                        'Hide temporary failures before marking the last reading stale; 0 disables grace',
                    ),
                    step: 30,
                }),
            );
            this._shortcutRow = new ShortcutRow(settings);
            behaviorGroup.add(this._shortcutRow);
            this.add(behaviorGroup);
        }

        release() {
            this._shortcutRow.release();
            this._shortcutRow = null;
        }
    },
);
