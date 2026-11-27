// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {apiKeyAttributes, slotKeyAttributes} from '../shared/secretSchema.js';
import {
    callSecretService,
    closeSession,
    isServiceMissing,
    NO_OBJECT,
    openPlainSession,
    readDefaultCollection,
    searchItems,
    SECRET_SERVICE_NAME,
    SecretInterface,
} from '../shared/secretService.js';
import './promisify.js';

// The label libsecret gives the default keyring when it creates one.
const DEFAULT_KEYRING_LABEL = 'Default keyring';

/**
 * Shows a keyring prompt and returns its result, or null when the user
 * dismissed it. Rejects when the service exits before the prompt completes.
 */
async function completePrompt(bus, prompt, cancellable) {
    const {promise: completed, resolve, reject} = Promise.withResolvers();
    const subscriptionId = bus.signal_subscribe(
        SECRET_SERVICE_NAME,
        SecretInterface.PROMPT,
        'Completed',
        prompt,
        null,
        Gio.DBusSignalFlags.NONE,
        (_connection, _sender, _path, _interface, _signal, parameters) => {
            const [dismissed, result] = parameters.deepUnpack();
            resolve(dismissed ? null : result);
        },
    );
    const watchId = Gio.bus_watch_name_on_connection(
        bus,
        SECRET_SERVICE_NAME,
        Gio.BusNameWatcherFlags.NONE,
        null,
        () =>
            reject(
                new GLib.Error(
                    Gio.DBusError,
                    Gio.DBusError.NAME_HAS_NO_OWNER,
                    'The Secret Service exited during a prompt',
                ),
            ),
    );
    const cancelledId = cancellable.connect(() =>
        reject(
            new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled'),
        ),
    );
    try {
        // Subscribed first: the service may emit Completed before Prompt() returns.
        const [result] = await Promise.all([
            completed,
            callSecretService(
                bus,
                {
                    path: prompt,
                    interfaceName: SecretInterface.PROMPT,
                    method: 'Prompt',
                    parameters: new GLib.Variant('(s)', ['']),
                    replyType: '()',
                },
                cancellable,
            ),
        ]);
        return result;
    } finally {
        cancellable.disconnect(cancelledId);
        Gio.bus_unwatch_name(watchId);
        bus.signal_unsubscribe(subscriptionId);
    }
}

/** Unlocks `objects`, prompting if needed; false when the user dismissed the prompt. */
async function unlock(bus, objects, cancellable) {
    const [, prompt] = await callSecretService(
        bus,
        {
            interfaceName: SecretInterface.SERVICE,
            method: 'Unlock',
            parameters: new GLib.Variant('(ao)', [objects]),
            replyType: '(aoo)',
        },
        cancellable,
    );
    return prompt === NO_OBJECT || (await completePrompt(bus, prompt, cancellable)) !== null;
}

/**
 * Returns the default keyring, unlocked, or null when the user dismissed the
 * prompt. Like libsecret, creates the keyring when there is none.
 */
async function unlockDefaultKeyring(bus, cancellable) {
    const collection = await readDefaultCollection(bus, cancellable);
    if (collection !== NO_OBJECT)
        return (await unlock(bus, [collection], cancellable)) ? collection : null;

    const [created, prompt] = await callSecretService(
        bus,
        {
            interfaceName: SecretInterface.SERVICE,
            method: 'CreateCollection',
            parameters: new GLib.Variant('(a{sv}s)', [
                {
                    'org.freedesktop.Secret.Collection.Label': new GLib.Variant(
                        's',
                        DEFAULT_KEYRING_LABEL,
                    ),
                },
                'default',
            ]),
            replyType: '(oo)',
        },
        cancellable,
    );
    if (prompt === NO_OBJECT) return created;
    const result = await completePrompt(bus, prompt, cancellable);
    return result === null ? null : result.deepUnpack();
}

/**
 * Stores and deletes the API keys that Shell reads. Unlike Shell, it may make
 * the keyring prompt, to unlock it or to create it when there is none, so call
 * storeKey(), deleteKey() and deleteKeys() only when the user asked for the change.
 */
export class SecretStore {
    /** @param {{schemaName: string}} params  The settings schema ID from metadata.json. */
    constructor({schemaName}) {
        this._schemaName = schemaName;
    }

