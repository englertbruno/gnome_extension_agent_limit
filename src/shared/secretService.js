// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Calls to the freedesktop Secret Service, which the GNOME keyring provides on
// the session bus: https://specifications.freedesktop.org/secret-service/latest/
// Importers load their process's promisify.js, which lets this module await
// Gio.DBusConnection.call().

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SECRET_SERVICE_PATH = '/org/freedesktop/secrets';
export const SECRET_SERVICE_NAME = 'org.freedesktop.secrets';
// The object path the service returns for no object, such as no prompt.
export const NO_OBJECT = '/';

export const SecretInterface = Object.freeze({
    SERVICE: 'org.freedesktop.Secret.Service',
    COLLECTION: 'org.freedesktop.Secret.Collection',
    ITEM: 'org.freedesktop.Secret.Item',
    SESSION: 'org.freedesktop.Secret.Session',
    PROMPT: 'org.freedesktop.Secret.Prompt',
});

/**
 * Calls `method` on a Secret Service object and returns the unpacked reply.
 * The object defaults to the service itself.
 */
export async function callSecretService(
    connection,
    {path = SECRET_SERVICE_PATH, interfaceName, method, parameters = null, replyType},
    cancellable,
) {
    const reply = await connection.call(
        SECRET_SERVICE_NAME,
        path,
        interfaceName,
        method,
        parameters,
        new GLib.VariantType(replyType),
        Gio.DBusCallFlags.NONE,
        -1,
        cancellable,
    );
    return reply.deepUnpack();
}

/** Whether `error` means that no Secret Service runs on the session bus. */
export function isServiceMissing(error) {
    return (
        error instanceof GLib.Error && error.matches(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN)
    );
}

/**
 * Opens a session that transfers secrets unencrypted over the session bus and
 * returns its path. Not cancellable: a call cancelled after it was sent would
 * leave the session open in the service.
 */
export async function openPlainSession(connection) {
    const [, session] = await callSecretService(
        connection,
        {
            interfaceName: SecretInterface.SERVICE,
            method: 'OpenSession',
            parameters: new GLib.Variant('(sv)', ['plain', new GLib.Variant('s', '')]),
            replyType: '(vo)',
        },
        null,
    );
    return session;
}

/** Closes a session from openPlainSession(); not cancellable, so it always closes. */
export async function closeSession(connection, session) {
    await callSecretService(
        connection,
        {path: session, interfaceName: SecretInterface.SESSION, method: 'Close', replyType: '()'},
        null,
    );
}

/** Returns the path of the default keyring, or NO_OBJECT when there is none. */
export async function readDefaultCollection(connection, cancellable) {
    const [collection] = await callSecretService(
        connection,
        {
            interfaceName: SecretInterface.SERVICE,
            method: 'ReadAlias',
            parameters: new GLib.Variant('(s)', ['default']),
            replyType: '(o)',
        },
        cancellable,
    );
    return collection;
}

/** Returns the items whose attributes include `attributes`, split by whether they are locked. */
export async function searchItems(connection, attributes, cancellable) {
    const [unlocked, locked] = await callSecretService(
        connection,
        {
            interfaceName: SecretInterface.SERVICE,
            method: 'SearchItems',
            parameters: new GLib.Variant('(a{ss})', [attributes]),
            replyType: '(aoao)',
        },
        cancellable,
    );
    return {unlocked, locked};
}

/** Returns the secret of `item` as text, or null when the item is locked. */
export async function getSecret(connection, item, session, cancellable) {
    const [secrets] = await callSecretService(
        connection,
        {
            interfaceName: SecretInterface.SERVICE,
            method: 'GetSecrets',
            parameters: new GLib.Variant('(aoo)', [[item], session]),
            replyType: '(a{o(oayays)})',
        },
        cancellable,
    );
    // The service leaves out locked items.
    if (!Object.hasOwn(secrets, item)) return null;
    const [, , value] = secrets[item];
    return new TextDecoder().decode(value);
}
