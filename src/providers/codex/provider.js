// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import {sha256} from '../../misc/digest.js';
import {codedError} from '../../misc/errors.js';
import {isRecord} from '../../misc/values.js';
import {PROVIDER_TYPES} from '../../shared/providerTypes.js';
import {createDiagnostic} from '../diagnostics.js';
import {createUsageResult} from '../usageResult.js';
import {normalizeAccount, normalizeAccountSnapshot} from './account.js';
import {AppServerConnection} from './appServer.js';
import {classifyError, createAppServerError, ErrorKind} from './errors.js';
import {normalizeRateLimits, normalizeResets, normalizeWorkspaceId} from './rateLimits.js';

// Issue codes keyed by normalizeAccount() status for every account that is not ready.
const ACCOUNT_ISSUES = Object.freeze({
    'signed-out': 'signed-out',
    unsupported: 'login-unsupported',
    unavailable: 'account-unavailable',
});

// The outcomes of account/rateLimitResetCredit/consume.
const REDEEM_OUTCOMES = Object.freeze(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

// Adds the setup guidance the menu offers and the values the issue text names.
function createIssue(code, {diagnostic = null, transient = false} = {}) {
    const issue = {code, setup: null, diagnostic, transient};
    if (code === 'cli-not-found') issue.setup = 'install';
    if (code === 'signed-out') {
        issue.setup = 'sign-in';
        issue.params = {command: 'codex login'};
    }
    return issue;
}

// A login in each of its workspaces is a different account. The key is saved
// to disk, so it is built from the opaque user and workspace IDs only, never
// from the email; without a user ID there is no key.
function accountKey(snapshot, workspaceDigest) {
    return snapshot.userId === null
        ? null
        : sha256(JSON.stringify(['chatgpt', snapshot.userId, workspaceDigest]));
}

// Identifies the workspace that a usage reply names, or null when it names none.
function workspaceDigest(limits) {
    const workspaceId = normalizeWorkspaceId(limits);
    return workspaceId === null ? null : sha256(workspaceId);
}

// A known credit list is read again after this long even when the count is
// unchanged: a replacement credit has a new ID but leaves the count as it was.
const RESET_DETAILS_MAX_AGE_SECONDS = 6 * 3600;

export class CodexProvider {
    /**
     * @param {object} params
     * @param {object} params.account  The AccountConfig; an empty configDirectory uses Codex's default login.
     * @param {string} params.version  Client version the app-server is told.
     * @param {object|null} [params.savedState]  The providerState of a result from an earlier session.
     * @param {object} [params.executableSearch]  Where to look for codex.
     * @param {function(): number} [params.now]  The clock in milliseconds.
     */
    constructor({account, version, savedState = null, executableSearch = {}, now = Date.now}) {
        this._version = version;
        this._now = now;
        this._configDirectory = account.configDirectory;
        this._executableSearch = executableSearch;
        // Owned until its onClosed callback.
        this._connection = null;
        this._cancellable = new Gio.Cancellable();
        // {accountKey, resets, readAt} from the last verified read that listed
        // reset credits; readAt is in seconds.
        this._resetDetails = null;
        // The account snapshot fingerprint and the workspace of the last
        // successful read, which a redemption must still find: a restarted
        // app-server may run another login, and a login may switch workspaces.
        this._verifiedFingerprint = null;
        this._verifiedWorkspaceDigest = null;
        // The workspace that the last usage reply named, also in an earlier
        // session, so that a failure right after a lock or restart keeps the
        // account's restored reading.
        this._workspaceDigest =
            typeof savedState?.workspaceDigest === 'string' ? savedState.workspaceDigest : null;
    }

    /** @returns {Promise<object>} The UsageResult; rejects only when destroyed. */
    async refresh() {
        const result = await this._readUsage();
        result.providerState = {workspaceDigest: this._workspaceDigest};
        return result;
    }

    async _readUsage() {
        // UsageController never runs two refreshes at once.
        const cancellable = this._cancellable;
        const result = createUsageResult({providerType: 'codex', account: normalizeAccount(null)});
        let operation = 'Read account';
        try {
            const connection = await this._connect(cancellable);
            const response = await connection.request('account/read', {refreshToken: false});
            cancellable.set_error_if_cancelled();
            result.account = normalizeAccount(response);
            const snapshot = normalizeAccountSnapshot(response);
            // Until this refresh's usage reply names the workspace, as when
            // the usage read fails, the login is taken to be in the last one.
            result.accountKey = accountKey(snapshot, this._workspaceDigest);
            if (result.account.status !== 'ready') {
                result.issue = createIssue(ACCOUNT_ISSUES[result.account.status]);
                return result;
            }

            operation = 'Read usage limits';
            // Listing reset credits costs Codex a separate lookup, so a known
            // list is read again only when the workspace or the available
            // count changes, when a listed credit expires (a replacement may
            // have a new ID) or when the list is old.
            const nowSeconds = Math.floor(this._now() / 1000);
            const details = this._resetDetails;
            const knownResets =
                details !== null &&
                details.accountKey === result.accountKey &&
                nowSeconds - details.readAt < RESET_DETAILS_MAX_AGE_SECONDS &&
                !details.resets.credits.some(
                    credit => credit.expiresAt !== null && credit.expiresAt <= nowSeconds,
                )
                    ? details.resets
                    : null;
            let limits = await connection.request(
                'account/rateLimits/read',
                knownResets ? {excludeResetCreditDetails: true} : undefined,
            );
            cancellable.set_error_if_cancelled();
            let resets = normalizeResets(limits);
            if (knownResets && resets?.credits === null) {
                if (
                    workspaceDigest(limits) === this._workspaceDigest &&
                    resets.available === knownResets.available
                ) {
                    resets = knownResets;
                } else {
                    limits = await connection.request('account/rateLimits/read');
                    cancellable.set_error_if_cancelled();
                    resets = normalizeResets(limits);
                }
            }
            this._workspaceDigest = workspaceDigest(limits);
            result.accountKey = accountKey(snapshot, this._workspaceDigest);
            // Recheck the account: a login change during the request invalidates the usage.
            operation = 'Verify account after reading usage';
            const currentResponse = await connection.request('account/read', {refreshToken: false});
            cancellable.set_error_if_cancelled();
            const current = normalizeAccount(currentResponse);
            if (snapshot.fingerprint !== normalizeAccountSnapshot(currentResponse).fingerprint) {
                result.account = current;
                result.accountKey = null;
                result.issue = createIssue('account-changed');
                return result;
            }
            operation = 'Interpret usage response';
            if (!isRecord(limits?.rateLimits))
                throw createAppServerError(
                    ErrorKind.INVALID_RESPONSE,
                    'Codex returned rate limits without rateLimits',
                );
            const buckets = normalizeRateLimits(limits);
            const usagePlan = buckets.find(
                bucket => bucket.id === PROVIDER_TYPES.codex.defaultLimitId,
            )?.plan;
            // Usage can report a newer entitlement than the stored login.
            if (usagePlan) current.plan = usagePlan;
            result.account = current;
            result.buckets = buckets;
            result.resets = resets;
            this._verifiedFingerprint = snapshot.fingerprint;
            this._verifiedWorkspaceDigest = this._workspaceDigest;
            this._resetDetails =
                result.accountKey !== null && resets?.credits
                    ? {accountKey: result.accountKey, resets, readAt: nowSeconds}
                    : null;
            return result;
        } catch (error) {
            cancellable.set_error_if_cancelled();
            const failure = classifyError(error);
            const diagnostic = createDiagnostic({
                providerName: PROVIDER_TYPES.codex.name,
                operation,
                error,
                summary: failure.summary,
            });
            result.issue = createIssue(failure.code, {diagnostic, transient: failure.transient});
            return result;
        }
    }

    /**
     * Redeems a manual reset, never during a refresh. A null creditId lets
     * Codex choose the next one; a retry of a failed attempt passes its
     * idempotencyKey again. stillAllowed is asked right before the request.
     *
     * @param {{creditId: string|null, idempotencyKey: string, stillAllowed: function(): boolean}} attempt
     * @returns {Promise<string>} One of REDEEM_OUTCOMES, where alreadyRedeemed means that an earlier try of the attempt
     *     succeeded. Without a request: 'unconfirmed' when the app-server runs no login, or another login or workspace
     *     than the last successful read, and 'withdrawn' when stillAllowed() returned false. Rejects with a redeem-failed
     *     error that carries a diagnostic, or with Gio CANCELLED after destroy().
     */
    async redeemReset({creditId, idempotencyKey, stillAllowed}) {
        const cancellable = this._cancellable;
        let operation = 'Verify account before redeeming';
        try {
            const connection = await this._connect(cancellable);
            const account = await connection.request('account/read', {refreshToken: false});
            cancellable.set_error_if_cancelled();
            const {fingerprint} = normalizeAccountSnapshot(account);
            if (fingerprint === null || fingerprint !== this._verifiedFingerprint)
                return 'unconfirmed';
            // A switch to another workspace keeps the login; only the usage
            // reply names the workspace that a reset would be used for.
            const limits = await connection.request('account/rateLimits/read', {
                excludeResetCreditDetails: true,
            });
            cancellable.set_error_if_cancelled();
            if (workspaceDigest(limits) !== this._verifiedWorkspaceDigest) return 'unconfirmed';
            if (!stillAllowed()) return 'withdrawn';
            operation = 'Redeem manual reset';
            const params = {idempotencyKey};
            if (creditId !== null) params.creditId = creditId;
            // The credits change even when the reply is lost, so the next
            // refresh lists them again.
            this._resetDetails = null;
            const response = await connection.request(
                'account/rateLimitResetCredit/consume',
                params,
            );
            cancellable.set_error_if_cancelled();
            const outcome = response?.outcome;
            if (!REDEEM_OUTCOMES.includes(outcome))
                throw createAppServerError(
                    ErrorKind.INVALID_RESPONSE,
                    'Codex returned an unknown reset outcome.',
                );
            return outcome;
        } catch (error) {
            cancellable.set_error_if_cancelled();
            const diagnostic = createDiagnostic({
                providerName: PROVIDER_TYPES.codex.name,
                operation,
                error,
                summary: 'Unable to redeem a Codex manual reset',
            });
            throw codedError('redeem-failed', 'Unable to redeem a Codex manual reset', {
                diagnostic,
            });
        }
    }

    // Returns the app-server connection, starting one when none is running.
    async _connect(cancellable) {
        if (this._connection) return this._connection;
        const connection = new AppServerConnection({
            version: this._version,
            configDirectory: this._configDirectory,
            executableSearch: this._executableSearch,
            onClosed: () => {
                this._connection = null;
            },
        });
        this._connection = connection;
        await connection.start();
        cancellable.set_error_if_cancelled();
        return connection;
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
        if (this._connection) this._connection.destroy();
        this._connection = null;
    }
}
