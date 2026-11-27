// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sha256} from '../../misc/digest.js';
import {PROVIDER_TYPES} from '../../shared/providerTypes.js';
import {createDiagnostic} from '../diagnostics.js';
import {UsageHttpClient} from '../http.js';
import {
    failureCode,
    isTemporaryFailure,
    restoreBackoffSeconds,
    retryAfterFailure,
} from '../httpFailure.js';
import {createUsageResult} from '../usageResult.js';

// A key that was not found is read again this soon, without counting as a
// request: the read is a local D-Bus call, and neither unlocking the keyring
// nor starting it changes a setting.
const LOCAL_RETRY_SECONDS = 30;

// After HTTP 429, wait a minute, doubling up to an hour, or longer if
// Retry-After asks for it.
const MIN_BACKOFF_SECONDS = 60;

// Keyed by the ApiKeyReader states other than 'found'.
const KEY_ISSUES = Object.freeze({
    missing: {
        status: 'setup-required',
        code: 'api-key-missing',
        setup: 'api-key',
        transient: false,
    },
    locked: {status: 'unavailable', code: 'keyring-locked', setup: null, transient: true},
    unavailable: {
        status: 'unavailable',
        code: 'keyring-unavailable',
        setup: null,
        transient: false,
    },
});

/**
 * Reads the usage of a service that takes the account's API key from the
 * keyring. The key is read on every refresh and kept only until it returns.
 */
export class ApiKeyProvider {
    /**
     * @param {object} params
     * @param {object} params.account  The AccountConfig.
     * @param {object} params.service  OPENROUTER, DEEPSEEK, OLLAMA or KIMI: the
     *     usage URL of an account, the normalization of its response and
     *     optionally statusIssues, the issue codes of HTTP statuses the service
     *     documents with a meaning of their own.
     * @param {ApiKeyReader} params.apiKeys  Shared with other providers; not owned.
     * @param {object|null} [params.savedState]  The providerState of a result from an earlier session.
     * @param {UsageHttpClient} [params.client]  Owned.
     * @param {function(): number} [params.now]  Milliseconds since the epoch.
     */
    constructor({
        account,
        service,
        apiKeys,
        savedState = null,
        client = new UsageHttpClient(),
        now = () => Date.now(),
    }) {
        this._account = account;
        this._type = PROVIDER_TYPES[account.type];
        this._service = service;
        this._url = service.usageUrl(account);
        // The service and its host identify the account, never the key.
        const host = GLib.Uri.parse(this._url, GLib.UriFlags.NONE).get_host();
        this._accountKey = sha256(JSON.stringify([account.type, host]));
        this._apiKeys = apiKeys;
        this._client = client;
        this._now = now;
        this._cancellable = new Gio.Cancellable();
        // Delay before the next request after consecutive HTTP 429 responses,
        // also after a lock or restart.
        this._backoffSeconds = restoreBackoffSeconds(savedState);
    }

    /** @returns {Promise<object>} The UsageResult; rejects only when destroyed. */
    async refresh() {
        const result = await this._readUsage();
        result.providerState = {backoffSeconds: this._backoffSeconds};
        return result;
    }

    async _readUsage() {
        const cancellable = this._cancellable;
        const result = createUsageResult({
            providerType: this._type.id,
            account: {status: 'unavailable', identity: null, plan: null},
        });
        let operation = 'Read API key';
        try {
            const lookup = await this._apiKeys.lookup(this._account, cancellable);
            cancellable.set_error_if_cancelled();
            if (lookup.state !== 'found') {
                const {status, code, setup, transient} = KEY_ISSUES[lookup.state];
                result.account.status = status;
                result.issue = {code, setup, diagnostic: null, transient};
                result.localRetryAfterSeconds = LOCAL_RETRY_SECONDS;
                return result;
            }

            operation = 'Read usage';
            const response = await this._client.getJson(
                {url: this._url, headers: {Authorization: `Bearer ${lookup.key}`}},
                cancellable,
            );
            cancellable.set_error_if_cancelled();
            operation = 'Interpret usage response';
            const {buckets, plan} = this._service.normalize(
                response,
                Math.floor(this._now() / 1000),
            );
            this._backoffSeconds = 0;
            result.account = {status: 'ready', identity: null, plan};
            result.accountKey = this._accountKey;
            result.buckets = buckets;
            if (buckets.length === 0)
                result.issue = {code: 'no-usage', setup: null, diagnostic: null, transient: false};
            return result;
        } catch (error) {
            cancellable.set_error_if_cancelled();
            const serviceCode = this._service.statusIssues?.[error.status];
            if (serviceCode !== undefined) {
                result.issue = {code: serviceCode, setup: null, diagnostic: null, transient: false};
                return result;
            }
            if (error.status === 401 || error.status === 403) {
                result.account.status = 'setup-required';
                result.issue = {
                    code: 'api-key-rejected',
                    setup: 'api-key',
                    diagnostic: null,
                    transient: false,
                };
                return result;
            }
            const code = failureCode(error);
            result.issue = {
                code,
                setup: null,
                diagnostic: createDiagnostic({
                    providerName: this._type.name,
                    operation,
                    error,
                    summary: `${this._type.name} usage is unavailable`,
                }),
                transient: isTemporaryFailure(code),
            };
            const retry = retryAfterFailure(error, this._backoffSeconds, MIN_BACKOFF_SECONDS);
            this._backoffSeconds = retry.backoffSeconds;
            if (retry.retryAfterSeconds !== null)
                result.issue.retryAfterSeconds = retry.retryAfterSeconds;
            return result;
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
        this._client.destroy();
        this._client = null;
        this._apiKeys = null;
    }
}
