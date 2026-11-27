// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Rows of the account pages. Only these rows write the account keys they
// show, so they do not follow later changes of those keys.

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

/**
 * An entry for a string key that writes the key only when the user applies
 * the text: Shell re-creates an account whenever such a key changes, so a
 * write per keystroke would re-create it for every letter. Text that is not
 * valid is not written, and marks the row until it is edited.
 */
export const SettingEntryRow = GObject.registerClass(
    class SettingEntryRow extends Adw.EntryRow {
        /**
         * @param {Gio.Settings} settings
         * @param {string} key
         * @param {object} options
         * @param {string} options.title
         * @param {function(string): string} [options.normalize]  Applied before validation, such as trimming.
         * @param {function(string): boolean} [options.isValid]
         * @param {string} [options.invalidText]  Tells why text that is not valid was not saved.
         */
        _init(
            settings,
            key,
            {title, normalize = text => text, isValid = () => true, invalidText = ''},
        ) {
            super._init({title, text: settings.get_string(key), show_apply_button: true});
            this._settings = settings;
            this._key = key;
            this._normalize = normalize;
            this._isValid = isValid;

            this._warning = new Gtk.Image({
                icon_name: 'dialog-warning-symbolic',
                tooltip_text: invalidText,
                visible: false,
            });
            this.add_suffix(this._warning);
            this._signalIds = [
                this.connect('apply', () => this._applyText()),
                this.connect('changed', () => this._showValid(true)),
            ];
        }

        release() {
            for (const signalId of this._signalIds) this.disconnect(signalId);
            this._signalIds = [];
            this._settings = null;
        }

        _applyText() {
            const value = this._normalize(this.text);
            if (!this._isValid(value)) {
                this._showValid(false);
                return;
            }
            if (value !== this.text) this.text = value;
            if (value !== this._settings.get_string(this._key))
                this._settings.set_string(this._key, value);
        }

        _showValid(valid) {
            if (valid) this.remove_css_class('error');
            else this.add_css_class('error');
            this._warning.visible = !valid;
        }
    },
);

/** A choice among the values of a string key with choices. */
export const StringChoiceRow = GObject.registerClass(
    class StringChoiceRow extends Adw.ComboRow {
        /**
         * @param {Gio.Settings} settings
         * @param {string} key
         * @param {object} options
         * @param {string} options.title
         * @param {string} [options.subtitle]
         * @param {Array<[string, string]>} options.choices  Each value with its label.
         */
        _init(settings, key, {title, subtitle = '', choices}) {
            const values = choices.map(([value]) => value);
            super._init({
                title,
                subtitle,
                model: Gtk.StringList.new(choices.map(([, label]) => label)),
            });
            this.selected = values.indexOf(settings.get_string(key));
            this._selectedId = this.connect('notify::selected', () =>
                settings.set_string(key, values[this.selected]),
            );
        }

        release() {
            this.disconnect(this._selectedId);
            this._selectedId = 0;
        }
    },
);

/** A row that opens `uri` in the browser when activated. */
export function createLinkRow(title, uri) {
    const button = new Gtk.LinkButton({
        uri,
        icon_name: 'adw-external-link-symbolic',
        tooltip_text: uri,
        valign: Gtk.Align.CENTER,
    });
    const row = new Adw.ActionRow({title, activatable_widget: button});
    row.add_suffix(button);
    return row;
}
