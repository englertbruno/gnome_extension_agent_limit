// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {clampPercent, isRecord, nonemptyString} from '../../misc/values.js';
import {isDateSeconds} from '../../shared/formatting.js';
import {createBucket} from '../usageResult.js';
import {formatPlan} from './account.js';

// Bucket status codes for the values of RateLimitReachedType.
const REACHED_STATUSES = Object.freeze({
    rate_limit_reached: 'rate-limit-reached',
    workspace_owner_credits_depleted: 'workspace-credits-depleted',
    workspace_member_credits_depleted: 'member-credits-depleted',
    workspace_owner_usage_limit_reached: 'workspace-usage-limit',
    workspace_member_usage_limit_reached: 'member-usage-limit',
});

// Spark has no fixed limit ID; the API marks it only in the ID or name.
function isSparkLimit(...labels) {
    return labels.some(label => typeof label === 'string' && label.toLowerCase().includes('spark'));
}

function isSparkSnapshot(id, snapshot) {
    return isSparkLimit(id, snapshot.limitName);
}

function bucketName(id, snapshot) {
    if (id === 'codex') return 'Codex';

    if (isSparkSnapshot(id, snapshot)) return 'Codex Spark';
    return nonemptyString(snapshot.limitName) ?? id;
}

// Codex first, then Spark, then the rest by ID.
function compareSnapshots([firstId, first], [secondId, second]) {
    const priority = (id, snapshot) => (id === 'codex' ? 0 : isSparkSnapshot(id, snapshot) ? 1 : 2);
    return priority(firstId, first) - priority(secondId, second) || firstId.localeCompare(secondId);
}

function normalizeWindow(id, window) {
    const usedPercent = window.usedPercent;
    const duration = window.windowDurationMins;
    const resetsAt = window.resetsAt;

    return {
        id,
        durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : null,
        // Unknown usage stays null rather than 100% remaining.
        remainingPercent: Number.isFinite(usedPercent) ? clampPercent(100 - usedPercent) : null,
        resetsAt:
            Number.isInteger(resetsAt) && resetsAt > 0 && isDateSeconds(resetsAt) ? resetsAt : null,
    };
}

function bucketStatuses(snapshot) {
    const reachedType = nonemptyString(snapshot.rateLimitReachedType);
    const statuses = [];

    if (reachedType) {
        statuses.push(
            Object.hasOwn(REACHED_STATUSES, reachedType)
                ? {code: REACHED_STATUSES[reachedType]}
                : {code: 'limit-status', params: {type: reachedType}},
        );
    }

    if (snapshot.spendControlReached === true) statuses.push({code: 'spending-limit-reached'});

    return statuses;
}

// The balance is a decimal string; it is kept only while credits are available.
function bucketCredits(credits) {
    if (!isRecord(credits)) return null;
    if (credits.unlimited === true) return {unlimited: true, available: true, balance: null};
    if (typeof credits.hasCredits !== 'boolean') return null;

    const balance = nonemptyString(credits.balance);
    const amount = balance === null ? NaN : Number(balance);
    return {
        unlimited: false,
        available: credits.hasCredits,
        balance: credits.hasCredits && Number.isFinite(amount) ? amount : null,
    };
}

function normalizeBucket(id, snapshot) {
    const windows = ['primary', 'secondary']
        .filter(windowId => isRecord(snapshot[windowId]))
        .map(windowId => normalizeWindow(windowId, snapshot[windowId]));

    return createBucket({
        id,
        name: bucketName(id, snapshot),
        plan: formatPlan(snapshot.planType),
        windows,
        statuses: bucketStatuses(snapshot),
        credits: bucketCredits(snapshot.credits),
    });
}

// `keyed` holds the [id, snapshot] entries of rateLimitsByLimitId.
function singleBucketId(snapshot, keyed) {
    const id = nonemptyString(snapshot.limitId);
    if (id) return id;

    const name = nonemptyString(snapshot.limitName)?.toLowerCase();
    if (isSparkLimit(name))
        return (
            keyed.find(([keyedId, keyedSnapshot]) =>
                isSparkSnapshot(keyedId, keyedSnapshot),
            )?.[0] ?? 'codex-spark'
        );

    // An unlabeled snapshot may duplicate any keyed bucket, so only assume Codex if none.
    return keyed.length === 0 || name === 'codex' ? 'codex' : null;
}

/** Returns the buckets of an account/rateLimits/read response. */
export function normalizeRateLimits(response) {
    const snapshots = isRecord(response?.rateLimitsByLimitId)
        ? Object.entries(response.rateLimitsByLimitId).filter(
              ([id, snapshot]) => id.trim() && isRecord(snapshot),
          )
        : [];

    // rateLimits is always present; rateLimitsByLimitId may be missing or null.
    const singleBucket = response?.rateLimits;
    if (isRecord(singleBucket)) {
        const id = singleBucketId(singleBucket, snapshots);
        if (id && !snapshots.some(([keyedId]) => keyedId === id))
            snapshots.push([id, singleBucket]);
    }

    // Map order varies between responses; sort for stable menu positions.
    snapshots.sort(compareSnapshots);

    return snapshots.map(([id, snapshot]) => normalizeBucket(id, snapshot));
}

/**
 * Returns the ChatGPT workspace of an account/rateLimits/read response, or
 * null when the backend leaves it out. The app-server protocol calls a
 * workspace's ID accountId and a user's ID userId.
 */
export function normalizeWorkspaceId(response) {
    return nonemptyString(response?.accountId);
}

// Credit IDs are opaque and are passed back unchanged to redeem a credit.
function normalizeResetCredit(credit) {
    if (!isRecord(credit) || typeof credit.id !== 'string' || !credit.id) return null;
    if (typeof credit.status !== 'string' || !credit.status) return null;

    const expiresAt = credit.expiresAt;
    return {
        id: credit.id,
        title: nonemptyString(credit.title),
        expiresAt:
            Number.isInteger(expiresAt) && expiresAt > 0 && isDateSeconds(expiresAt)
                ? expiresAt
                : null,
        status: credit.status,
    };
}

/**
 * Returns the manual resets of an account/rateLimits/read response, or null
 * when it has no valid count. availableCount is authoritative: the credit list
 * may be capped, and is null when only the count is known.
 */
export function normalizeResets(response) {
    const summary = response?.rateLimitResetCredits;
    if (!isRecord(summary)) return null;

    const available = summary.availableCount;
    if (!Number.isSafeInteger(available) || available < 0) return null;

    return {
        available,
        credits: Array.isArray(summary.credits)
            ? summary.credits.map(normalizeResetCredit).filter(credit => credit !== null)
            : null,
    };
}
