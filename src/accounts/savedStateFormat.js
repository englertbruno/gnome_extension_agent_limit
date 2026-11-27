// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {isRecord} from '../misc/values.js';
import {BUCKET_STATUS_CODES} from './issues.js';

// The version of the saved shapes, UsageResult included; files of another
// one are ignored.
const SAVED_FORMAT = 2;
export const MAX_READING_FILE_BYTES = 64 * 1024;
export const MAX_HISTORY_FILE_BYTES = 512 * 1024;
// An older reading is not shown.
const MAX_READING_AGE_SECONDS = 7 * 24 * 3600;
// A restored retry delay never exceeds this, whatever the clock did; it is
// the longest Retry-After that providers/http.js honours.
const MAX_RETRY_SECONDS = 24 * 3600;
// Each list in the notification state keeps at most this many entries.
export const MAX_NOTIFIED_ENTRIES = 32;

/**
 * The state an account keeps across sessions. Times are wall-clock Unix
 * seconds.
 *
 * @typedef {object} SavedReading
 * @property {UsageResult|null} reading The last successful result, without
 * the account's identity, an issue or provider state.
 * @property {number|null} readAt When the reading was accepted.
 * @property {number|null} requestedAt The last provider request when the
 * file was written.
 * @property {number|null} retryAt End of a delay the service asked for.
 * @property {object|null} providerState What the provider gets back next
 * session, such as a backoff: a record of numbers, booleans, nulls and
 * SHA-256 digests, so that it cannot hold an email, a name or a token.
 * @property {NotifiedState|null} notified
 */

/**
 * The notification trackers' states, as their `state` getters return them,
 * and the manual reset attempts; each is optional. Keys are built from the
 * account key digest and the service's limit and credit IDs.
 *
 * @typedef {object} NotifiedState
 * @property {Array<{key: string, resetsAt: number|null, armed: boolean}>} [lowRemaining]
 * LowRemainingTracker
 * @property {Array<[string, number]>} [unused] UnusedReminder
 * @property {Array<[string, number]>} [resetExpiry] ResetExpiryTracker
 * @property {Array<[string, string|null]>} [redeem] RedeemAttempts: the
 * SHA-256 digest of the credit ID, and the UUID idempotency key of an attempt
 * without an outcome or null.
 */

const isNumberOrNull = value => value === null || Number.isFinite(value);

