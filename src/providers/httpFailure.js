// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// What a failed HTTP request means for the account: its issue code, whether
// earlier usage stays shown, and when the next request may follow.

const MAX_BACKOFF_SECONDS = 3600;

const TEMPORARY_FAILURES = Object.freeze([
    'rate-limited',
    'service-unavailable',
    'timeout',
    'network',
]);

/** The issue code of a failed HTTP request, other than a rejected login or key. */
export function failureCode(error) {
    if (error.status === 429) return 'rate-limited';
    if (error.status >= 500) return 'service-unavailable';
    if (error.code === 'timeout' || error.code === 'network') return error.code;
    if (['invalid-json', 'invalid-response', 'response-too-large'].includes(error.code))
        return 'invalid-response';
    return 'usage-unavailable';
}

/** Whether a failure with this issue code may pass by itself; earlier usage stays shown meanwhile. */
export function isTemporaryFailure(code) {
    return TEMPORARY_FAILURES.includes(code);
}

/**
 * The delay after consecutive failures: the minimum, then doubling up to an
 * hour.
 */
export function nextBackoffSeconds(previousSeconds, minimumSeconds) {
    return Math.min(MAX_BACKOFF_SECONDS, Math.max(minimumSeconds, previousSeconds * 2));
}

/** The delay after HTTP 429 that a provider saved in an earlier session; 0 when it saved none. */
export function restoreBackoffSeconds(savedState) {
    return Number.isFinite(savedState?.backoffSeconds) ? savedState.backoffSeconds : 0;
}

/**
 * When the next request may follow a failed one. After HTTP 429 the delay is
 * the backoff, or a longer Retry-After. The Retry-After of a 5xx response is
 * honored as sent, without the backoff.
 *
 * @param {Error} error  The failure, as UsageHttpClient.getJson() rejects.
 * @param {number} backoffSeconds  The delay after the previous HTTP 429; 0 after a success.
 * @param {number} minimumSeconds  The provider's delay after a first HTTP 429.
 * @returns {{backoffSeconds: number, retryAfterSeconds: number|null}} The delay to keep for the next HTTP 429, and
 *     the delay before the next request; null leaves it to the refresh interval.
 */
export function retryAfterFailure(error, backoffSeconds, minimumSeconds) {
    const code = failureCode(error);
    if (code === 'rate-limited') {
        const seconds = nextBackoffSeconds(backoffSeconds, minimumSeconds);
        return {
            backoffSeconds: seconds,
            retryAfterSeconds: Math.max(seconds, error.retryAfterSeconds ?? 0),
        };
    }
    if (code === 'service-unavailable' && error.retryAfterSeconds)
        return {backoffSeconds, retryAfterSeconds: error.retryAfterSeconds};
    return {backoffSeconds, retryAfterSeconds: null};
}
