// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {isRecord, parseTime} from '../../misc/values.js';
import {createBucket} from '../usageResult.js';
import {
    createMoney,
    invalidResponse,
    monthMinutesBefore,
    parseAmount,
    remainingPercent,
} from './buckets.js';

const NAME = 'OpenRouter';
const DAY_SECONDS = 86400;

// The UTC window a budget counts spend over; a lifetime budget has none.
function budgetWindow(budget) {
    const percent = remainingPercent(budget.remaining_usd, budget.limit_usd);
    const resetsAt = parseTime(budget.resets_at);
    switch (budget.reset_interval) {
        case 'daily':
            return {id: 'daily', durationMinutes: 1440, remainingPercent: percent, resetsAt};
        case 'weekly':
            return {id: 'weekly', durationMinutes: 10080, remainingPercent: percent, resetsAt};
        case 'monthly':
            return {
                id: 'monthly',
                durationMinutes: resetsAt === null ? null : monthMinutesBefore(resetsAt),
                remainingPercent: percent,
                resetsAt,
            };
        default:
            return {id: 'quota', durationMinutes: null, remainingPercent: percent, resetsAt};
    }
}

/**
 * The key's spending: `effective_budget` is the budget layer that blocks
 * requests first (the key's own limit, a guardrail or a workspace budget), or
 * null when nothing is budgeted.
 */
function keyBucket(data) {
    const budget = isRecord(data.effective_budget) ? data.effective_budget : null;
    if (budget !== null && remainingPercent(budget.remaining_usd, budget.limit_usd) !== null) {
        return createBucket({
            id: 'openrouter',
            name: NAME,
            windows: [budgetWindow(budget)],
            money: createMoney({
                kind: 'key-limit',
                used: parseAmount(budget.spend_usd),
                limit: budget.limit_usd,
                balance: parseAmount(budget.remaining_usd),
            }),
        });
    }
    const spent = parseAmount(data.usage_monthly);
    return createBucket({
        id: 'openrouter',
        name: NAME,
        // Without a limit, only this month's spending is known.
        money: spent === null ? null : createMoney({kind: 'key-limit', used: spent}),
    });
}

// Requests of `:free` model variants, counted per UTC day for the key's account.
function freeModelBucket(requests, nowSeconds) {
    if (!isRecord(requests)) return null;
    const percent = remainingPercent(requests.remaining, requests.limit);
    if (percent === null) return null;
    return createBucket({
        id: 'openrouter:free-models',
        name: `${NAME} free models`,
        windows: [
            {
                id: 'daily',
                durationMinutes: 1440,
                remainingPercent: percent,
                // The counter resets at UTC midnight.
                resetsAt: (Math.floor(nowSeconds / DAY_SECONDS) + 1) * DAY_SECONDS,
            },
        ],
    });
}

/** https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md */
export const OPENROUTER = Object.freeze({
    usageUrl: () => 'https://openrouter.ai/api/v1/key',

    /**
     * @param {object} response
     * @param {number} nowSeconds
     * @returns {{buckets: object[], plan: string|null}}
     */
    normalize(response, nowSeconds) {
        if (!isRecord(response) || !isRecord(response.data)) throw invalidResponse(NAME);
        const key = keyBucket(response.data);
        const free = freeModelBucket(response.data.free_model_daily_requests, nowSeconds);
        if (key.money === null && free === null) throw invalidResponse(NAME);
        // A bucket with a meter goes first, so it is selected by default.
        const buckets = key.windows.length === 0 && free !== null ? [free, key] : [key, free];
        return {buckets: buckets.filter(bucket => bucket !== null), plan: null};
    },
});