// Account keys are SHA-256 digests; anything else could identify the account.
function isDigest(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

// As GLib.uuid_string_random() returns them.
function isUuid(value) {
    return (
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    );
}

// The fields of a UsageResult that may be saved. The account's identity, the
// issue and the provider state are dropped, and a key that is not a digest.
function savedResult(result) {
    return {
        providerType: result.providerType,
        account: {status: result.account.status, identity: null, plan: result.account.plan},
        accountKey: isDigest(result.accountKey) ? result.accountKey : null,
        buckets: result.buckets,
        resets: result.resets,
        issue: null,
        localRetryAfterSeconds: null,
        providerState: null,
    };
}

// A bucket status as presentation.js shows it; statusText() throws on another code.
function isStatus(value) {
    return (
        isRecord(value) &&
        BUCKET_STATUS_CODES.includes(value.code) &&
        (value.params === undefined || isRecord(value.params))
    );
}

// The fields presentation.js reads, so that a restored reading always shows.
function isSavedResult(value) {
    return (
        isRecord(value) &&
        typeof value.providerType === 'string' &&
        isRecord(value.account) &&
        typeof value.account.status === 'string' &&
        (value.account.plan === null || typeof value.account.plan === 'string') &&
        (value.accountKey === null || isDigest(value.accountKey)) &&
        Array.isArray(value.buckets) &&
        value.buckets.every(
            bucket =>
                isRecord(bucket) &&
                typeof bucket.id === 'string' &&
                (bucket.name === null || typeof bucket.name === 'string') &&
                Array.isArray(bucket.statuses) &&
                bucket.statuses.every(isStatus) &&
                (bucket.money === null || isRecord(bucket.money)) &&
                Array.isArray(bucket.windows) &&
                bucket.windows.every(
                    window =>
                        isRecord(window) &&
                        isNumberOrNull(window.durationMinutes) &&
                        isNumberOrNull(window.remainingPercent) &&
                        isNumberOrNull(window.resetsAt),
                ),
        ) &&
        isResets(value.resets)
    );
}

// The manual resets of a Codex reading: the available count, and the credits
// when the service listed them. presentation.js reads every field.
function isResets(value) {
    return (
        value === null ||
        (isRecord(value) &&
            Number.isSafeInteger(value.available) &&
            value.available >= 0 &&
            (value.credits === null ||
                (Array.isArray(value.credits) &&
                    value.credits.every(
                        credit =>
                            isRecord(credit) &&
                            typeof credit.id === 'string' &&
                            typeof credit.status === 'string' &&
                            (credit.title === null || typeof credit.title === 'string') &&
                            isNumberOrNull(credit.expiresAt),
                    ))))
    );
}

function isProviderState(value) {
    return (
        isRecord(value) &&
        Object.values(value).every(
            item =>
                item === null ||
                typeof item === 'boolean' ||
                Number.isFinite(item) ||
                isDigest(item),
        )
    );
}

// [key, Unix seconds] entries.
function isTimedEntries(value) {
    return (
        Array.isArray(value) &&
        value.length <= MAX_NOTIFIED_ENTRIES &&
        value.every(
            entry =>
                Array.isArray(entry) &&
                entry.length === 2 &&
                typeof entry[0] === 'string' &&
                Number.isFinite(entry[1]),
        )
    );
}

const NOTIFIED_SHAPES = Object.freeze({
    lowRemaining: value =>
        Array.isArray(value) &&
        value.length <= MAX_NOTIFIED_ENTRIES &&
        value.every(
            entry =>
                isRecord(entry) &&
                Object.keys(entry).length === 3 &&
                typeof entry.key === 'string' &&
                isNumberOrNull(entry.resetsAt) &&
                typeof entry.armed === 'boolean',
        ),
    unused: isTimedEntries,
    resetExpiry: isTimedEntries,
    redeem: value =>
        Array.isArray(value) &&
        value.length <= MAX_NOTIFIED_ENTRIES &&
        value.every(
            entry =>
                Array.isArray(entry) &&
                entry.length === 2 &&
                isDigest(entry[0]) &&
                (entry[1] === null || isUuid(entry[1])),
        ),
});

// The states of a NotifiedState record that have their known shape; any
// other is left out, whatever it holds.
function savedNotified(notified) {
    return Object.fromEntries(
        Object.entries(notified).filter(
            ([name, state]) => Object.hasOwn(NOTIFIED_SHAPES, name) && NOTIFIED_SHAPES[name](state),
        ),
    );
}

function isSeries(points) {
    return (
        Array.isArray(points) &&
        points.every(
            point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite),
        )
    );
}

function encode(file, maxBytes) {
    const contents = new TextEncoder().encode(JSON.stringify(file));
    return contents.length <= maxBytes ? contents : null;
}

// Returns the decoded file, or null when it is too large, damaged, of another
// format or saved for another provider configuration.
function decode(contents, maxBytes, config) {
    if (contents.length > maxBytes) return null;
    let file;
    try {
        file = JSON.parse(new TextDecoder().decode(contents));
    } catch {
        return null;
    }
    return isRecord(file) && file.format === SAVED_FORMAT && file.config === config ? file : null;
}

/**
 * Returns the contents of a reading file, or null when they would exceed its
 * size limit. Provider state of another shape is saved as null, and
 * notification states of another shape are left out.
 *
 * @param {SavedReading} saved
 * @param {{config: string, savedAt: number}} file config is the digest of
 * the provider configuration the state belongs to.
 * @returns {Uint8Array|null}
 */
