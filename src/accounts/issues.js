// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {providerTypeName} from '../shared/providerTypes.js';

/**
 * The text of an issue a provider reported. Product names and commands are
 * values, never part of a translatable sentence.
 *
 * @param {{code: string, params?: object}} issue A UsageIssue.
 * @param {object} options
 * @param {{gettext: Function}} options.i18n
 * @param {object} options.providerType The account's PROVIDER_TYPES entry.
 * @returns {string}
 */
export function issueText({code, params = {}}, {i18n, providerType}) {
    const {gettext: _} = i18n;
    const name = providerTypeName(providerType, _);
    switch (code) {
        case 'cli-not-found':
            /* Translators: %s is a product name, such as Codex. */
            return _('%s CLI not found').format(name);
        case 'cli-update-required':
            /* Translators: %1$s is a product name and %2$s a version number. */
            return _('Update %1$s CLI to version %2$s or later').format(name, params.version);
        case 'signed-out':
            /* Translators: %s is a product name, such as Codex. */
            if (params.command === undefined) return _('Open %s CLI and sign in').format(name);
            /* Translators: %1$s is a product name and %2$s a command, such as codex login. */
            return _('Sign in to %1$s using %2$s').format(name, params.command);
        case 'login-expired':
            /* Translators: %s is a product name, such as Codex. */
            return _('%s login expired; open its CLI to renew it').format(name);
        case 'login-unsupported':
            /* Translators: %s is a product name, such as Codex. */
            return _('%s usage limits are unavailable for this login').format(name);
        case 'not-eligible':
            /* Translators: %s is a product name, such as Codex. */
            return _('This account is not eligible for %s').format(name);
        case 'account-unavailable':
            /* Translators: %s is a product name, such as Codex. */
            return _('%s account information is unavailable').format(name);
        case 'account-changed':
            return _('Account changed; refreshing usage on the next check');
        case 'no-quotas':
            /* Translators: %s is a product name, such as Codex. */
            return _('%s CLI returned no model quotas').format(name);
        case 'no-usage':
            /* Translators: %s is a product name, such as DeepSeek. */
            return _('%s returned no usage data').format(name);
        case 'api-key-missing':
            return _('No API key stored. Add one in Settings.');
        case 'api-key-rejected':
            return _('The service rejected the API key');
        case 'account-suspended':
            /* Translators: %s is a product name, such as Ollama Cloud. */
            return _('%s account is suspended').format(name);
        case 'keyring-locked':
            return _('Unlock the login keyring to read the API key');
        case 'keyring-unavailable':
            return _('No keyring service is running');
        case 'endpoint-missing':
            return _('No endpoint URL is set');
        case 'endpoint-insecure':
            return _('The endpoint URL must use HTTPS unless it is on this computer');
        case 'endpoint-header-invalid':
            return _('The API key cannot be sent with these key header settings');
        case 'mapping-failed':
            return _('The endpoint reply does not match the field mapping');
        case 'rate-limited':
            /* Translators: %s is a product name, such as Codex, or Custom endpoint. */
            return _('%s usage checks are temporarily rate limited').format(name);
        case 'timeout':
            /* Translators: %s is a product name, such as Codex, or Custom endpoint. */
            return _('%s did not respond').format(name);
        case 'network':
            /* Translators: %s is a product name, such as Codex, or Custom endpoint. */
            return _('Cannot connect to %s').format(name);
        case 'service-unavailable':
            /* Translators: %s is a product name, such as Codex, or Custom endpoint. */
            return _('%s is temporarily unavailable').format(name);
        case 'process-stopped':
            /* Translators: %s is a product name, such as Codex. */
            return _('%s process stopped unexpectedly').format(name);
        case 'invalid-response':
            /* Translators: %s is a product name, such as Codex, or Custom endpoint. */
            return _('%s returned an invalid response').format(name);
        // A code without a text of its own still leaves the indicator usable.
        case 'usage-unavailable':
        default:
            /* Translators: %s is a product name, such as Codex, or Custom endpoint. */
            return _('%s usage is unavailable').format(name);
    }
}

/** The codes of the statuses that providers report on a bucket. */
export const BUCKET_STATUS_CODES = Object.freeze([
    'rate-limit-reached',
    'workspace-credits-depleted',
    'member-credits-depleted',
    'workspace-usage-limit',
    'member-usage-limit',
    'limit-status',
    'spending-limit-reached',
    'unavailable-for-account',
]);

/**
 * The text of a bucket status, or of a status the presentation derives.
 *
 * @param {{code: string, params?: object}} status
 * @param {object} options
 * @param {{gettext: Function}} options.i18n
 * @returns {string}
 */
export function statusText({code, params = {}}, {i18n}) {
    const {gettext: _} = i18n;
    switch (code) {
        case 'rate-limit-reached':
            return _('Rate limit reached');
        case 'workspace-credits-depleted':
            return _('Workspace credits depleted');
        case 'member-credits-depleted':
            return _('Member credits depleted');
        case 'workspace-usage-limit':
            return _('Workspace usage limit reached');
        case 'member-usage-limit':
            return _('Member usage limit reached');
        case 'limit-status':
            /* Translators: %s is a status the service reports, in English. */
            return _('Limit status: %s').format(params.type);
        case 'spending-limit-reached':
            return _('Spending limit reached');
        case 'unavailable-for-account':
            return _('Unavailable for this account');
        case 'selected-limit-unavailable':
            return _('Selected limit is unavailable for this account');
        case 'no-windows':
            return _('No quota windows were returned');
        case 'window-exhausted':
            return _('A usage window is exhausted');
        case 'stale':
            return _('Usage is stale');
    }
    throw new Error(`Unknown status code: ${code}`);
}
