// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PROVIDER_TYPE_IDS, PROVIDER_TYPES, providerTypeName} from '../shared/providerTypes.js';

/**
 * Whether only one account of `type` can exist: a CLI without a variable that
 * selects another login always uses the same one.
 */
function allowsOneAccount(type) {
    return type.credential === 'cli' && type.configDirectoryVariable === null;
}

/** Lists the provider types; choosing one closes the dialog and adds an account of it. */
export const AddAccountDialog = GObject.registerClass(
    class AddAccountDialog extends Adw.Dialog {
        /**
         * @param {object} params
         * @param {string[]} params.listedTypes  The type IDs of the listed accounts.
         * @param {Gio.File} params.iconsDirectory  Holds the provider logos.
         * @param {function(string): void} params.onTypeChosen  Called with the chosen type ID.
         */
        _init({listedTypes, iconsDirectory, onTypeChosen}) {
            super._init({title: _('Add Account'), content_width: 460, content_height: 640});

            const groups = {
                cli: new Adw.PreferencesGroup({
                    title: _('Command-Line Logins'),
                    description: _('Uses the login of the provider’s command-line tool'),
                }),
                'api-key': new Adw.PreferencesGroup({
                    title: _('API Keys'),
                    description: _('Reads usage with an API key stored in the keyring'),
                }),
                endpoint: new Adw.PreferencesGroup({title: _('Other')}),
            };
            const page = new Adw.PreferencesPage();
            for (const group of Object.values(groups)) page.add(group);

            this._signals = [];
            for (const id of PROVIDER_TYPE_IDS) {
                const type = PROVIDER_TYPES[id];
                const added = allowsOneAccount(type) && listedTypes.includes(id);
                const row = new Adw.ActionRow({
                    title: providerTypeName(type, _),
                    subtitle: added ? _('Added already; its CLI has one login') : '',
                    activatable: true,
                    sensitive: !added,
                });
                row.add_prefix(
                    new Gtk.Image({
                        gicon: new Gio.FileIcon({file: iconsDirectory.get_child(type.icon)}),
                        icon_size: Gtk.IconSize.LARGE,
                    }),
                );
                if (type.beta) {
                    row.add_suffix(
                        new Gtk.Label({
                            label: _('Beta'),
                            css_classes: ['caption-heading', 'dimmed'],
                            valign: Gtk.Align.CENTER,
                        }),
                    );
                }
                row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
                this._signals.push([
                    row,
                    row.connect('activated', () => {
                        this.close();
                        onTypeChosen(id);
                    }),
                ]);
                groups[type.credential].add(row);
            }

            const view = new Adw.ToolbarView({content: page});
            view.add_top_bar(new Adw.HeaderBar());
            this.child = view;
            this._closedId = this.connect('closed', () => {
                for (const [row, signalId] of this._signals) row.disconnect(signalId);
                this._signals = [];
                this.disconnect(this._closedId);
                this._closedId = 0;
            });
        }
    },
);
