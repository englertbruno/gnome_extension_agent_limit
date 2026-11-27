// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sha256} from '../../misc/digest.js';
import {codedError} from '../../misc/errors.js';
import {loadRegularFile} from '../../misc/files.js';
import '../../misc/promisify.js';
import {PROVIDER_TYPES} from '../../shared/providerTypes.js';
import {createDiagnostic} from '../diagnostics.js';
import {createExecutableLauncher, findExecutable, SIGTERM} from '../executable.js';
import {UsageHttpClient} from '../http.js';
import {
    failureCode,
    isTemporaryFailure,
    nextBackoffSeconds,
    restoreBackoffSeconds,
    retryAfterFailure,
} from '../httpFailure.js';
import {createUsageResult} from '../usageResult.js';
import {credentialState, normalizeAccount} from './account.js';
import {isUsageResponse, normalizeRateLimits} from './rateLimits.js';

const MAX_CREDENTIALS_BYTES = 64 * 1024;

/** Reads Claude Code's saved login, or returns null when there is none. */
async function readCredentials(directory, cancellable) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([directory, '.credentials.json']));
    let contents;
    try {
        // The directory is user-configurable, so the file may be anything.
        contents = await loadRegularFile(file, MAX_CREDENTIALS_BYTES, cancellable);
    } catch (error) {
        if (error.code === 'unusable-file')
            throw codedError(
                'invalid-credentials',
                'The Claude Code credentials file is not a regular file of a plausible size',
            );
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return null;
        throw error;
    }
    try {
        return JSON.parse(new TextDecoder().decode(contents));
    } catch {
        // Parser errors can quote the file, which holds credentials.
        throw codedError(
            'invalid-credentials',
            'The Claude Code credentials file contains invalid JSON',
        );
    }
}

const RENEW_LOGIN_TIMEOUT_SECONDS = 30;
const LOCAL_RETRY_SECONDS = 30;

// After `claude doctor` fails to start, it is tried again after 5 minutes,
// doubling up to an hour, so that a broken CLI is not launched repeatedly.
const MIN_SPAWN_BACKOFF_SECONDS = 300;

// Keyed by credentialState(), and by 'not-installed' for an expired login
// that no installed Claude Code can renew. HTTP 401 reports 'expired' and
// HTTP 403 'unsupported'. Codes are those of accounts/issues.js.
const LOGIN_ISSUES = Object.freeze({
    'signed-out': {
        status: 'signed-out',
        code: 'signed-out',
        params: {command: 'claude auth login'},
        setup: 'sign-in',
    },
    expired: {status: 'signed-out', code: 'login-expired', params: null, setup: 'sign-in'},
    'not-installed': {status: 'signed-out', code: 'cli-not-found', params: null, setup: 'install'},
    unsupported: {status: 'unsupported', code: 'login-unsupported', params: null, setup: null},
});

// After HTTP 429, wait 5 minutes, doubling up to an hour, or longer if
// Retry-After asks for it.
const MIN_BACKOFF_SECONDS = 300;

// The English summary of the diagnostic, which the journal and the error
// details show.
function failureSummary(error) {
    if (error.status === 429) return 'Claude usage checks are temporarily rate limited';
    if (error.code === 'timeout') return 'Claude usage request timed out';
    return 'Claude usage is unavailable';
}

function setLoginIssue(result, state) {
    const {status, code, params, setup} = LOGIN_ISSUES[state];
    result.account = {status, identity: null, plan: null};
    result.accountKey = null;
    result.issue = {code, setup, diagnostic: null, transient: false};
    if (params !== null) result.issue.params = {...params};
}

// Identifies an expired login by the directory it is in and when it expired,
// so that a renewed login differs. The key is saved to disk, so it holds no
// token, and the directory only as a digest.
function expiredCredentialKey(credentials, state, directory) {
    if (state !== 'expired') return null;
    return sha256(JSON.stringify([directory, credentials.claudeAiOauth.expiresAt]));
}

