// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ApiKeyReader} from '../providers/apiKeyReader.js';
import {createProvider} from '../providers/registry.js';
import {listedSlots, providerConfigKey, readAccountConfig} from '../shared/accountSettings.js';
import {PROVIDER_TYPES} from '../shared/providerTypes.js';
import {AccountKey, SettingsKey} from '../shared/settings.js';
import {LimitIndicator} from '../ui/limitIndicator.js';
import {UsageNotifier} from '../ui/usageNotifier.js';
import {MenuShortcut} from './menuShortcut.js';
import {SavedStateStore} from './savedState.js';
import {UsageController} from './usageController.js';

/**
 * Runs the accounts that `accounts` lists: one controller, with its own
 * indicator, notifier and provider, all owned here, per enabled account, kept together in the
 * top bar in list order. Each account starts from the state it saved last.
 */
export class AccountManager {
    /**
     * @param {object} params
     * @param {Extension} params.extension
     * @param {Gio.Settings} params.settings  The extension's settings.
     * @param {object} params.i18n  {gettext, ngettext, pgettext} of the extension's domain.
     */
    constructor({extension, settings, i18n}) {
        this._extension = extension;
        this._settings = settings;
        this._i18n = i18n;
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        // Slot → {settings, changedId, configKey, cancellable, provider,
        // notifier, indicator, controller}, in `accounts` order. configKey is
        // null while the account is disabled, and the last four also while its
        // saved state loads, which cancellable cancels, and when the account
        // failed to start. This class creates and destroys all four.
        this._accounts = new Map();
        this._settingsIds = [];
        this._apiKeys = null;
        this._store = null;
        // Resolves once the files of accounts removed while the extension was
        // off are queued for deletion; loads wait for it.
        this._pruned = null;
        // Counts the times history was turned off, so that a load that ran
        // meanwhile drops the history it read.
        this._historyDeletions = 0;
        this._menuShortcut = null;
    }

    start() {
        // The providers of API-key accounts read their keys through it.
        this._apiKeys = new ApiKeyReader({schemaName: this._extension.metadata['settings-schema']});
        this._store = new SavedStateStore({
            cacheDirectory: GLib.build_filenamev([GLib.get_user_cache_dir(), this._extension.uuid]),
            stateDirectory: GLib.build_filenamev([GLib.get_user_state_dir(), this._extension.uuid]),
        });
        this._pruned = this._store.prune(
            listedSlots(this._settings.get_strv(SettingsKey.ACCOUNTS)),
        );
        // History of every listed account goes with the switch, whether or not
        // its controller runs.
        this._forgetHistoryIfOff();
        this._settingsIds = [
            this._settings.connect(`changed::${SettingsKey.ACCOUNTS}`, () => this._syncAccounts()),
            this._settings.connect(`changed::${SettingsKey.SHOW_HISTORY}`, () =>
                this._forgetHistoryIfOff(),
            ),
            this._settings.connect(`changed::${SettingsKey.PANEL_INDEX}`, () =>
                this._placeIndicators(),
            ),
            // Shell has no public way to move an indicator to another box.
            this._settings.connect(`changed::${SettingsKey.PANEL_BOX}`, () =>
                this._recreateAccounts(),
            ),
        ];
        this._menuShortcut = new MenuShortcut(this._settings, () => this._firstIndicator());
        this._syncAccounts();
    }

    destroy() {
        for (const id of this._settingsIds) this._settings.disconnect(id);
        this._settingsIds = [];
        this._menuShortcut.destroy();
        this._menuShortcut = null;
        for (const account of this._accounts.values()) {
            this._stopAccount(account);
            account.settings.disconnect(account.changedId);
        }
        this._accounts.clear();
        this._accounts = null;
        // After the controllers, which save through it; cancels its writes.
        this._store.destroy();
        this._store = null;
        this._pruned = null;
        // It holds no resources: each provider cancels its own lookups.
        this._apiKeys = null;
        this._interfaceSettings = null;
        this._settings = null;
        this._extension = null;
        this._i18n = null;
    }

    // Turning history off deletes the history file of every listed account.
    // The slots come from the settings, as the accounts are not created yet
    // at start().
    _forgetHistoryIfOff() {
        if (this._settings.get_boolean(SettingsKey.SHOW_HISTORY)) return;
        this._historyDeletions++;
        for (const slot of listedSlots(this._settings.get_strv(SettingsKey.ACCOUNTS)))
            this._store.forgetHistory(slot);
    }

    _syncAccounts() {
        const slots = listedSlots(this._settings.get_strv(SettingsKey.ACCOUNTS));
        for (const [slot, account] of this._accounts) {
            if (slots.includes(slot)) continue;
            this._accounts.delete(slot);
            this._stopAccount(account);
            account.settings.disconnect(account.changedId);
            this._store.forget(slot);
        }
        for (const slot of slots) {
            let account = this._accounts.get(slot);
            if (!account) {
                const settings = this._settings.get_child(slot);
                // Before its handler is connected: dconf undoes a write it
                // cannot commit with a change signal, which a handler that
                // wrote again would answer, in a loop.
                if (settings.get_string(AccountKey.INSTANCE_ID) === '')
                    settings.set_string(AccountKey.INSTANCE_ID, GLib.uuid_string_random());
                account = {
                    settings,
                    changedId: 0,
                    configKey: null,
                    cancellable: new Gio.Cancellable(),
                    provider: null,
                    notifier: null,
                    indicator: null,
                    controller: null,
                };
                account.changedId = settings.connect('changed', () =>
                    this._syncAccount(slot, account),
                );
                // At once, so that destroy() disconnects it whatever happens next.
                this._accounts.set(slot, account);
            }
            this._syncAccount(slot, account);
        }
        // In `accounts` order, for _placeIndicators().
        this._accounts = new Map(slots.map(slot => [slot, this._accounts.get(slot)]));
        this._placeIndicators();
    }

