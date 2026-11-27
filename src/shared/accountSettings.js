// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {PROVIDER_TYPES} from './providerTypes.js';
import {AccountKey} from './settings.js';

/** The main schema's account children; the slot name identifies the account. */
export const ACCOUNT_SLOTS = Object.freeze(
    Array.from({length: 16}, (_, index) => `account-${index}`),
);

/**
 * The slots that an `accounts` value lists, in its order. Repeats and other
 * names are dropped: settings can be edited outside preferences, and
 * Gio.Settings.get_child() aborts on a name the schema lacks.
 */
export function listedSlots(names) {
    return [...new Set(names)].filter(name => ACCOUNT_SLOTS.includes(name));
}

/**
 * The settings of one account that decide what Shell runs for it.
 *
 * @typedef {object} AccountConfig
 * @property {string} slot               Child name, such as 'account-3'.
 * @property {string} type               A PROVIDER_TYPES ID.
 * @property {string} name               Display name; empty shows the type's name.
 * @property {boolean} enabled
 * @property {string} instanceId         Random ID set when the account is added; '' until preferences or Shell write
 *     one. While '', no state is saved and no API key is stored or read.
 * @property {string} configDirectory    Absolute path that selects the CLI's login; '' uses the CLI's default.
 * @property {string|null} kimiRegion    'china' or 'international'; Kimi Code only.
 * @property {{url: string, authHeader: string, authPrefix: string, mapping: object}|null} endpoint
 *     Custom endpoints only; mapping is the CustomMapping of the response fields.
 */

/** @returns {AccountConfig} */
export function readAccountConfig(settings, slot) {
    const type = settings.get_string(AccountKey.TYPE);
    const directory = settings.get_string(AccountKey.CONFIG_DIRECTORY);
    return {
        slot,
        type,
        name: settings.get_string(AccountKey.NAME),
        enabled: settings.get_boolean(AccountKey.ENABLED),
        instanceId: settings.get_string(AccountKey.INSTANCE_ID),
        // A relative path would depend on the CLI's working directory.
        configDirectory:
            PROVIDER_TYPES[type].configDirectoryVariable !== null && directory.startsWith('/')
                ? directory
                : '',
        kimiRegion: type === 'kimi' ? settings.get_string(AccountKey.KIMI_REGION) : null,
        endpoint:
            type === 'custom'
                ? {
                      url: settings.get_string(AccountKey.ENDPOINT_URL),
                      authHeader: settings.get_string(AccountKey.AUTH_HEADER),
                      authPrefix: settings.get_string(AccountKey.AUTH_PREFIX),
                      mapping: {
                          percentPointer: settings.get_string(AccountKey.PERCENT_POINTER),
                          percentMeaning: settings.get_string(AccountKey.PERCENT_MEANING),
                          usedPointer: settings.get_string(AccountKey.USED_POINTER),
                          limitPointer: settings.get_string(AccountKey.LIMIT_POINTER),
                          resetPointer: settings.get_string(AccountKey.RESET_POINTER),
                          windowMinutes: settings.get_uint(AccountKey.WINDOW_MINUTES),
                      },
                  }
                : null,
    };
}

/**
 * Canonical text of everything an account's provider is created from, so a
 * changed key means the account must be created again. The instance ID keeps
 * a removed account's saved state from matching a new account in its slot.
 */
export function providerConfigKey({instanceId, type, configDirectory, kimiRegion, endpoint}) {
    return JSON.stringify([instanceId, type, configDirectory, kimiRegion, endpoint]);
}
