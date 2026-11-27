// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import {sha256} from '../../misc/digest.js';
import {codedError} from '../../misc/errors.js';
import {applyMapping} from '../../shared/customMapping.js';
import {endpointHost, isAllowedEndpointUrl, isValidHeaderName} from '../../shared/endpointRules.js';
import {PROVIDER_TYPES} from '../../shared/providerTypes.js';
import {createDiagnostic} from '../diagnostics.js';
import {UsageHttpClient} from '../http.js';
import {
    failureCode,
    isTemporaryFailure,
    restoreBackoffSeconds,
    retryAfterFailure,
} from '../httpFailure.js';
import {createBucket, createUsageResult} from '../usageResult.js';

const PROVIDER_NAME = PROVIDER_TYPES.custom.name;

// The guidance that an issue of this provider offers; its other issues offer
// none.
const ISSUE_SETUP = Object.freeze({
    'endpoint-missing': 'settings',
    'endpoint-insecure': 'settings',
    'endpoint-header-invalid': 'settings',
    'mapping-failed': 'settings',
    'api-key-missing': 'api-key',
    'api-key-rejected': 'api-key',
});

// The issue of HTTP 401 or 403, by what the key lookup found. A key that the
// keyring could not be asked for may be the one the endpoint needs.
const AUTH_ISSUES = Object.freeze({
    found: 'api-key-rejected',
    missing: 'api-key-missing',
    unavailable: 'keyring-unavailable',
});

// A result found before any request is checked again this soon, and does not
// count as a request. Unlocking the keyring changes no setting; a changed
// setting creates the provider again.
const LOCAL_RETRY_SECONDS = 30;

// After HTTP 429, wait a minute, doubling up to an hour, or longer if
// Retry-After asks for it.
const MIN_BACKOFF_SECONDS = 60;

// libsoup drops a header value with line breaks, with a warning, and cuts a
// value at NUL.
const HEADER_VALUE_FORBIDDEN = /[\0\r\n]/u;

function failureSummary(code) {
    if (code === 'rate-limited') return 'Custom endpoint requests are temporarily rate limited';
    if (code === 'timeout') return 'Custom endpoint request timed out';
    if (code === 'mapping-failed') return 'Custom endpoint response does not match its mapping';
    return 'Custom endpoint usage is unavailable';
}

function issueResult(code, {params = {}, diagnostic = null} = {}) {
    const setup = ISSUE_SETUP[code] ?? null;
    // An earlier reading stays shown while the keyring is locked and through
    // a temporary failure of the request.
    const transient = code === 'keyring-locked' || isTemporaryFailure(code);
    return createUsageResult({
        providerType: 'custom',
        account: {
            status: setup === null ? 'unavailable' : 'setup-required',
            identity: null,
            plan: null,
        },
        issue: {code, params, setup, diagnostic, transient},
    });
}

// The result of a check that sent no request.
function localIssueResult(code) {
    const result = issueResult(code);
    result.localRetryAfterSeconds = LOCAL_RETRY_SECONDS;
    return result;
}

/** Reads usage from a JSON endpoint that the user configured. */
export class CustomEndpointProvider {
    /**
     * @param {object} params
     * @param {object} params.account  The AccountConfig of a custom account.
     * @param {object} params.apiKeys  The shared ApiKeyReader; not owned.
     * @param {object|null} [params.savedState]  The providerState of a result from an earlier session.
     * @param {UsageHttpClient} [params.client]  Owned.
     */
    constructor({account, apiKeys, savedState = null, client = new UsageHttpClient()}) {
        this._account = account;
        this._apiKeys = apiKeys;
        this._client = client;
        this._cancellable = new Gio.Cancellable();
        // Delay before the next request after consecutive HTTP 429 responses,
        // also after a lock or restart.
        this._backoffSeconds = restoreBackoffSeconds(savedState);
    }

    /** @returns {Promise<object>} A UsageResult; rejects only when destroyed. */
    async refresh() {
        const result = await this._readUsage();
        result.providerState = {backoffSeconds: this._backoffSeconds};
        return result;
    }

    async _readUsage() {
        const cancellable = this._cancellable;
        const {url, authHeader, authPrefix, mapping} = this._account.endpoint;
        // The key is never read for, or sent to, a URL that is not allowed.
        if (url === '') return localIssueResult('endpoint-missing');
        if (!isAllowedEndpointUrl(url)) return localIssueResult('endpoint-insecure');

        let operation = 'Read API key';
        let keyState = null;
        try {
            // Only a key stored for the URL's host is found.
            const apiKey = await this._apiKeys.lookup(this._account, cancellable);
            cancellable.set_error_if_cancelled();
            keyState = apiKey.state;
            if (keyState === 'locked') return localIssueResult('keyring-locked');
            const headers = {};
            if (keyState === 'found') {
                const value = `${authPrefix}${apiKey.key.trim()}`;
                if (!isValidHeaderName(authHeader) || HEADER_VALUE_FORBIDDEN.test(value))
                    return localIssueResult('endpoint-header-invalid');
                headers[authHeader] = value;
            }

            operation = 'Read usage';
            const response = await this._client.getJson({url, headers}, cancellable);
            cancellable.set_error_if_cancelled();
            this._backoffSeconds = 0;

            const mapped = applyMapping(response, mapping);
            if (mapped.error) {
                const {error, pointer} = mapped;
                // Only 'no-value' has no pointer. Response values may be private
                // and are left out.
                const message = pointer
                    ? `Cannot use the value at JSON Pointer ${pointer}`
                    : 'The mapping names no usage value';
                return issueResult('mapping-failed', {
                    params: {error, pointer},
                    diagnostic: createDiagnostic({
                        providerName: PROVIDER_NAME,
                        operation: 'Map usage response',
                        error: codedError(error, message),
                        summary: failureSummary('mapping-failed'),
                    }),
                });
            }
            return createUsageResult({
                providerType: 'custom',
                account: {status: 'ready', identity: null, plan: null},
                // The host identifies the account, never the key or the rest
                // of the URL, which may hold a token.
                accountKey: sha256(JSON.stringify(['custom', endpointHost(url)])),
                buckets: [createBucket({id: 'custom', name: null, windows: [mapped.window]})],
            });
        } catch (error) {
            cancellable.set_error_if_cancelled();
            if (error.status === 401 || error.status === 403)
                return issueResult(AUTH_ISSUES[keyState]);
            const code = failureCode(error);
            const result = issueResult(code, {
                diagnostic: createDiagnostic({
                    providerName: PROVIDER_NAME,
                    operation,
                    error,
                    summary: failureSummary(code),
                }),
            });
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
        this._account = null;
    }
}