    // Creates, keeps or destroys the account's controller; any change to what
    // its provider is created from creates it again.
    _syncAccount(slot, account) {
        const config = readAccountConfig(account.settings, slot);
        const configKey = config.enabled ? providerConfigKey(config) : null;
        if (configKey === account.configKey) return;
        this._stopAccount(account);
        account.configKey = configKey;
        if (configKey !== null) this._startAccount(config, account);
    }

    _recreateAccounts() {
        for (const [slot, account] of this._accounts) {
            account.configKey = null;
            this._syncAccount(slot, account);
        }
    }

    // Cancels the account's pending load and destroys what it created, in
    // reverse order: the controller uses the indicator, the notifier and the
    // provider.
    _stopAccount(account) {
        account.cancellable.cancel();
        const {controller, indicator, notifier, provider} = account;
        account.controller = null;
        account.indicator = null;
        account.notifier = null;
        account.provider = null;
        if (controller !== null) controller.destroy();
        if (indicator !== null) indicator.destroy();
        if (notifier !== null) notifier.destroy();
        if (provider !== null) provider.destroy();
    }

    // Loads the state the account saved, then creates it. An account that
    // fails to start is logged, keeps nothing it created, so that the others
    // are placed without it, and is tried again only after a change to what
    // its provider is created from.
    async _startAccount(config, account) {
        const cancellable = new Gio.Cancellable();
        account.cancellable = cancellable;
        try {
            await this._pruned;
            if (cancellable.is_cancelled()) return;
            const historyDeletions = this._historyDeletions;
            // An account without an instance ID neither restores nor saves state.
            const saved =
                config.instanceId === ''
                    ? null
                    : await this._store.loadAccount(config.slot, account.configKey, cancellable);
            if (cancellable.is_cancelled()) return;
            // Turning history off during the load deleted the file it read.
            if (saved !== null && historyDeletions !== this._historyDeletions) saved.history = null;
            this._createAccount(config, account, saved);
            this._placeIndicators();
        } catch (error) {
            if (!cancellable.is_cancelled()) {
                logError(error, `Failed to start ${config.slot} (${config.type})`);
                this._stopAccount(account);
            }
        }
    }

    // Creates what the account runs, in order, and stores each part in the
    // account as soon as it exists, so that _stopAccount() releases whatever a
    // failing step leaves behind. The indicator comes after the provider and
    // the notifier, so that a failure before it adds nothing to the top bar.
    _createAccount(config, account, saved) {
        const type = PROVIDER_TYPES[config.type];
        const iconFile = this._extension.dir.get_child('icons').get_child(type.icon);
        account.provider = createProvider(config, {
            version: `${this._extension.metadata.version}.0.0`,
            apiKeys: this._apiKeys,
            savedState: saved?.providerState ?? null,
        });
        account.notifier = new UsageNotifier({title: this._extension.metadata.name, iconFile});
        // Its callbacks reach the controller created below; the menu cannot be
        // used before then.
        account.indicator = new LimitIndicator({
            settings: this._settings,
            iconFile,
            onSelectLimit: option => account.controller.saveLimitSelection(option),
            onOpenPreferences: () => this._extension.openPreferences(),
            onRefresh: () =>
                account.controller
                    .refresh()
                    .catch(error => logError(error, `Failed to refresh ${type.name} usage`)),
            onRedeemReset: (creditId, accountGeneration) =>
                account.controller
                    .redeemReset(creditId, {accountGeneration})
                    .catch(error =>
                        logError(error, `Failed to redeem a ${type.name} manual reset`),
                    ),
            title: `${type.name} Usage Indicator`,
        });
        account.controller = new UsageController({
            settings: this._settings,
            accountSettings: account.settings,
            providerType: type,
            i18n: this._i18n,
            interfaceSettings: this._interfaceSettings,
            indicator: account.indicator,
            notifier: account.notifier,
            provider: account.provider,
            store: config.instanceId === '' ? null : this._store,
            slot: config.slot,
            configKey: account.configKey,
            saved,
        });
        // _placeIndicators() moves it to its position among the others.
        Main.panel.addToStatusArea(
            this._panelRole(config.slot),
            account.indicator,
            this._settings.get_uint(SettingsKey.PANEL_INDEX),
            this._settings.get_string(SettingsKey.PANEL_BOX),
        );
        account.controller.start();
    }

    _panelRole(slot) {
        return `${this._extension.uuid}-${slot}`;
    }

    // The indicator of the first account in `accounts` that is running.
    _firstIndicator() {
        for (const account of this._accounts.values()) {
            if (account.controller) return account.indicator;
        }
        return null;
    }

    // Puts the indicators next to each other in `accounts` order, the first at
    // panel-index among the other items, so that none ends up between them.
    _placeIndicators() {
        const containers = [];
        for (const account of this._accounts.values()) {
            if (account.controller) containers.push(account.indicator.container);
        }
        if (containers.length === 0) return;
        const box = containers[0].get_parent();
        const others = box.get_children().filter(actor => !containers.includes(actor));
        const first = Math.min(this._settings.get_uint(SettingsKey.PANEL_INDEX), others.length);
        // Only our containers are moved, so the other items keep their places
        // among themselves. Clutter removes a child before inserting it, so
        // first park ours at the end, then insert each at its final position.
        for (const container of containers) box.set_child_at_index(container, -1);
        containers.forEach((container, index) => {
            box.set_child_at_index(container, first + index);
        });
    }
}
