// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Helpers that turn the responses of API-key services into usage buckets.

import {codedError} from '../../misc/errors.js';
import {clampPercent} from '../../misc/values.js';

export function invalidResponse(serviceName) {
    return codedError('invalid-response', `${serviceName} returned an invalid usage response`);
}

/** Money in US dollars or another ISO 4217 currency, in major units. */
export function createMoney({kind, currency = 'USD', used = null, limit = null, balance = null}) {
    return {kind, currency, used, limit, balance, enabled: null};
}

/** A finite number, also from a decimal string such as "110.00"; otherwise null. */
export function parseAmount(value) {
    if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
    return Number.isFinite(value) ? value : null;
}

/** The remaining share of `limit` in percent, or null without a positive limit. */
export function remainingPercent(remaining, limit) {
    return Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0
        ? clampPercent((remaining / limit) * 100)
        : null;
}

/**
 * Minutes of a monthly window that ends at `resetsAt` (Unix seconds) and began
 * on the same day of the previous month, or on its last day when that month is
 * shorter.
 */
export function monthMinutesBefore(resetsAt) {
    const end = new Date(resetsAt * 1000);
    const year = end.getUTCFullYear();
    const month = end.getUTCMonth() - 1;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const start = Date.UTC(
        year,
        month,
        Math.min(end.getUTCDate(), lastDay),
        end.getUTCHours(),
        end.getUTCMinutes(),
        end.getUTCSeconds(),
    );
    return Math.round((end.getTime() - start) / 60000);
}
