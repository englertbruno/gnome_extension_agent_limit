// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {readAccountConfig} from '../shared/accountSettings.js';
import {endpointOrigin} from '../shared/endpointRules.js';
import {providerTypeName} from '../shared/providerTypes.js';
import {AccountKey} from '../shared/settings.js';
import {createLinkRow} from './accountRows.js';

// A key is stored trimmed. Inner spaces or control characters cannot be part
// of a key, and could not be sent in a header.
const API_KEY = /^[^\s\p{Cc}]+$/u;

/**
 * The API key of one account in the keyring. Storing or removing it
 * increments the account's api-key-revision, so Shell reads the key again.
 * A Kimi Code key belongs to its region, and a custom endpoint's key to the
 * origin (scheme, host and port) of its URL, so the group shows the key of the
 * saved region or URL, and refuses to store one while the URL row holds a
 * change that is not applied.
 */
export const ApiKeyGroup = GObject.registerClass(
    class ApiKeyGroup extends Adw.PreferencesGroup {
        /**
         * @param {object} params
         * @param {Gio.Settings} params.settings  The account's settings.
         * @param {string} params.slot
         * @param {object} params.type  The account's PROVIDER_TYPES entry.
         * @param {SecretStore} params.secretStore  Shared with other pages; not owned.
         * @param {string} params.description
         * @param {Adw.EntryRow|null} params.urlRow  The endpoint URL row of a custom endpoint; not owned.
         * @param {function(boolean): void} params.onBusyChanged  Called with true when keyring
         *     operations start, and with false when none is left.
         */
        _init({settings, slot, type, secretStore, description, urlRow, onBusyChanged}) {
            super._init({title: _('API Key'), description});
            this._settings = settings;
            this._secretStore = secretStore;
            this._urlRow = urlRow;
            this._onBusyChanged = onBusyChanged;
            // The AccountConfig, which apiKeyAttributes() takes, as Shell
            // reads it. A changed region or URL replaces it, so that a pending
            // store keeps the one it began with.
            this._account = readAccountConfig(settings, slot);
            /* Translators: the label of the API key's item in the keyring. %s is a product name, such as OpenRouter, or Custom endpoint. */
            this._label = _('Agent Usage Indicator: API key for %s').format(
                providerTypeName(type, _),
            );
            this._cancellable = new Gio.Cancellable();
            // Keyring operations that are running; the rows are insensitive
            // until none is.
            this._operations = 0;

            this._keyRow = new Adw.PasswordEntryRow({
                title: _('New key'),
                show_apply_button: true,
            });
            this.add(this._keyRow);
            this._statusRow = new Adw.ActionRow({title: _('Checking the keyring…')});
            this._removeButton = new Gtk.Button({
                label: _('Remove'),
                valign: Gtk.Align.CENTER,
                visible: false,
            });
            this._statusRow.add_suffix(this._removeButton);
            this.add(this._statusRow);
            if (type.keyUrl !== null) this.add(createLinkRow(_('Get an API Key'), type.keyUrl));

            this._signals = [
                [this._keyRow, this._keyRow.connect('apply', () => this._storeKey())],
                [
                    this._keyRow,
                    this._keyRow.connect('changed', () => this._keyRow.remove_css_class('error')),
                ],
                [
                    this._removeButton,
                    this._removeButton.connect('clicked', () => this._deleteKey()),
                ],
            ];
            if (type.id === 'kimi' || type.credential === 'endpoint') {
                const regionOrUrl =
                    type.id === 'kimi' ? AccountKey.KIMI_REGION : AccountKey.ENDPOINT_URL;
                this._signals.push([
                    settings,
                    settings.connect(`changed::${regionOrUrl}`, () => {
                        this._account = readAccountConfig(settings, slot);
                        this._checkKey();
                    }),
                ]);
            }
            this._checkKey();
        }

        release() {
            this._cancellable.cancel();
            this._cancellable = null;
            for (const [emitter, signalId] of this._signals) emitter.disconnect(signalId);
            this._signals = [];

            this._settings = null;
            this._secretStore = null;
            this._urlRow = null;
            this._onBusyChanged = null;
            this._keyRow = null;
            this._statusRow = null;
            this._removeButton = null;
        }

        async _checkKey() {
            const account = this._account;
            const state = await this._runKeyringOperation(cancellable =>
                this._secretStore.keyStatus(account, cancellable),
            );
            // A check of an earlier region or URL is not shown.
            if (state !== null && account === this._account) this._showKeyState(state);
        }

        async _storeKey() {
            const key = this._keyRow.text.trim();
            if (!API_KEY.test(key)) {
                this._keyRow.add_css_class('error');
                this._statusRow.subtitle = _('Enter a key without spaces or control characters');
                return;
            }
            // The key would be stored for the saved URL, not the one in the
            // row; without a valid saved URL it would belong to no service.
            const savedUrl = this._settings.get_string(AccountKey.ENDPOINT_URL);
            if (
                this._urlRow !== null &&
                (this._urlRow.text.trim() !== savedUrl || endpointOrigin(savedUrl) === '')
            ) {
                this._statusRow.subtitle = _(
                    'Apply the URL first, because a key belongs to the URL’s service',
                );
                return;
            }
            this._statusRow.subtitle = '';
            // The region or URL may change while the key is stored; the key
            // keeps the one it began with.
            const account = this._account;
            const result = await this._runKeyringOperation(cancellable =>
                this._secretStore.storeKey(account, this._label, key, cancellable),
            );
            // null: the page was closed meanwhile.
            if (result === null) return;
            if (result === 'stored') {
                this._keyRow.text = '';
                this._incrementRevision();
            }
            // The region or URL changed meanwhile: the rows show the key of the new one.
            if (account !== this._account) {
                this._checkKey();
                return;
            }
            switch (result) {
                case 'stored':
                    this._showKeyState('stored');
                    break;
                case 'dismissed':
                    this._statusRow.subtitle = _(
                        'The keyring prompt was dismissed, so the key was not stored',
                    );
                    break;
                case 'no-instance-id':
                    this._statusRow.subtitle = _(
                        'The account’s settings could not be saved, so the key was not stored',
                    );
                    break;
                case 'unavailable':
                    this._showKeyState('unavailable');
                    break;
                case 'failed':
                    this._statusRow.subtitle = _('The keyring could not store the key');
                    break;
            }
        }

        // Deletes the key that the status row shows: keys for other regions
        // or origins stay until the account is removed.
        async _deleteKey() {
            this._statusRow.subtitle = '';
            const account = this._account;
            const result = await this._runKeyringOperation(cancellable =>
                this._secretStore.deleteKey(account, cancellable),
            );
            // null: the page was closed meanwhile.
            if (result === null) return;
            if (result === 'deleted') this._incrementRevision();
            // The region or URL changed meanwhile: the rows show the key of the new one.
            if (account !== this._account) {
                this._checkKey();
                return;
            }
            switch (result) {
                case 'deleted':
                    this._showKeyState('missing');
                    break;
                case 'dismissed':
                    this._statusRow.subtitle = _(
                        'The keyring prompt was dismissed, so the key was not removed',
                    );
                    break;
                case 'unavailable':
                    this._showKeyState('unavailable');
                    break;
                case 'failed':
                    this._statusRow.subtitle = _('The keyring could not remove the key');
                    break;
            }
        }

        // Runs a keyring operation with the rows insensitive until no other
        // runs. Returns its result, 'failed' when it threw, or null when the
        // group was released meanwhile.
        async _runKeyringOperation(operation) {
            const cancellable = this._cancellable;
            this._operations++;
            if (this._operations === 1) this._showBusy(true);
            let result;
            try {
                result = await operation(cancellable);
            } catch (error) {
                if (cancellable.is_cancelled()) return null;
                logError(error, 'Cannot access the API key in the keyring');
                result = 'failed';
            }
            if (cancellable.is_cancelled()) return null;
            this._operations--;
            if (this._operations === 0) this._showBusy(false);
            return result;
        }

        _showBusy(busy) {
            this._keyRow.sensitive = !busy;
            this._removeButton.sensitive = !busy;
            this._onBusyChanged(busy);
        }

        _showKeyState(state) {
            const origin =
                this._account.endpoint === null ? null : endpointOrigin(this._account.endpoint.url);
            this._statusRow.title = keyStateText(state, origin);
            this._removeButton.visible = state === 'stored';
        }

        _incrementRevision() {
            const revision = this._settings.get_uint(AccountKey.API_KEY_REVISION);
            this._settings.set_uint(AccountKey.API_KEY_REVISION, revision + 1);
        }
    },
);

// `origin` is that of a custom endpoint, whose key belongs to it; null for other accounts.
function keyStateText(state, origin) {
    switch (state) {
        case 'stored':
            return _('A key is stored in the keyring');
        case 'missing':
            return origin === null
                ? _('No key stored')
                : /* Translators: %s is a web address, such as https://example.com, or “this URL”. */
                  _('No key stored for %s').format(origin || _('this URL'));
        case 'unavailable':
            return _('No keyring service is running');
    }
    return _('The keyring could not be read');
}
