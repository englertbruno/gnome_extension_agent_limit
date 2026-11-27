// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Kimi Code documents no usage API. This reads the undocumented
// /coding/v1/usages endpoint in the response shape that open-source usage
// monitors read from it; no reply has been checked against it.

import {clampPercent, isRecord, parseTime} from '../../misc/values.js';
import {createBucket} from '../usageResult.js';
import {invalidResponse, monthMinutesBefore, parseAmount, remainingPercent} from './buckets.js';

const NAME = 'Kimi Code';

// Each region has its own host and its own keys.
const USAGE_URLS = Object.freeze({
    china: 'https://api.kimi.com/coding/v1/usages',
    international: 'https://api.kimi.ai/coding/v1/usages',
});

// Monitors read the reset time in camel and snake case.
function resetTime(block) {
    return parseTime(block.resetTime ?? block.reset_time ?? block.resetAt ?? block.reset_at);
}

// A block of request counts: {limit, used and/or remaining, resetTime}, numbers or strings.
function countWindow(id, durationMinutes, block) {
    if (!isRecord(block)) return null;
    const limit = parseAmount(block.limit);
    const used = parseAmount(block.used);
    const remaining =
        parseAmount(block.remaining) ?? (limit !== null && used !== null ? limit - used : null);
    const percent = remainingPercent(remaining, limit);
    if (percent === null) return null;
    return {id, durationMinutes, remainingPercent: percent, resetsAt: resetTime(block)};
}

function isFiveHours(window) {
    if (!isRecord(window)) return false;
    const unit = window.timeUnit ?? window.time_unit;
    return (
        (window.duration === 300 && unit === 'TIME_UNIT_MINUTE') ||
        (window.duration === 5 && unit === 'TIME_UNIT_HOUR')
    );
}

// The rolling five-hour limit is the entry of `limits` with that window.
function fiveHourWindow(limits) {
    if (!Array.isArray(limits)) return null;
    const limit = limits.find(entry => isRecord(entry) && isFiveHours(entry.window));
    return limit ? countWindow('five_hour', 300, limit.detail) : null;
}

// The monthly pool, as the share used.
function monthlyWindow(usages) {
    const month = isRecord(usages) ? usages.limit_month_total : null;
    if (!isRecord(month) || !Number.isFinite(month.used_ratio)) return null;
    const resetsAt = resetTime(month);
    return {
        id: 'monthly',
        durationMinutes: resetsAt === null ? null : monthMinutesBefore(resetsAt),
        remainingPercent: clampPercent((1 - month.used_ratio) * 100),
        resetsAt,
    };
}

// 'LEVEL_INTERMEDIATE' → 'Intermediate'.
function planName(level) {
    if (typeof level !== 'string') return null;
    const words = level
        .trim()
        .replace(/^LEVEL_/, '')
        .split('_')
        .filter(word => word);
    return words.length
        ? words.map(word => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(' ')
        : null;
}

export const KIMI = Object.freeze({
    /** @param {{kimiRegion: string}} account */
    usageUrl: account => USAGE_URLS[account.kimiRegion],

    /**
     * @param {object} response
     * @returns {{buckets: object[], plan: string|null}}
     */
    normalize(response) {
        if (!isRecord(response)) throw invalidResponse(NAME);
        const windows = [
            fiveHourWindow(response.limits),
            // Monitors read the weekly limit from `usage`.
            countWindow('weekly', 10080, response.usage),
            monthlyWindow(response.usages),
        ].filter(window => window !== null);
        if (windows.length === 0) throw invalidResponse(NAME);
        return {
            buckets: [createBucket({id: 'kimi', name: NAME, windows})],
            plan: planName(response.user?.membership?.level),
        };
    },
});
