// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Attributes of the keyring items that hold API keys. `schemaName` is the
// settings schema ID from metadata.json.

import {endpointOrigin} from './endpointRules.js';

/** Attributes shared by every API key stored for an account slot, of any type. */
export function slotKeyAttributes(schemaName, slot) {
    return {'xdg:schema': `${schemaName}.ApiKey`, account: slot};
}

/**
 * Attributes of the API key of `account`. The type and the instance ID keep
 * an account that later reuses the slot from reading a key that an earlier
 * account left, as when no keyring service ran to delete it. A Kimi Code key
 * belongs to its region, which has keys of its own, and a custom endpoint's
 * key to the scheme, host and port of its URL, so that neither is sent to
 * another host that the setting was changed to.
 *
 * @param {string} schemaName
 * @param {{slot: string, type: string, instanceId: string, kimiRegion: string|null, endpoint: {url: string}|null}} account
 */
export function apiKeyAttributes(schemaName, {slot, type, instanceId, kimiRegion, endpoint}) {
    const attributes = {...slotKeyAttributes(schemaName, slot), type, 'instance-id': instanceId};
    if (kimiRegion !== null) attributes.region = kimiRegion;
    if (endpoint !== null) attributes.origin = endpointOrigin(endpoint.url);
    return attributes;
}
