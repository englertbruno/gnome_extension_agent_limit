// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {HEX_COLOR_PATTERN} from '../shared/settings.js';

export const CustomColorRow = GObject.registerClass(
    class CustomColorRow extends Adw.ActionRow {
        _init(index, onColorChanged) {
            const minimum = `${index === 0 ? 0 : index * 10 + 1}%`;
            const maximum = `${(index + 1) * 10}%`;
            super._init({
                /* Translators: %1$s and %2$s are percentages, the bounds of a range, such as 0%–10%. */
                title: _('%1$s–%2$s remaining').format(minimum, maximum),
                subtitle: _('Set the level color for this range'),
            });

            this._onColorChanged = onColorChanged;
            this._syncing = false;

            this._entry = new Gtk.Entry({
                halign: Gtk.Align.END,
                max_length: 7,
                valign: Gtk.Align.CENTER,
                width_chars: 7,
            });
            this._entry.add_css_class('monospace');
            this._entry.set_tooltip_text(_('Hex color in #RRGGBB format'));
            this._entry.update_property(
                [Gtk.AccessibleProperty.LABEL],
                /* Translators: %1$s and %2$s are percentages, the bounds of a range, such as 0%–10%. */
                [_('Hex color for %1$s–%2$s remaining').format(minimum, maximum)],
            );

            this._colorButton = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}),
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER,
            });
            /* Translators: %1$s and %2$s are percentages, the bounds of a range, such as 0%–10%. */
            const chooseLabel = _('Choose a Color for %1$s–%2$s Remaining').format(
                minimum,
                maximum,
            );
            this._colorButton.set_tooltip_text(chooseLabel);
            this._colorButton.update_property([Gtk.AccessibleProperty.LABEL], [chooseLabel]);

            this.add_suffix(this._entry);
            this.add_suffix(this._colorButton);

            this._entryChangedId = this._entry.connect('changed', () => this._entryChanged());
            this._colorChangedId = this._colorButton.connect('notify::rgba', () =>
                this._colorButtonChanged(),
            );
        }

        setColor(color) {
            this._syncing = true;
            this._entry.text = color;
            this._entry.remove_css_class('error');
            this._colorButton.rgba = this._rgbaFromHex(color);
            this._syncing = false;
        }

        release() {
            this._entry.disconnect(this._entryChangedId);
            this._entryChangedId = 0;
            this._colorButton.disconnect(this._colorChangedId);
            this._colorChangedId = 0;

            this._onColorChanged = null;
            this._entry = null;
            this._colorButton = null;
        }

        _entryChanged() {
            if (this._syncing) return;

            const value = this._entry.text.trim();
            if (!HEX_COLOR_PATTERN.test(value)) {
                this._entry.add_css_class('error');
                return;
            }

            this._entry.remove_css_class('error');
            this._onColorChanged(value.toLowerCase());
        }

        _colorButtonChanged() {
            if (this._syncing) return;

            const rgba = this._colorButton.rgba;
            const channels = [rgba.red, rgba.green, rgba.blue].map(channel =>
                Math.round(channel * 255)
                    .toString(16)
                    .padStart(2, '0'),
            );
            this._onColorChanged(`#${channels.join('')}`);
        }

        _rgbaFromHex(color) {
            return new Gdk.RGBA({
                red: Number.parseInt(color.slice(1, 3), 16) / 255,
                green: Number.parseInt(color.slice(3, 5), 16) / 255,
                blue: Number.parseInt(color.slice(5, 7), 16) / 255,
                alpha: 1,
            });
        }
    },
);
