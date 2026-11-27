// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * A completed refresh, successful or not. Cancellation rejects instead.
 * Providers report codes from accounts/issues.js; all text is made by the
 * presentation.
 *
 * @typedef {object} UsageResult
 * @property {string} providerType The account's type, a PROVIDER_TYPES key.
 * @property {AccountInfo} account
 * @property {string|null} accountKey SHA-256 hex digest of the provider's
 * identity tuple; earlier usage is retained only for the same key. Null when
 * unverified.
 * @property {Array<UsageBucket>} buckets
 * @property {ManualResets|null} resets Null when not reported.
 * @property {UsageIssue|null} issue
 * @property {number|null} localRetryAfterSeconds Delay before rechecking local
 * credentials. Null when an HTTP request was made.
 * @property {object|null} providerState Small JSON-safe state, without
 * secrets, that the provider wants back in the next session.
 */

/**
 * @typedef {object} AccountInfo
 * @property {'ready'|'signed-out'|'unsupported'|'unavailable'|'setup-required'} status
 * @property {string|null} identity Email or login from the service; shown,
 * never saved.
 * @property {string|null} plan Plan name as the service names it.
 */

/**
 * @typedef {object} UsageIssue
 * @property {string} code A code from accounts/issues.js.
 * @property {object} [params] Values for its text, such as {version: '1.1.11'}.
 * @property {'install'|'sign-in'|'update'|'api-key'|'settings'|null} setup
 * Guidance the menu offers.
 * @property {{summary: string, details: string, logText: string, key: string}|null} diagnostic
 * Sanitized English error details for the menu; null for account states such
 * as signed-out. logText is the part that may reach the journal, without the
 * message or process output. key identifies the failure without its process output.
 * @property {boolean} transient Whether earlier usage may still be shown.
 * @property {number} [retryAfterSeconds] Delay the service asked for, such as
 * after HTTP 429.
 */

/**
 * @typedef {object} UsageBucket
 * @property {string} id
 * @property {string|null} name Service or product name; null for an unnamed
 * credit grant.
 * @property {string|null} plan
 * @property {Array<UsageWindow>} windows
 * @property {Array<{code: string, params?: object}>} statuses Codes from
 * accounts/issues.js.
 * @property {{unlimited: boolean, available: boolean, balance: number|null}|null} credits
 * @property {Money|null} money
 */

/**
 * @typedef {object} UsageWindow
 * @property {string} id Not unique within a bucket. 'quota' has no fixed window;
 * 'credit' is a one-time grant that never resets.
 * @property {number|null} durationMinutes
 * @property {number|null} remainingPercent Null when unknown.
 * @property {number|null} resetsAt Unix seconds; always null for credits.
 * @property {number|null} [expiresAt] Credits only: Unix seconds, or null.
 */

/**
 * @typedef {object} Money
 * @property {'extra-usage'|'key-limit'|'allowance'|'balance'} kind
 * @property {string} currency ISO 4217 code.
 * @property {number|null} used In major units, such as dollars.
 * @property {number|null|undefined} limit The cap in major units; null when
 * the account has no cap of its own (not the same as unlimited); undefined
 * when the cap is unknown.
 * @property {number|null} balance
 * @property {boolean|null} enabled Claude extra usage only.
 */

/**
 * @typedef {object} ManualResets
 * @property {number} available The authoritative count.
 * @property {Array<{id: string, title: string|null, expiresAt: number|null, status: string}>|null} credits Possibly capped;
 * null when only the count is known.
 */

/** @returns {UsageResult} */
export function createUsageResult({
    providerType,
    account,
    accountKey = null,
    buckets = [],
    resets = null,
    issue = null,
    localRetryAfterSeconds = null,
    providerState = null,
}) {
    return {
        providerType,
        account,
        accountKey,
        buckets,
        resets,
        issue,
        localRetryAfterSeconds,
        providerState,
    };
}

/** @returns {UsageBucket} Without a plan, windows, statuses, Codex credits or money unless given. */
export function createBucket({
    id,
    name,
    plan = null,
    windows = [],
    statuses = [],
    credits = null,
    money = null,
}) {
    return {id, name, plan, windows, statuses, credits, money};
}
