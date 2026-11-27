// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {nonemptyString} from '../../misc/values.js';

const PLAN_NAMES = Object.freeze({
    claude_free: 'Free',
    claude_pro: 'Pro',
    claude_max: 'Max',
    claude_team: 'Team',
    claude_enterprise: 'Enterprise',
});

export function credentialState(credentials, nowMilliseconds) {
    const oauth = credentials?.claudeAiOauth;
    if (!nonemptyString(oauth?.accessToken)) return 'signed-out';
    if (Array.isArray(oauth.scopes) && !oauth.scopes.includes('user:profile')) return 'unsupported';
    if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= nowMilliseconds) return 'expired';
    return 'ready';
}

/** The AccountInfo of a UsageResult, from Claude's account profile. */
export function normalizeAccount(profile) {
    const account = profile?.account;
    const organization = profile?.organization;
    if (
        typeof account?.uuid !== 'string' ||
        !account.uuid ||
        typeof organization?.uuid !== 'string' ||
        !organization.uuid
    )
        return {status: 'unavailable', identity: null, plan: null};
    return {
        status: 'ready',
        identity: nonemptyString(account.email),
        plan: Object.hasOwn(PLAN_NAMES, organization.organization_type)
            ? PLAN_NAMES[organization.organization_type]
            : null,
    };
}