export class ClaudeProvider {
    /**
     * @param {object} params
     * @param {object} params.account  The AccountConfig; an empty configDirectory uses Claude Code's default login.
     * @param {object|null} [params.savedState]  The providerState of a result from an earlier session.
     * @param {UsageHttpClient} [params.client]  Owned.
     * @param {object} [params.executableSearch]  Where to look for claude.
     * @param {function(): number} [params.now]  Milliseconds since the epoch.
     */
    constructor({
        account,
        savedState = null,
        client = new UsageHttpClient(),
        executableSearch = {},
        now = () => Date.now(),
    }) {
        this._configDirectory = account.configDirectory;
        this._client = client;
        this._executableSearch = executableSearch;
        this._now = now;
        this._cancellable = new Gio.Cancellable();
        // The running `claude doctor` process and its timeout, if any.
        this._renewProcess = null;
        this._renewTimeoutId = 0;
        // After a failed start of `claude doctor`: the delay it doubles and
        // the time before which it is not tried again. Not kept across restarts.
        this._renewSpawnBackoffSeconds = 0;
        this._renewSpawnRetryAt = 0;
        // Identifies the expired login last renewed, so renewal is not repeated,
        // also after a lock or restart. It reaches the disk with a result, so a
        // renewal that a lock interrupts is not saved. Any other saved value
        // matches no login.
        this._renewAttemptKey = savedState?.renewAttemptKey ?? null;
        // {tokenDigest, account, accountKey}; the profile is reread when the
        // access token changes.
        this._profile = null;
        // Delay before the next request after consecutive HTTP 429 responses,
        // also after a lock or restart.
        this._backoffSeconds = restoreBackoffSeconds(savedState);
    }

    /** @returns {Promise<UsageResult>} See providers/usageResult.js. */
    async refresh() {
        const result = await this._readUsage();
        result.providerState = {
            renewAttemptKey: this._renewAttemptKey,
            backoffSeconds: this._backoffSeconds,
        };
        return result;
    }

    async _readUsage() {
        const cancellable = this._cancellable;
        const result = createUsageResult({providerType: 'claude', account: normalizeAccount(null)});
        let operation = 'Read Claude Code credentials';
        let httpAttempted = false;
        try {
            // The account's directory, else the one Claude Code itself would use.
            const directory =
                this._configDirectory ||
                GLib.getenv('CLAUDE_CONFIG_DIR') ||
                GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
            let credentials = await readCredentials(directory, cancellable);
            cancellable.set_error_if_cancelled();
            let state = credentialState(credentials, this._now());
            const renewalKey = expiredCredentialKey(credentials, state, directory);
            if (renewalKey !== this._renewAttemptKey) this._renewAttemptKey = null;
            if (
                renewalKey !== null &&
                this._renewAttemptKey === null &&
                this._now() >= this._renewSpawnRetryAt
            ) {
                operation = 'Renew Claude Code login';
                const installed = await this._renewLogin(renewalKey, cancellable);
                cancellable.set_error_if_cancelled();
                if (!installed) {
                    setLoginIssue(result, 'not-installed');
                    result.localRetryAfterSeconds = LOCAL_RETRY_SECONDS;
                    return result;
                }
                operation = 'Read Claude Code credentials';
                credentials = await readCredentials(directory, cancellable);
                cancellable.set_error_if_cancelled();
                state = credentialState(credentials, this._now());
                if (expiredCredentialKey(credentials, state, directory) !== this._renewAttemptKey)
                    this._renewAttemptKey = null;
            }
            if (state !== 'ready') {
                setLoginIssue(result, state);
                result.localRetryAfterSeconds = LOCAL_RETRY_SECONDS;
                return result;
            }
            const token = credentials.claudeAiOauth.accessToken;
            const tokenDigest = sha256(token);
            const headers = {
                Authorization: `Bearer ${token}`,
                // The beta header Claude Code sends with its OAuth requests.
                'anthropic-beta': 'oauth-2025-04-20',
            };
            // The OAuth endpoints Claude Code uses for its profile and usage.
            if (this._profile?.tokenDigest !== tokenDigest) {
                operation = 'Read account';
                httpAttempted = true;
                const profile = await this._client.getJson(
                    {url: 'https://api.anthropic.com/api/oauth/profile', headers},
                    cancellable,
                );
                cancellable.set_error_if_cancelled();
                const account = normalizeAccount(profile);
                if (account.status !== 'ready')
                    throw codedError(
                        'invalid-response',
                        'Claude returned an invalid account profile',
                    );
                const accountKey = sha256(
                    JSON.stringify([profile.account.uuid, profile.organization.uuid]),
                );
                this._profile = {tokenDigest, account, accountKey};
            }
            result.account = this._profile.account;
            result.accountKey = this._profile.accountKey;

            // Reuses the profile's token, so both describe the same account.
            operation = 'Read usage limits';
            httpAttempted = true;
            const usage = await this._client.getJson(
                {url: 'https://api.anthropic.com/api/oauth/usage', headers},
                cancellable,
            );
            cancellable.set_error_if_cancelled();
            operation = 'Interpret usage response';
            if (!isUsageResponse(usage))
                throw codedError('invalid-response', 'Claude returned an invalid usage response');
            result.buckets = normalizeRateLimits(usage);
            this._backoffSeconds = 0;
            return result;
        } catch (error) {
            cancellable.set_error_if_cancelled();
            // Recheck local credentials soon; HTTP failures wait for the normal interval.
            if (!httpAttempted) result.localRetryAfterSeconds = LOCAL_RETRY_SECONDS;
            if (error.status === 401 || error.status === 403) {
                setLoginIssue(result, error.status === 401 ? 'expired' : 'unsupported');
                return result;
            }
            const code = failureCode(error);
            const diagnostic = createDiagnostic({
                providerName: PROVIDER_TYPES.claude.name,
                operation,
                error,
                summary: failureSummary(error),
            });
            result.issue = {code, setup: null, diagnostic, transient: isTemporaryFailure(code)};
            const retry = retryAfterFailure(error, this._backoffSeconds, MIN_BACKOFF_SECONDS);
            this._backoffSeconds = retry.backoffSeconds;
            if (retry.retryAfterSeconds !== null)
                result.issue.retryAfterSeconds = retry.retryAfterSeconds;
            return result;
        }
    }

