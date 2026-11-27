// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {isRecord, nonemptyString} from '../../misc/values.js';

// Display names for the values of PlanType in the Codex app-server protocol.
const PLAN_NAMES = Object.freeze({
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    team: 'Team',
    self_serve_business_prolite: 'Self-serve Business Pro Lite',
    self_serve_business_usage_based: 'Self-serve Business (usage based)',
    business: 'Business',
    enterprise_cbp_automation: 'Enterprise CBP (automation)',
    enterprise_cbp_usage_based: 'Enterprise CBP (usage based)',
    enterprise: 'Enterprise',
    edu: 'Edu',
    edu_plus: 'Edu Plus',
    edu_pro: 'Edu Pro',
});

export function formatPlan(planType) {
    const plan = nonemptyString(planType);
    if (plan === null || plan === 'unknown') return null;
    return Object.hasOwn(PLAN_NAMES, plan) ? PLAN_NAMES[plan] : plan;
}

/** Only a ChatGPT login has subscription limits; API key and Bedrock logins do not. */
export function normalizeAccount(response) {
    if (response?.account === null) {
        return {
            status: response.requiresOpenaiAuth === false ? 'unsupported' : 'signed-out',
            identity: null,
            plan: null,
        };
    }

    const account = response?.account;
    if (!isRecord(account)) return {status: 'unavailable', identity: null, plan: null};
    if (account.type !== 'chatgpt') return {status: 'unsupported', identity: null, plan: null};
    return {
        status: 'ready',
        identity: nonemptyString(account.email),
        plan: formatPlan(account.planType),
    };
}

/**
 * account/read names the login but not its workspace, so a login is its type
 * and email; a plan change is the same login. fingerprint detects a login
 * change during a usage read and stays in memory. userId is the opaque
 * ChatGPT user ID, the only part of the identity that may reach the disk,
 * and is null when the protocol does not report one.
 */
export function normalizeAccountSnapshot(response) {
    const account = response?.account;
    if (!isRecord(account) || account.type !== 'chatgpt') return {fingerprint: null, userId: null};

    const email = nonemptyString(account.email);
    const userId = nonemptyString(response.userId);
    return {fingerprint: JSON.stringify(['chatgpt', email, userId]), userId};
}
