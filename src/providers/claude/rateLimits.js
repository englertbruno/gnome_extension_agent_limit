// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {clampPercent, isRecord, nonemptyString, parseTime} from '../../misc/values.js';
import {createBucket} from '../usageResult.js';

const FIVE_HOURS = 300;
const ONE_WEEK = 10080;

// Extra-usage payloads from before the currency field were in US dollars.
const DEFAULT_CURRENCY = 'USD';
// More minor-unit digits than any currency has means a damaged scale.
const MAX_DECIMAL_PLACES = 6;

// Scoped fixed-window fields of the /api/oauth/usage response: [response key, scope, name].
const FIXED_SCOPED_FIELDS = [
    ['seven_day_opus', 'model', 'Opus'],
    ['seven_day_sonnet', 'model', 'Sonnet'],
    ['seven_day_oauth_apps', 'surface', 'OAuth apps'],
];

// Field names of one-time credit grants in the same response, with default
// display names; null leaves an unlabelled grant unnamed.
const FIXED_CREDIT_NAMES = {
    cinder_cove: 'Code and Cowork credit',
    wattle_ember: null,
};

const FIXED_USAGE_FIELDS = [
    'five_hour',
    'seven_day',
    ...FIXED_SCOPED_FIELDS.map(([key]) => key),
    ...Object.keys(FIXED_CREDIT_NAMES),
    'extra_usage',
];

function normalizeWindow(id, durationMinutes, usedPercent, resetsAt) {
    return {
        id,
        durationMinutes,
        remainingPercent: Number.isFinite(usedPercent) ? clampPercent(100 - usedPercent) : null,
        resetsAt: parseTime(resetsAt),
    };
}

/**
 * 'session' and 'weekly_all' rows are account-wide; other kinds are scoped to a
 * model or surface, and only 'weekly_scoped' has a known duration.
 */
function readLimitRows(rows) {
    const overall = [];
    const scoped = [];
    // Rows of one model share a bucket only when the server names its ID; rows
    // known by name alone stay apart, numbered in reply order.
    const namedRows = new Map();
    for (const row of rows) {
        if (!isRecord(row) || typeof row.kind !== 'string' || !row.kind) continue;
        if (row.kind === 'session') {
            overall.push(normalizeWindow('five_hour', FIVE_HOURS, row.percent, row.resets_at));
        } else if (row.kind === 'weekly_all') {
            overall.push(normalizeWindow('seven_day', ONE_WEEK, row.percent, row.resets_at));
        } else {
            let scopeKind = 'limit';
            if (row.scope?.model) scopeKind = 'model';
            else if (row.scope?.surface) scopeKind = 'surface';
            const label = row.scope?.[scopeKind]?.display_name;
            const name = nonemptyString(label) ?? row.kind.replaceAll('_', ' ');
            const window =
                row.kind === 'weekly_scoped'
                    ? normalizeWindow(row.kind, ONE_WEEK, row.percent, row.resets_at)
                    : normalizeWindow('quota', null, row.percent, row.resets_at);
            const modelId = nonemptyString(row.scope?.[scopeKind]?.id);
            let scope;
            if (modelId !== null) {
                scope = `${scopeKind}:id:${modelId}`;
            } else {
                const key = `${scopeKind}:${name.toLowerCase()}`;
                const count = (namedRows.get(key) ?? 0) + 1;
                namedRows.set(key, count);
                scope = count === 1 ? key : `${key}:${count}`;
            }
            scoped.push({scope, name, window});
        }
    }
    return {overall, scoped};
}

/** Reads fixed-window fields when the optional limits[] array is absent. */
function readFixedFields(response) {
    const overall = [];
    const scoped = [];
    if (isRecord(response.five_hour))
        overall.push(
            normalizeWindow(
                'five_hour',
                FIVE_HOURS,
                response.five_hour.utilization,
                response.five_hour.resets_at,
            ),
        );
    if (isRecord(response.seven_day))
        overall.push(
            normalizeWindow(
                'seven_day',
                ONE_WEEK,
                response.seven_day.utilization,
                response.seven_day.resets_at,
            ),
        );
    for (const [key, scopeKind, name] of FIXED_SCOPED_FIELDS) {
        const value = response[key];
        if (isRecord(value)) {
            const window = normalizeWindow(key, ONE_WEEK, value.utilization, value.resets_at);
            scoped.push({scope: `${scopeKind}:${name.toLowerCase()}`, name, window});
        }
    }
    return {overall, scoped};
}

/** Reads credit grants, whose IDs come from their field names, not labels. */
function readCreditGrants(response) {
    const grants = [];
    for (const [key, defaultName] of Object.entries(FIXED_CREDIT_NAMES)) {
        const value = response[key];
        if (!isRecord(value)) continue;
        const label = key === 'wattle_ember' ? nonemptyString(value.label) : null;
        // For a credit, resets_at is its expiry date.
        grants.push({
            scope: `limit:${key}`,
            name: label ?? defaultName,
            window: {
                ...normalizeWindow('credit', null, value.utilization, null),
                expiresAt: parseTime(value.resets_at),
            },
        });
    }
    return grants;
}

