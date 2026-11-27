// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {clampPercent, isRecord, parseTime} from '../../misc/values.js';
import {createBucket} from '../usageResult.js';
import {createMoney, invalidResponse, remainingPercent} from './buckets.js';

const NAME = 'Ollama Cloud';

// Current plans: monthly usage credits in US dollars.
function allowanceBucket(included) {
    const {balance_usd: balance, allowance_usd: allowance, period} = included;
    const percent = remainingPercent(balance, allowance);
    if (percent === null || !isRecord(period)) return null;
    const from = parseTime(period.from);
    const until = parseTime(period.until);
    return createBucket({
        id: 'ollama',
        name: NAME,
        windows: [
            {
                id: 'monthly',
                durationMinutes:
                    from !== null && until !== null && until > from
                        ? Math.round((until - from) / 60)
                        : null,
                remainingPercent: percent,
                resetsAt: until,
            },
        ],
        money: createMoney({
            kind: 'allowance',
            used: Math.max(0, allowance - balance),
            limit: allowance,
            balance,
        }),
    });
}

// Legacy plans: a session and a weekly limit in percent.
function legacyWindow(id, durationMinutes, limit) {
    if (!isRecord(limit) || !Number.isFinite(limit.remaining_percent)) return null;
    return {
        id,
        durationMinutes,
        remainingPercent: clampPercent(limit.remaining_percent),
        resetsAt: parseTime(limit.resets_at),
    };
}

function legacyBucket(included) {
    const windows = [
        legacyWindow('five_hour', 300, included.session),
        legacyWindow('weekly', 10080, included.weekly),
    ].filter(window => window !== null);
    return windows.length ? createBucket({id: 'ollama', name: NAME, windows}) : null;
}

/** https://docs.ollama.com/api/balance.md */
export const OLLAMA = Object.freeze({
    usageUrl: () => 'https://ollama.com/api/balance',
    statusIssues: Object.freeze({403: 'account-suspended'}),

    /**
     * @param {object} response
     * @returns {{buckets: object[], plan: string|null}}
     */
    normalize(response) {
        if (!isRecord(response) || !isRecord(response.included)) throw invalidResponse(NAME);
        const included = allowanceBucket(response.included) ?? legacyBucket(response.included);
        if (included === null) throw invalidResponse(NAME);
        const buckets = [included];
        // Unexpired purchased credits: an unnamed credit with a balance only.
        const purchased = response.purchased?.balance_usd;
        if (Number.isFinite(purchased)) {
            buckets.push(
                createBucket({
                    id: 'ollama:purchased',
                    name: null,
                    money: createMoney({kind: 'balance', balance: purchased}),
                }),
            );
        }
        return {buckets, plan: null};
    },
});