    /**
     * Only Claude Code renews its login; `claude doctor` renews an expired one.
     * It does not report the outcome, so the caller rereads the credentials.
     * Records `renewalKey` as attempted once the process has started, so a
     * failed renewal is not repeated on every refresh.
     *
     * @returns {Promise<boolean>} False when Claude Code is not installed;
     * nothing is recorded then, so the next refresh looks for it again.
     */
    async _renewLogin(renewalKey, cancellable) {
        // The user's installed Claude Code CLI.
        const executable = await findExecutable('claude', cancellable, this._executableSearch);
        cancellable.set_error_if_cancelled();
        if (!executable) return false;
        const launcher = createExecutableLauncher(
            executable,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        );
        if (this._configDirectory)
            launcher.setenv('CLAUDE_CONFIG_DIR', this._configDirectory, true);
        let process;
        try {
            process = launcher.spawnv([executable, 'doctor']);
        } catch (error) {
            // A failed spawn is retried, but not at every refresh.
            this._renewSpawnBackoffSeconds = nextBackoffSeconds(
                this._renewSpawnBackoffSeconds,
                MIN_SPAWN_BACKOFF_SECONDS,
            );
            this._renewSpawnRetryAt = this._now() + this._renewSpawnBackoffSeconds * 1000;
            throw error;
        }
        this._renewSpawnBackoffSeconds = 0;
        // Only a started run counts as an attempt.
        this._renewAttemptKey = renewalKey;
        this._renewProcess = process;
        if (this._renewTimeoutId) GLib.Source.remove(this._renewTimeoutId);
        this._renewTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            RENEW_LOGIN_TIMEOUT_SECONDS,
            () => {
                this._renewTimeoutId = 0;
                // GSubprocess reaps the process once it exits.
                process.send_signal(SIGTERM);
                return GLib.SOURCE_REMOVE;
            },
        );
        try {
            await process.wait_async(cancellable);
        } finally {
            // destroy() has already released both when it cancelled the wait.
            if (!cancellable.is_cancelled()) {
                if (this._renewTimeoutId) {
                    GLib.Source.remove(this._renewTimeoutId);
                    this._renewTimeoutId = 0;
                }
                this._renewProcess = null;
            }
        }
        return true;
    }

    destroy() {
        if (this._renewTimeoutId) {
            GLib.Source.remove(this._renewTimeoutId);
            this._renewTimeoutId = 0;
        }
        if (this._renewProcess) this._renewProcess.send_signal(SIGTERM);
        this._renewProcess = null;
        this._cancellable.cancel();
        this._cancellable = null;
        this._client.destroy();
        this._client = null;
        this._profile = null;
        this._renewAttemptKey = null;
    }
}
