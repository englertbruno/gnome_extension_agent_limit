// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SettingsKey} from '../shared/settings.js';

/**
 * Shows the keyboard shortcut that opens the first account's menu. Activating
 * the row asks for a new one; Backspace there removes it.
 */
export const ShortcutRow = GObject.registerClass(
    class ShortcutRow extends Adw.ActionRow {
        _init(settings) {
            super._init({
                title: _('Keyboard shortcut'),
                subtitle: _(
                    'Opens the menu of the first account; Left and Right move to the others',
                ),
                activatable: true,
            });

            this._settings = settings;
            this._shortcutLabel = new Adw.ShortcutLabel({
                disabled_text: _('Disabled'),
                valign: Gtk.Align.CENTER,
            });
            this.add_suffix(this._shortcutLabel);
            this._syncShortcut();

            this._activatedId = this.connect('activated', () => this._askForShortcut());
            this._settingsChangedId = this._settings.connect(
                `changed::${SettingsKey.TOGGLE_MENU_SHORTCUT}`,
                () => this._syncShortcut(),
            );
        }

        release() {
            this.disconnect(this._activatedId);
            this._activatedId = 0;
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;

            this._settings = null;
            this._shortcutLabel = null;
        }

        _syncShortcut() {
            this._shortcutLabel.accelerator =
                this._settings.get_strv(SettingsKey.TOGGLE_MENU_SHORTCUT)[0] ?? '';
        }

        // The dialog sees keys before its buttons do. Keys that make no
        // shortcut, such as Escape, Tab and Enter, still reach the buttons.
        _askForShortcut() {
            const dialog = new Adw.AlertDialog({
                heading: _('Set Shortcut'),
                body: _(
                    'Press a key combination with Ctrl, Alt or Super, or Backspace to remove the shortcut',
                ),
            });
            dialog.add_response('cancel', _('Cancel'));
            const controller = new Gtk.EventControllerKey({
                propagation_phase: Gtk.PropagationPhase.CAPTURE,
            });
            dialog.add_controller(controller);
            const keyPressedId = controller.connect(
                'key-pressed',
                (_controller, keyval, keycode, state) =>
                    this._shortcutKeyPressed(dialog, keyval, keycode, state),
            );
            const closedId = dialog.connect('closed', () => {
                controller.disconnect(keyPressedId);
                dialog.disconnect(closedId);
            });
            dialog.present(this);
        }

        _shortcutKeyPressed(dialog, keyval, keycode, state) {
            const modifiers = state & Gtk.accelerator_get_default_mod_mask();
            let shortcut;
            if (modifiers === 0 && keyval === Gdk.KEY_BackSpace) {
                shortcut = [];
            } else if (
                // Shortcuts without Ctrl, Alt or Super would take keys from typing.
                (modifiers & ~Gdk.ModifierType.SHIFT_MASK) !== 0 &&
                Gtk.accelerator_valid(keyval, modifiers)
            ) {
                shortcut = [Gtk.accelerator_name_with_keycode(null, keyval, keycode, modifiers)];
            } else {
                return Gdk.EVENT_PROPAGATE;
            }
            this._settings.set_strv(SettingsKey.TOGGLE_MENU_SHORTCUT, shortcut);
            dialog.close();
            return Gdk.EVENT_STOP;
        }
    },
);