export function serializeSavedReading(saved, {config, savedAt}) {
    return encode(
        {
            format: SAVED_FORMAT,
            config,
            savedAt,
            reading: saved.reading === null ? null : savedResult(saved.reading),
            readAt: saved.reading === null ? null : saved.readAt,
            requestedAt: saved.requestedAt,
            retryAt: saved.retryAt,
            providerState: isProviderState(saved.providerState) ? saved.providerState : null,
            notified: isRecord(saved.notified) ? savedNotified(saved.notified) : null,
        },
        MAX_READING_FILE_BYTES,
    );
}

/**
 * Returns the state saved in a reading file, without a reading older than
 * seven days or notification states of another shape, or null when the file
 * is not usable.
 *
 * @param {Uint8Array} contents
 * @param {{config: string, nowSeconds: number}} expected
 * @returns {SavedReading|null}
 */
export function parseSavedReading(contents, {config, nowSeconds}) {
    const file = decode(contents, MAX_READING_FILE_BYTES, config);
    if (
        file === null ||
        !(file.reading === null || (isSavedResult(file.reading) && Number.isFinite(file.readAt))) ||
        !isNumberOrNull(file.requestedAt) ||
        !isNumberOrNull(file.retryAt) ||
        !(file.providerState === null || isProviderState(file.providerState)) ||
        !(file.notified === null || isRecord(file.notified))
    )
        return null;
    const current = file.reading !== null && nowSeconds - file.readAt <= MAX_READING_AGE_SECONDS;
    return {
        reading: current ? savedResult(file.reading) : null,
        readAt: current ? file.readAt : null,
        requestedAt: file.requestedAt,
        retryAt: file.retryAt,
        providerState: file.providerState,
        notified: file.notified === null ? null : savedNotified(file.notified),
    };
}

/**
 * Returns the contents of a history file, or null when they would exceed its
 * size limit.
 *
 * @param {UsageHistory} history
 * @param {{config: string}} file
 * @returns {Uint8Array|null}
 */
export function serializeSavedHistory(history, {config}) {
    return encode(
        {
            format: SAVED_FORMAT,
            config,
            accountKey: isDigest(history.accountKey) ? history.accountKey : null,
            series: history.series,
        },
        MAX_HISTORY_FILE_BYTES,
    );
}

/**
 * @param {Uint8Array} contents
 * @param {{config: string}} expected
 * @returns {UsageHistory|null} Null when the file is not usable.
 */
export function parseSavedHistory(contents, {config}) {
    const file = decode(contents, MAX_HISTORY_FILE_BYTES, config);
    if (
        file === null ||
        !(file.accountKey === null || isDigest(file.accountKey)) ||
        !isRecord(file.series) ||
        !Object.values(file.series).every(isSeries)
    )
        return null;
    return {accountKey: file.accountKey, series: file.series};
}

/**
 * Converts saved wall-clock times to the controller's monotonic clock. A
 * clock set back cannot extend the request floor beyond its length or a
 * retry delay beyond a day.
 *
 * @param {SavedReading} saved
 * @param {{wallNow: number, monoNow: number, minRefreshSeconds: number}} clocks
 * @returns {{readAt: number|null, lastRefreshAt: number|null, retryAt: number|null}}
 * Monotonic seconds; retryAt is null once the delay has passed.
 */
export function restoreTimes(
    {readAt, requestedAt, retryAt},
    {wallNow, monoNow, minRefreshSeconds},
) {
    return {
        readAt: readAt === null ? null : monoNow - Math.max(0, wallNow - readAt),
        lastRefreshAt:
            requestedAt === null
                ? null
                : monoNow - Math.min(Math.max(0, wallNow - requestedAt), minRefreshSeconds),
        retryAt:
            retryAt === null || retryAt <= wallNow
                ? null
                : monoNow + Math.min(retryAt - wallNow, MAX_RETRY_SECONDS),
    };
}
