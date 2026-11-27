// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import '../misc/promisify.js';
import {apiKeyAttributes} from '../shared/secretSchema.js';
import {
    closeSession,
    getSecret,
    isServiceMissing,
    openPlainSession,
    readDefaultCollection,
    searchItems,
} from '../shared/secretService.js';

/**
 * Keeps only the items in the default keyring, if any are. Preferences store
 * keys there, so an item in another keyring is left from before the default
 * changed. The Secret Service puts each item's path below its keyring's.
 */
async function preferDefaultKeyring(bus, {unlocked, locked}, cancellable) {
    const collection = await readDefaultCollection(bus, cancellable);
    const inDefault = item => item.startsWith(`${collection}/`);
    if (!unlocked.some(inDefault) && !locked.some(inDefault)) return {unlocked, locked};
    return {unlocked: unlocked.filter(inDefault), locked: locked.filter(inDefault)};
}

/**
 * Reads API keys that the preferences stored in the keyring. It never unlocks
 * the keyring, so it never prompts: a locked key is reported as locked.
 */
export class ApiKeyReader {
    /** @param {{schemaName: string}} params  The settings schema ID from metadata.json. */
    constructor({schemaName}) {
        this._schemaName = schemaName;
    }

    /**
     * Reads the key of `account` on each call; the key is not kept.
     *
     * @param {{slot: string, type: string, instanceId: string, kimiRegion: string|null, endpoint: {url: string}|null}} account
     *     The AccountConfig; a Kimi Code key is found only for its region, a custom endpoint's only for its URL's scheme,
     *     host and port.
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<{state: 'found', key: string}|{state: 'missing'|'locked'|'unavailable'}>}
     */
    async lookup(account, cancellable) {
        // A key belongs to the account's instance ID; an account without one has none.
        if (account.instanceId === '') return {state: 'missing'};
        const bus = await Gio.DBus.get(Gio.BusType.SESSION, cancellable);
        try {
            let items = await searchItems(
                bus,
                apiKeyAttributes(this._schemaName, account),
                cancellable,
            );
            if (items.unlocked.length + items.locked.length > 1)
                items = await preferDefaultKeyring(bus, items, cancellable);
            const {unlocked, locked} = items;
            if (unlocked.length === 0) return {state: locked.length > 0 ? 'locked' : 'missing'};

            const session = await openPlainSession(bus);
            try {
                cancellable.set_error_if_cancelled();
                const key = await getSecret(bus, unlocked[0], session, cancellable);
                // The item was locked after the search.
                return key === null ? {state: 'locked'} : {state: 'found', key};
            } finally {
                await closeSession(bus, session);
            }
        } catch (error) {
            if (isServiceMissing(error)) return {state: 'unavailable'};
            throw error;
        }
    }
}
