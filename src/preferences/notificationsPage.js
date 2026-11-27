// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SettingsKey} from '../shared/settings.js';
import {createSpinRow, createSwitchRow} from './rows.js';

// Holds only rows bound to settings, so it has nothing to release.
export const NotificationsPage = GObject.registerClass(
    class NotificationsPage extends Adw.PreferencesPage {
        _init(settings) {
            super._init({
                title: _('Notifications'),
                icon_name: 'preferences-system-notifications-symbolic',
            });

            const lowGroup = new Adw.PreferencesGroup({
                /* Translators: notifications for when little of a usage limit is left. */
                title: _('Limit Running Low'),
            });
            lowGroup.add(
                createSwitchRow(
                    settings,
                    SettingsKey.NOTIFY_LOW_REMAINING,
                    /* Translators: a limit runs low when little of it is left. */
                    _('Notify When a Limit Runs Low'),
                    _('Once per usage window, for the limit shown in the top bar'),
                ),
            );
            lowGroup.add(
                createSpinRow(settings, SettingsKey.LOW_REMAINING_THRESHOLD, {
                    title: _('Notification threshold (%)'),
                    subtitle: _('Remaining percentage that triggers the notification'),
                    enabledBy: SettingsKey.NOTIFY_LOW_REMAINING,
                }),
            );
            this.add(lowGroup);

            const unusedGroup = new Adw.PreferencesGroup({title: _('Unused Usage')});
            unusedGroup.add(
                createSwitchRow(
                    settings,
                    SettingsKey.NOTIFY_UNUSED,
                    _('Remind Me Before Usage Goes Unused'),
                    _('When the current pace would leave usage unused at the reset'),
                ),
            );
            unusedGroup.add(
                createSpinRow(settings, SettingsKey.UNUSED_THRESHOLD, {
                    title: _('Unused share (%)'),
                    subtitle: _('Remind when at least this much would be left at the reset'),
                    enabledBy: SettingsKey.NOTIFY_UNUSED,
                }),
            );
            unusedGroup.add(
                createSpinRow(settings, SettingsKey.UNUSED_HOURS, {
                    title: _('Hours before the reset'),
                    subtitle: _('Remind no earlier than this before the reset'),
                    enabledBy: SettingsKey.NOTIFY_UNUSED,
                }),
            );
            this.add(unusedGroup);

            const resetsGroup = new Adw.PreferencesGroup({title: _('Manual Resets')});
            resetsGroup.add(
                createSwitchRow(
                    settings,
                    SettingsKey.NOTIFY_RESET_EXPIRY,
                    _('Notify Before a Manual Reset Expires'),
                    _('Codex: when a manual reset expires within 48 hours'),
                ),
            );
            this.add(resetsGroup);
        }
    },
);
