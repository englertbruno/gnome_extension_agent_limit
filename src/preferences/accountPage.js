// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {isValidPointer} from '../shared/customMapping.js';
import {
    isAllowedEndpointUrl,
    isHttpsUrl,
    isValidHeaderName,
    isValidHeaderPrefix,
} from '../shared/endpointRules.js';
import {providerTypeName} from '../shared/providerTypes.js';
import {AccountKey} from '../shared/settings.js';
import {createLinkRow, SettingEntryRow, StringChoiceRow} from './accountRows.js';
import {ApiKeyGroup} from './apiKeyGroup.js';
import {chooseConfigurationDirectory} from './folderChooser.js';
import {createSpinRow, createSwitchRow} from './rows.js';

/** The display name of an account: its own name, or its provider's. */
export function accountName(settings, type) {
    return settings.get_string(AccountKey.NAME) || providerTypeName(type, _);
}

const trim = text => text.trim();

/** The settings of one account, in the account-N child settings. */
export const AccountPage = GObject.registerClass(
    class AccountPage extends Adw.PreferencesPage {
        /**
         * @param {Gio.Settings} settings  The account's child settings.
         * @param {object} type  The account's PROVIDER_TYPES entry.
         * @param {object} params
         * @param {string} params.slot
         * @param {SecretStore} params.secretStore  Shared with other pages; not owned.
         * @param {function(string): boolean} params.claimDirectory  Whether the account may use a configuration
         *     directory, '' for the CLI's default; says why not.
         * @param {boolean} params.removable  Whether the list of accounts can be changed.
         * @param {function(number): void} params.onMove  -1 moves the account up, 1 down.
         * @param {function(): Promise<void>} params.onRemove  Removes the confirmed account; resolves when that ended,
         *     and releases this page if it removed the account.
         */
        _init(settings, type, {slot, secretStore, claimDirectory, removable, onMove, onRemove}) {
            super._init({title: accountName(settings, type)});

            this._settings = settings;
            this._type = type;
            this._onRemove = onRemove;
            this._claimDirectory = claimDirectory;
            this._cancellable = new Gio.Cancellable();
            // What release() ends: [emitter, handler ID] pairs, [widget,
            // property] settings bindings, and children with their own release().
            this._signals = [];
            this._bindings = [];
            this._children = [];
            // Remove Account… waits for the API key group's keyring
            // operations, and the group for a removal, so that no key is
            // stored while the account's keys are deleted. The row is created
            // before the group, which reports its operations from the start.
            this._removable = removable;
            this._keyringBusy = false;
            this._removing = false;
            this._keyGroup = null;
            this._removeRow = new Adw.ButtonRow({title: _('Remove Account…')});
            this._removeRow.add_css_class('destructive-action');
            this._removeRow.sensitive = removable;

            const accountGroup = new Adw.PreferencesGroup({title: _('Account')});
            accountGroup.add(this._entryRow(AccountKey.NAME, {title: _('Name'), normalize: trim}));
            accountGroup.add(this._switchRow(AccountKey.ENABLED, _('Show in Top Bar')));
            this.add(accountGroup);

            if (type.beta) this.add(createBetaGroup());

            switch (type.credential) {
                case 'cli':
                    this.add(this._createCliGroup());
                    break;
                case 'api-key':
                    this.add(this._createApiKeyGroup(slot, secretStore));
                    break;
                case 'endpoint':
                    this.add(this._createEndpointGroup());
                    this.add(this._createApiKeyGroup(slot, secretStore));
                    this.add(this._createMappingGroup());
                    break;
            }

            const usageGroup = new Adw.PreferencesGroup({title: _('Usage')});
            usageGroup.add(
                this._spinRow(AccountKey.REFRESH_INTERVAL, {
                    title: _('Refresh interval (seconds)'),
                    /* Translators: %d is a number of seconds. */
                    subtitle: _('Seconds between automatic usage checks; minimum %d').format(
                        type.minRefreshSeconds,
                    ),
                    lower: type.minRefreshSeconds,
                    step: 30,
                }),
            );
            if (type.manualResets) {
                usageGroup.add(
                    this._switchRow(
                        AccountKey.AUTO_REDEEM,
                        _('Redeem Manual Resets Automatically Before They Expire'),
                        _(
                            'Uses a manual reset in its last hour without asking. This resets the account’s usage limits unattended.',
                        ),
                    ),
                );
            }
            this.add(usageGroup);

            const orderGroup = new Adw.PreferencesGroup({
                title: _('Order'),
                description: _('The top bar shows the accounts in this order'),
            });
            this._moveUpRow = new Adw.ButtonRow({
                title: _('Move Up'),
                start_icon_name: 'go-up-symbolic',
            });
            this._moveDownRow = new Adw.ButtonRow({
                title: _('Move Down'),
                start_icon_name: 'go-down-symbolic',
            });
            this._connect(this._moveUpRow, 'activated', () => onMove(-1));
            this._connect(this._moveDownRow, 'activated', () => onMove(1));
            orderGroup.add(this._moveUpRow);
            orderGroup.add(this._moveDownRow);
            this.add(orderGroup);

            const removeGroup = new Adw.PreferencesGroup();
            this._connect(this._removeRow, 'activated', () => this._confirmRemoval());
            removeGroup.add(this._removeRow);
            this.add(removeGroup);
        }

        // An account page can be removed while the window stays open, so it
        // ends its handlers and settings bindings itself.
        release() {
            this._cancellable.cancel();
            this._cancellable = null;
            for (const [emitter, signalId] of this._signals) emitter.disconnect(signalId);
            this._signals = [];
            for (const [widget, property] of this._bindings) Gio.Settings.unbind(widget, property);
            this._bindings = [];
            for (const child of this._children) child.release();
            this._children = [];

            this._settings = null;
            this._onRemove = null;
            this._claimDirectory = null;
            this._urlRow = null;
            this._directoryRow = null;
            this._resetDirectoryButton = null;
            this._moveUpRow = null;
            this._moveDownRow = null;
            this._keyGroup = null;
            this._removeRow = null;
        }

        /** Makes Move Up and Move Down available where the account can move. */
        showPosition(index, count) {
            this._moveUpRow.sensitive = index > 0;
            this._moveDownRow.sensitive = index < count - 1;
        }

        _createCliGroup() {
            const type = this._type;
            const group = new Adw.PreferencesGroup({
                title: _('Sign-In'),
                description: signInDescription(type),
            });
            if (type.configDirectoryVariable !== null) {
                this._directoryRow = new Adw.ActionRow({title: _('Configuration directory')});
                const chooseButton = new Gtk.Button({
                    label: _('Choose…'),
                    valign: Gtk.Align.CENTER,
                });
                this._resetDirectoryButton = new Gtk.Button({
                    label: _('Reset'),
                    tooltip_text: _('Use the Default Directory'),
                    valign: Gtk.Align.CENTER,
                });
                this._directoryRow.add_suffix(chooseButton);
                this._directoryRow.add_suffix(this._resetDirectoryButton);
                this._connect(chooseButton, 'clicked', () => this._chooseDirectory());
                this._connect(this._resetDirectoryButton, 'clicked', () => {
                    if (this._claimDirectory('')) this._settings.reset(AccountKey.CONFIG_DIRECTORY);
                });
                this._connect(this._settings, `changed::${AccountKey.CONFIG_DIRECTORY}`, () =>
                    this._syncDirectory(),
                );
                this._syncDirectory();
                group.add(this._directoryRow);
            }
            if (type.installUrl !== null)
                group.add(createLinkRow(_('Installation Guide'), type.installUrl));
            return group;
        }

        _syncDirectory() {
            const directory = this._settings.get_string(AccountKey.CONFIG_DIRECTORY);
            this._directoryRow.subtitle = directory || _('Default');
            this._resetDirectoryButton.sensitive = directory !== '';
        }

        async _chooseDirectory() {
            const cancellable = this._cancellable;
            const path = await chooseConfigurationDirectory(
                this,
                this._settings.get_string(AccountKey.CONFIG_DIRECTORY),
                cancellable,
            );
            if (cancellable.is_cancelled()) return;
            if (path !== null && this._claimDirectory(path))
                this._settings.set_string(AccountKey.CONFIG_DIRECTORY, path);
        }

        _createApiKeyGroup(slot, secretStore) {
            const type = this._type;
            const group = new ApiKeyGroup({
                settings: this._settings,
                slot,
                type,
                secretStore,
                urlRow: type.credential === 'endpoint' ? this._urlRow : null,
                description:
                    type.credential === 'endpoint'
                        ? _('Optional; sent in the header above')
                        : signInDescription(type),
                onBusyChanged: busy => {
                    this._keyringBusy = busy;
                    this._syncRemoval();
                },
            });
            this._keyGroup = group;
            this._children.push(group);
            if (type.id === 'kimi') {
                group.add(
                    this._choiceRow(AccountKey.KIMI_REGION, {
                        title: _('Region'),
                        subtitle: _('Where the key was created'),
                        choices: [
                            ['china', _('China (api.kimi.com)')],
                            ['international', _('International (api.kimi.ai)')],
                        ],
                    }),
                );
            }
            return group;
        }

        _createEndpointGroup() {
            const group = new Adw.PreferencesGroup({
                title: _('Endpoint'),
                description: signInDescription(this._type),
            });
            this._urlRow = this._entryRow(AccountKey.ENDPOINT_URL, {
                title: _('URL'),
                normalize: trim,
                isValid: url => url === '' || isAllowedEndpointUrl(url),
                invalidText: _('Use https, or http to this computer'),
            });
            group.add(this._urlRow);
            group.add(
                this._entryRow(AccountKey.AUTH_HEADER, {
                    title: _('Key header'),
                    normalize: trim,
                    isValid: isValidHeaderName,
                    invalidText: _("Use letters, digits and !#$%&'*+-.^_`|~ only"),
                }),
            );
            group.add(
                this._entryRow(AccountKey.AUTH_PREFIX, {
                    title: _('Text before the key'),
                    isValid: isValidHeaderPrefix,
                    invalidText: _('Control characters cannot be sent'),
                }),
            );
            group.add(
                this._entryRow(AccountKey.USAGE_PAGE_URL, {
                    title: _('Usage page'),
                    normalize: trim,
                    isValid: url => url === '' || isHttpsUrl(url),
                    invalidText: _('Use an https address'),
                }),
            );
            return group;
        }

        _createMappingGroup() {
            const group = new Adw.PreferencesGroup({
                title: _('Response'),
                description: _(
                    'JSON Pointers to the values in the reply, such as /usage/percent. The percentage is used when set, otherwise the used amount and the limit.',
                ),
            });
            const pointerRow = (key, title) =>
                this._entryRow(key, {
                    title,
                    isValid: isValidPointer,
                    invalidText: _('Start with /, and write ~0 for ~ and ~1 for / in names'),
                });
            group.add(pointerRow(AccountKey.PERCENT_POINTER, _('Percentage')));
            group.add(
                this._choiceRow(AccountKey.PERCENT_MEANING, {
                    /* Translators: row title; the choices say whether the percentage counts used or remaining usage. */
                    title: _('Percentage counts'),
                    choices: [
                        ['used', _('Used')],
                        ['remaining', _('Remaining')],
                    ],
                }),
            );
            group.add(pointerRow(AccountKey.USED_POINTER, _('Used amount')));
            group.add(pointerRow(AccountKey.LIMIT_POINTER, _('Limit')));
            group.add(pointerRow(AccountKey.RESET_POINTER, _('Reset time')));
            group.add(
                this._spinRow(AccountKey.WINDOW_MINUTES, {
                    title: _('Window length (minutes)'),
                    subtitle: _('0 when unknown'),
                    step: 60,
                }),
            );
            return group;
        }

        _confirmRemoval() {
            const dialog = new Adw.AlertDialog({
                /* Translators: the heading of a dialog that removes an account. %s is the account's name. */
                heading: _('Remove %s?').format(accountName(this._settings, this._type)),
                body:
                    this._type.credential === 'cli'
                        ? _('Its settings are deleted. The login of the command-line tool stays.')
                        : _('Its settings and its API key are deleted'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('remove', _('Remove'));
            dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.close_response = 'cancel';
            dialog.default_response = 'cancel';
            // release() cancels, which closes the dialog with 'cancel'.
            dialog.choose(this, this._cancellable, (_dialog, result) => {
                if (dialog.choose_finish(result) === 'remove') this._remove();
            });
        }

        // Keeps the key group and Remove Account… insensitive until the
        // removal ends; a removal that failed leaves the page in use.
        async _remove() {
            const cancellable = this._cancellable;
            this._removing = true;
            this._syncRemoval();
            await this._onRemove();
            if (cancellable.is_cancelled()) return;
            this._removing = false;
            this._syncRemoval();
        }

        _syncRemoval() {
            this._removeRow.sensitive = this._removable && !this._keyringBusy && !this._removing;
            if (this._keyGroup !== null) this._keyGroup.sensitive = !this._removing;
        }

        _connect(emitter, signal, callback) {
            this._signals.push([emitter, emitter.connect(signal, callback)]);
        }

        _entryRow(key, options) {
            const row = new SettingEntryRow(this._settings, key, options);
            this._children.push(row);
            return row;
        }

        _choiceRow(key, options) {
            const row = new StringChoiceRow(this._settings, key, options);
            this._children.push(row);
            return row;
        }

        _switchRow(key, title, subtitle = '') {
            const row = createSwitchRow(this._settings, key, title, subtitle);
            this._bindings.push([row, 'active']);
            return row;
        }

        _spinRow(key, options) {
            const row = createSpinRow(this._settings, key, options);
            this._bindings.push([row, 'value']);
            return row;
        }
    },
);

function createBetaGroup() {
    const group = new Adw.PreferencesGroup();
    const row = new Adw.ActionRow({
        title: _('Beta, untested'),
        subtitle: _(
            'Kimi Code’s usage endpoint is undocumented, so its response format is unverified. Other beta providers are built from their API documentation and untested. Please report problems.',
        ),
    });
    row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
    group.add(row);
    return group;
}

function signInDescription(type) {
    switch (type.id) {
        case 'codex':
            return _('Uses the ChatGPT account signed in through the Codex CLI');
        case 'claude':
            return _('Uses the Claude subscription signed in through Claude Code');
        case 'antigravity':
            return _('Uses the Google account signed in through the Antigravity CLI (agy)');
    }
    return type.credential === 'endpoint'
        ? _('Reads usage from a JSON endpoint')
        : _('Uses an API key stored in the keyring');
}
