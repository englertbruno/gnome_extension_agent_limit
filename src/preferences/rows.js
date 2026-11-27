// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

/** An Adw.SwitchRow bound to a boolean key. */
export function createSwitchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/**
 * An Adw.SpinRow bound to a numeric key, within the key's schema range.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {number} [options.lower] Raises the schema's minimum.
 * @param {number} [options.step]
 * @param {string|null} [options.enabledBy] Boolean key that makes the row
 *     sensitive; the value binding then leaves sensitivity alone.
 */
export function createSpinRow(
    settings,
    key,
    {title, subtitle = '', lower, step = 1, enabledBy = null},
) {
    const [, [minimum, maximum]] = settings.settings_schema
        .get_key(key)
        .get_range()
        .recursiveUnpack();
    const row = new Adw.SpinRow({
        title,
        subtitle,
        digits: 0,
        adjustment: new Gtk.Adjustment({
            lower: lower ?? minimum,
            upper: maximum,
            step_increment: step,
            page_increment: step * 10,
        }),
    });
    if (enabledBy === null) {
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    } else {
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.NO_SENSITIVITY);
        settings.bind(enabledBy, row, 'sensitive', Gio.SettingsBindFlags.GET);
    }
    return row;
}

/** An Adw.ComboRow whose position in choices is bound to an integer key. */
export function createComboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(choices)});
    settings.bind(key, row, 'selected', Gio.SettingsBindFlags.DEFAULT);
    return row;
}