    /**
     * Whether a key of `account` is stored, locked or not. A key belongs to
     * the account's instance ID, so an account without one has none.
     *
     * @param {{slot: string, type: string, instanceId: string, kimiRegion: string|null, endpoint: {url: string}|null}} account
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<'stored'|'missing'|'unavailable'>}
     */
    async keyStatus(account, cancellable) {
        if (account.instanceId === '') return 'missing';
        const bus = await Gio.DBus.get(Gio.BusType.SESSION, cancellable);
        try {
            const {unlocked, locked} = await searchItems(
                bus,
                apiKeyAttributes(this._schemaName, account),
                cancellable,
            );
            return unlocked.length > 0 || locked.length > 0 ? 'stored' : 'missing';
        } catch (error) {
            if (isServiceMissing(error)) return 'unavailable';
            throw error;
        }
    }

    /**
     * Stores `key` for `account` in the default keyring, replacing its previous
     * key. An account without an instance ID, whose settings could not be
     * saved, gets none: another account in its slot could read it.
     *
     * @param {{slot: string, type: string, instanceId: string, kimiRegion: string|null, endpoint: {url: string}|null}} account
     * @param {string} label  Shown by keyring managers such as Passwords and Keys.
     * @param {string} key
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<'stored'|'dismissed'|'unavailable'|'no-instance-id'>}
     */
    async storeKey(account, label, key, cancellable) {
        if (account.instanceId === '') return 'no-instance-id';
        const bus = await Gio.DBus.get(Gio.BusType.SESSION, cancellable);
        try {
            const collection = await unlockDefaultKeyring(bus, cancellable);
            if (collection === null) return 'dismissed';

            const session = await openPlainSession(bus);
            try {
                cancellable.set_error_if_cancelled();
                const properties = {
                    'org.freedesktop.Secret.Item.Label': new GLib.Variant('s', label),
                    'org.freedesktop.Secret.Item.Attributes': new GLib.Variant(
                        'a{ss}',
                        apiKeyAttributes(this._schemaName, account),
                    ),
                };
                const secret = [
                    session,
                    new Uint8Array(),
                    new TextEncoder().encode(key),
                    'text/plain',
                ];
                const [, prompt] = await callSecretService(
                    bus,
                    {
                        path: collection,
                        interfaceName: SecretInterface.COLLECTION,
                        method: 'CreateItem',
                        // Replaces the item with the same attributes.
                        parameters: new GLib.Variant('(a{sv}(oayays)b)', [
                            properties,
                            secret,
                            true,
                        ]),
                        replyType: '(oo)',
                    },
                    cancellable,
                );
                if (
                    prompt !== NO_OBJECT &&
                    (await completePrompt(bus, prompt, cancellable)) === null
                )
                    return 'dismissed';
                return 'stored';
            } finally {
                await closeSession(bus, session);
            }
        } catch (error) {
            if (isServiceMissing(error)) return 'unavailable';
            throw error;
        }
    }

    /**
     * Deletes the key of `account`, from every keyring. Locked keys are
     * unlocked first.
     *
     * @param {{slot: string, type: string, instanceId: string, kimiRegion: string|null, endpoint: {url: string}|null}} account
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<'deleted'|'dismissed'|'unavailable'>}
     */
    deleteKey(account, cancellable) {
        return this._deleteItems(apiKeyAttributes(this._schemaName, account), cancellable);
    }

    /**
     * Deletes every API key stored for `slot`, of any account or type. Locked
     * keys are unlocked first.
     *
     * @param {string} slot
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<'deleted'|'dismissed'|'unavailable'>}
     */
    deleteKeys(slot, cancellable) {
        return this._deleteItems(slotKeyAttributes(this._schemaName, slot), cancellable);
    }

    async _deleteItems(attributes, cancellable) {
        const bus = await Gio.DBus.get(Gio.BusType.SESSION, cancellable);
        try {
            const {unlocked, locked} = await searchItems(bus, attributes, cancellable);
            if (locked.length > 0 && !(await unlock(bus, locked, cancellable))) return 'dismissed';
            for (const item of [...unlocked, ...locked]) {
                const [prompt] = await callSecretService(
                    bus,
                    {
                        path: item,
                        interfaceName: SecretInterface.ITEM,
                        method: 'Delete',
                        replyType: '(o)',
                    },
                    cancellable,
                );
                if (
                    prompt !== NO_OBJECT &&
                    (await completePrompt(bus, prompt, cancellable)) === null
                )
                    return 'dismissed';
            }
            return 'deleted';
        } catch (error) {
            if (isServiceMissing(error)) return 'unavailable';
            throw error;
        }
    }
}