/** Converts an amount in minor units, or returns null for a missing or invalid one. */
function majorUnits(minorUnits, decimalPlaces) {
    return Number.isFinite(minorUnits) && minorUnits >= 0 ? minorUnits / 10 ** decimalPlaces : null;
}

/**
 * Reads extra usage, whose amounts are minor units of its currency, such as
 * cents. Returns null without a currency and scale that convert and format
 * the amounts; Intl throws on a malformed currency code.
 *
 * @returns {Money|null} See providers/usageResult.js.
 */
function readExtraUsage(extraUsage) {
    if (!isRecord(extraUsage)) return null;
    const currencyCode = extraUsage.currency ?? DEFAULT_CURRENCY;
    if (typeof currencyCode !== 'string' || !/^[A-Za-z]{3}$/.test(currencyCode)) return null;
    const currency = currencyCode.toUpperCase();
    // Some responses state the minor-unit digits; otherwise the currency's own apply.
    const decimalPlaces =
        extraUsage.decimal_places ??
        new Intl.NumberFormat('en', {style: 'currency', currency}).resolvedOptions()
            .maximumFractionDigits;
    if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > MAX_DECIMAL_PLACES)
        return null;
    const enabled = typeof extraUsage.is_enabled === 'boolean' ? extraUsage.is_enabled : null;
    const used = majorUnits(extraUsage.used_credits, decimalPlaces);
    // Money.limit: an explicit null means the account has no spending cap of
    // its own (which does not make its extra usage unlimited); a missing or
    // invalid cap is unknown, undefined.
    const limit =
        extraUsage.monthly_limit === null
            ? null
            : (majorUnits(extraUsage.monthly_limit, decimalPlaces) ?? undefined);
    if (enabled === null && used === null && (limit === null || limit === undefined)) return null;
    return {kind: 'extra-usage', currency, used, limit, balance: null, enabled};
}

/**
 * The meter of a seat that has no usage windows but an extra-usage cap, or
 * null when it has no cap or its use of the cap is unknown.
 */
function spendWindow(extraUsage, money) {
    // Without a cap, or with a zero cap, no percentage can be taken.
    // An explicitly disabled extra usage has no meter either.
    if (money === null || money.enabled === false || !money.limit) return null;
    const usedPercent =
        money.used !== null ? (money.used / money.limit) * 100 : extraUsage.utilization;
    if (!Number.isFinite(usedPercent)) return null;
    // The monthly cap's reset date is not reported.
    return normalizeWindow('spend', null, usedPercent, null);
}

/** Expects a response accepted by isUsageResponse(). */
export function normalizeRateLimits(response) {
    // A limits[] array without a usable row falls back to the fixed fields.
    let rows = Array.isArray(response.limits) ? readLimitRows(response.limits) : null;
    if (rows?.overall.length === 0 && rows.scoped.length === 0) rows = null;
    const {overall, scoped} = rows ?? readFixedFields(response);

    const buckets = [];
    if (overall.length || isRecord(response.extra_usage)) {
        overall.sort((first, second) => first.durationMinutes - second.durationMinutes);
        const bucket = createBucket({id: 'claude', name: 'Claude', windows: overall});
        bucket.money = readExtraUsage(response.extra_usage);
        if (overall.length === 0) {
            const spend = spendWindow(response.extra_usage, bucket.money);
            if (spend !== null) overall.push(spend);
        }
        buckets.push(bucket);
    }

    // The first bucket is the default selection, so one with no meter goes
    // last, and credits follow the usage meters.
    const rest = [...bucketsByScope(scoped), ...bucketsByScope(readCreditGrants(response))];
    return buckets[0]?.windows.length === 0 ? [...rest, ...buckets] : [...buckets, ...rest];
}

function bucketsByScope(entries) {
    const buckets = new Map();
    for (const {scope, name, window} of entries) {
        const id = `claude:${scope}`;
        if (!buckets.has(id))
            buckets.set(id, createBucket({id, name: name === null ? null : `Claude ${name}`}));
        buckets.get(id).windows.push(window);
    }
    return [...buckets.values()].sort((first, second) => first.id.localeCompare(second.id));
}

/** False for in-band error bodies such as {error: {...}}. */
export function isUsageResponse(response) {
    return (
        isRecord(response) &&
        (Array.isArray(response.limits) ||
            FIXED_USAGE_FIELDS.some(
                key =>
                    Object.hasOwn(response, key) &&
                    (response[key] === null || isRecord(response[key])),
            ))
    );
}
