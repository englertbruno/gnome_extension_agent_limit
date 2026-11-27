// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ACCOUNT_SLOTS, listedSlots, readAccountConfig} from '../shared/accountSettings.js';
import {PROVIDER_TYPES, providerTypeName} from '../shared/providerTypes.js';
import {AccountKey, SettingsKey} from '../shared/settings.js';
import {AccountPage, accountName} from './accountPage.js';
import {AddAccountDialog} from './addAccountDialog.js';
import {BehaviorPage} from './behaviorPage.js';
import {chooseConfigurationDirectory} from './folderChooser.js';
import {NotificationsPage} from './notificationsPage.js';
import {SecretStore} from './secretStore.js';
import {TopBarPage} from './topBarPage.js';

// The directory a CLI uses when its variable is unset, relative to the home directory.
const DEFAULT_DIRECTORY_NAMES = {codex: '.codex', claude: '.claude'};

/**
 * The content of the preferences window: a sidebar with the general pages,
 * one item per account in `accounts` and Add Account…, beside the selected
 * page. A narrow window shows the sidebar and the page one at a time.
 *
 * @typedef {object} AccountEntry
 * @property {Gio.Settings} settings  The slot's child settings.
 * @property {object} type            Its PROVIDER_TYPES entry, fixed while the slot is listed.
 * @property {Adw.SidebarItem} item
 * @property {AccountPage} page
 * @property {number[]} signalIds     Handlers on settings.
 */
export const PreferencesView = GObject.registerClass(
    class PreferencesView extends Adw.BreakpointBin {
        /**
         * @param {Gio.Settings} settings
         * @param {string} title  Of the sidebar.
         * @param {Gio.File} iconsDirectory  Holds the provider logos.
         */
        _init(settings, title, iconsDirectory) {
            // The smallest size the GNOME guidelines ask windows to support.
            super._init({width_request: 360, height_request: 294});

            this._settings = settings;
            this._iconsDirectory = iconsDirectory;
            this._secretStore = new SecretStore({schemaName: settings.schema_id});
            // For adding and removing accounts; account pages have their own.
            this._cancellable = new Gio.Cancellable();
            // Adds run one at a time: a second would pick the slot of the first while it waits.
            this._adding = false;
            /** @type {Map<Adw.SidebarItem, Adw.PreferencesPage>} */
            this._pages = new Map();
            /** @type {Map<string, AccountEntry>} Listed slots in sidebar order. */
            this._accounts = new Map();

            this._stack = new Gtk.Stack();
            this._toastOverlay = new Adw.ToastOverlay({child: this._stack});
            this._contentPage = new Adw.NavigationPage({
                title: '',
                child: createToolbarView(this._toastOverlay),
            });

            this._sidebar = new Adw.Sidebar();
            this._topBarPage = new TopBarPage(settings);
            this._behaviorPage = new BehaviorPage(settings);
            const generalSection = new Adw.SidebarSection({title: _('General')});
            for (const page of [
                this._topBarPage,
                this._behaviorPage,
                new NotificationsPage(settings),
            ]) {
                const item = new Adw.SidebarItem({title: page.title, icon_name: page.icon_name});
                generalSection.append(item);
                this._stack.add_child(page);
                this._pages.set(item, page);
            }
            this._sidebar.append(generalSection);
            this._accountsSection = new Adw.SidebarSection({title: _('Accounts')});
            this._sidebar.append(this._accountsSection);
            // Opens a dialog when activated; it never stays selected.
            this._addItem = new Adw.SidebarItem({
                title: _('Add Account…'),
                icon_name: 'list-add-symbolic',
            });
            // The item of the page in the stack, selected again when Add
            // Account… is.
            this._shownItem = null;
            this._syncAccounts();

            this._splitView = new Adw.NavigationSplitView({
                sidebar: new Adw.NavigationPage({title, child: createToolbarView(this._sidebar)}),
                content: this._contentPage,
            });
            this.child = this._splitView;

            const breakpoint = new Adw.Breakpoint({
                condition: Adw.BreakpointCondition.parse('max-width: 560sp'),
            });
            breakpoint.add_setter(this._splitView, 'collapsed', true);
            breakpoint.add_setter(this._sidebar, 'mode', Adw.SidebarMode.PAGE);
            this.add_breakpoint(breakpoint);

            this._showSelectedPage();
            this._sidebarSignalIds = [
                this._sidebar.connect('notify::selected', () => this._showSelectedPage()),
                this._sidebar.connect('activated', (_sidebar, index) => this._itemActivated(index)),
            ];
            this._accountsChangedId = this._settings.connect(
                `changed::${SettingsKey.ACCOUNTS}`,
                () => this._syncAccounts(),
            );
        }

        release() {
            this._cancellable.cancel();
            this._cancellable = null;
            this._settings.disconnect(this._accountsChangedId);
            this._accountsChangedId = 0;
            for (const signalId of this._sidebarSignalIds) this._sidebar.disconnect(signalId);
            this._sidebarSignalIds = [];

            for (const account of this._accounts.values()) this._releaseAccount(account);
            this._accounts.clear();
            this._pages.clear();
            this._topBarPage.release();
            this._behaviorPage.release();

            this._settings = null;
            this._iconsDirectory = null;
            this._secretStore = null;
            this._stack = null;
            this._toastOverlay = null;
            this._contentPage = null;
            this._sidebar = null;
            this._accountsSection = null;
            this._addItem = null;
            this._shownItem = null;
            this._topBarPage = null;
            this._behaviorPage = null;
            this._splitView = null;
        }

        _showSelectedPage() {
            const item = this._sidebar.selected_item;
            // Nothing is selected while the account items are replaced.
            if (item === null) return;
            if (item === this._addItem) {
                this._sidebar.selected = this._shownItem.get_index();
                return;
            }
            const page = this._pages.get(item);
            this._stack.visible_child = page;
            this._contentPage.title = page.title;
            this._shownItem = item;
        }

        _itemActivated(index) {
            if (this._sidebar.get_item(index) === this._addItem) {
                const dialog = new AddAccountDialog({
                    listedTypes: [...this._accounts.values()].map(({type}) => type.id),
                    iconsDirectory: this._iconsDirectory,
                    onTypeChosen: typeId => this._addAccount(PROVIDER_TYPES[typeId]),
                });
                dialog.present(this);
                return;
            }
            // The collapsed view shows the page only once an item is activated.
            this._splitView.show_content = true;
        }

        // Builds a page for each newly listed slot and drops those of unlisted
        // slots, then lists the items in the order of `accounts`. The selected
        // item stays selected; when its account is gone, the first page is.
        _syncAccounts() {
            const slots = listedSlots(this._settings.get_strv(SettingsKey.ACCOUNTS));
            const selectedItem = this._sidebar.selected_item;

            const accounts = new Map(
                slots.map(slot => [slot, this._accounts.get(slot) ?? this._createAccount(slot)]),
            );
            for (const [slot, account] of this._accounts) {
                if (accounts.has(slot)) continue;
                this._stack.remove(account.page);
                this._releaseAccount(account);
                this._pages.delete(account.item);
            }
            this._accounts = accounts;

            this._accountsSection.remove_all();
            for (const [index, {item, page}] of [...this._accounts.values()].entries()) {
                this._accountsSection.append(item);
                page.showPosition(index, this._accounts.size);
            }
            this._accountsSection.append(this._addItem);
            this._addItem.enabled =
                this._accounts.size < ACCOUNT_SLOTS.length &&
                this._settings.is_writable(SettingsKey.ACCOUNTS);
            this._sidebar.selected = this._pages.has(selectedItem) ? selectedItem.get_index() : 0;
        }

        /** @returns {AccountEntry} */
        _createAccount(slot) {
            const settings = this._settings.get_child(slot);
            // A listed account without an ID, such as the default first one, gets one.
            if (settings.get_string(AccountKey.INSTANCE_ID) === '')
                settings.set_string(AccountKey.INSTANCE_ID, GLib.uuid_string_random());
            const type = PROVIDER_TYPES[settings.get_string(AccountKey.TYPE)];
            const account = {
                settings,
                type,
                item: new Adw.SidebarItem(),
                page: new AccountPage(settings, type, {
                    slot,
                    secretStore: this._secretStore,
                    claimDirectory: directory => this._claimDirectory(slot, type, directory),
                    removable: this._settings.is_writable(SettingsKey.ACCOUNTS),
                    onMove: offset => this._moveAccount(slot, offset),
                    onRemove: () => this._removeAccount(slot, type),
                }),
                signalIds: [],
            };
            this._stack.add_child(account.page);
            this._pages.set(account.item, account.page);
            this._syncAccountItem(account);
            account.signalIds = [AccountKey.NAME, AccountKey.ENABLED].map(key =>
                settings.connect(`changed::${key}`, () => this._syncAccountItem(account)),
            );
            return account;
        }

        _releaseAccount(account) {
            for (const signalId of account.signalIds) account.settings.disconnect(signalId);
            account.signalIds = [];
            account.page.release();
        }

        // The item names the account; its subtitle names the provider of a
        // renamed account and marks disabled accounts.
        _syncAccountItem({settings, type, item, page}) {
            const name = accountName(settings, type);
            const renamed = settings.get_string(AccountKey.NAME) !== '';
            const enabled = settings.get_boolean(AccountKey.ENABLED);
            const typeName = providerTypeName(type, _);
            item.title = name;
            if (enabled) item.subtitle = renamed ? typeName : '';
            else
                item.subtitle = renamed
                    ? /* Translators: the subtitle of a renamed account that is off. %s is its provider's name, such as Codex. */
                      _('%s, off').format(typeName)
                    : _('Off');
            page.title = name;
            if (this._stack.visible_child === page) this._contentPage.title = name;
        }

        // Sets up the first free slot for `type` and lists it last. Shell
        // reacts to the list, so the slot is complete before it is listed.
        async _addAccount(type) {
            if (this._adding) return;
            this._adding = true;
            try {
                await this._setUpAccount(type);
            } finally {
                this._adding = false;
            }
        }

        async _setUpAccount(type) {
            const cancellable = this._cancellable;
            const listed = listedSlots(this._settings.get_strv(SettingsKey.ACCOUNTS));
            const slot = ACCOUNT_SLOTS.find(name => !listed.includes(name));
            if (slot === undefined) {
                this._showToast(
                    _('The account was not added, because no free account slot is left'),
                );
                return;
            }
            if (type.credential !== 'cli') {
                const result = await this._deleteKeys(slot, cancellable);
                if (cancellable.is_cancelled()) return;
                if (!keysGone(result)) {
                    this._showToast(
                        _(
                            'The account was not added, because an old API key could not be deleted from the keyring',
                        ),
                    );
                    return;
                }
            }

            // A second account on the CLI's default login would poll it twice.
            let directory = '';
            if (type.configDirectoryVariable !== null && this._directoryInUse(slot, type, '')) {
                directory = await chooseConfigurationDirectory(this, '', cancellable);
                if (cancellable.is_cancelled()) return;
                if (directory === null) {
                    this._showToast(
                        _(
                            'The account was not added: another account of this type uses the default login, so a new one needs its own configuration directory',
                        ),
                    );
                    return;
                }
                if (!this._claimDirectory(slot, type, directory)) return;
            }

            const settings = this._settings.get_child(slot);
            settings.delay();
            for (const key of settings.settings_schema.list_keys()) settings.reset(key);
            settings.set_string(AccountKey.TYPE, type.id);
            settings.set_string(AccountKey.INSTANCE_ID, GLib.uuid_string_random());
            settings.set_uint(AccountKey.REFRESH_INTERVAL, type.defaultRefreshSeconds);
            if (directory !== '') settings.set_string(AccountKey.CONFIG_DIRECTORY, directory);
            settings.apply();
            // The list can be locked while the account is set up.
            const added = this._settings.set_strv(SettingsKey.ACCOUNTS, [
                ...listedSlots(this._settings.get_strv(SettingsKey.ACCOUNTS)),
                slot,
            ]);
            if (added) this._sidebar.selected = this._accounts.get(slot).item.get_index();
        }

        // Whether another account of `type` than `slot` signs in from `directory`;
        // '' stands for the CLI's default directory, which an account without a
        // directory uses, as does one whose directory is that path.
        _directoryInUse(slot, type, directory) {
            const defaultDirectory = GLib.canonicalize_filename(
                GLib.getenv(type.configDirectoryVariable) ||
                    GLib.build_filenamev([GLib.get_home_dir(), DEFAULT_DIRECTORY_NAMES[type.id]]),
                null,
            );
            const effective = path =>
                path ? GLib.canonicalize_filename(path, null) : defaultDirectory;
            return [...this._accounts].some(([otherSlot, account]) => {
                if (otherSlot === slot || account.type !== type) return false;
                return (
                    effective(readAccountConfig(account.settings, otherSlot).configDirectory) ===
                    effective(directory)
                );
            });
        }

        // Whether `slot` may sign in from the chosen `directory`; says why not.
        _claimDirectory(slot, type, directory) {
            if (!this._directoryInUse(slot, type, directory)) return true;
            this._showToast(
                _(
                    'The directory was not used, because another account of this type already signs in from it',
                ),
            );
            return false;
        }

        _showToast(title) {
            this._toastOverlay.add_toast(new Adw.Toast({title}));
        }

        // Deletes the account's keys first: when that fails the account stays
        // listed, so nothing is left behind that the window could forget. Then
        // unlists the account, so Shell removes it, and resets its slot.
        async _removeAccount(slot, type) {
            if (type.credential !== 'cli') {
                const cancellable = this._cancellable;
                const result = await this._deleteKeys(slot, cancellable);
                if (cancellable.is_cancelled()) return;
                if (!keysGone(result)) {
                    this._showToast(
                        _(
                            'The account was not removed, because its API key could not be deleted from the keyring',
                        ),
                    );
                    return;
                }
            }
            this._settings.set_strv(
                SettingsKey.ACCOUNTS,
                listedSlots(this._settings.get_strv(SettingsKey.ACCOUNTS)).filter(
                    name => name !== slot,
                ),
            );
            const settings = this._settings.get_child(slot);
            settings.delay();
            for (const key of settings.settings_schema.list_keys()) settings.reset(key);
            settings.apply();
        }

        // Returns what SecretStore.deleteKeys() returns, or 'failed' when it threw.
        async _deleteKeys(slot, cancellable) {
            try {
                return await this._secretStore.deleteKeys(slot, cancellable);
            } catch (error) {
                if (!cancellable.is_cancelled())
                    logError(error, `Cannot delete the API keys of ${slot}`);
                return 'failed';
            }
        }

        _moveAccount(slot, offset) {
            const slots = listedSlots(this._settings.get_strv(SettingsKey.ACCOUNTS));
            const index = slots.indexOf(slot);
            [slots[index], slots[index + offset]] = [slots[index + offset], slots[index]];
            this._settings.set_strv(SettingsKey.ACCOUNTS, slots);
        }
    },
);

// Whether no key of a slot is left: deleted, or no keyring service runs, so none can exist.
function keysGone(result) {
    return result === 'deleted' || result === 'unavailable';
}

function createToolbarView(content) {
    const view = new Adw.ToolbarView({content});
    view.add_top_bar(new Adw.HeaderBar());
    return view;
}
