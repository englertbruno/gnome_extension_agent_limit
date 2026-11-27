// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {isRecord} from '../../misc/values.js';
import {createBucket} from '../usageResult.js';
import {createMoney, invalidResponse, parseAmount} from './buckets.js';

const NAME = 'DeepSeek';

/** https://api-docs.deepseek.com/api/get-user-balance.md */
export const DEEPSEEK = Object.freeze({
    usageUrl: () => 'https://api.deepseek.com/user/balance',

    /**
     * One bucket per currency, with its balance and no usage windows.
     *
     * @param {object} response
     * @returns {{buckets: object[], plan: string|null}}
     */
    normalize(response) {
        if (!isRecord(response) || !Array.isArray(response.balance_infos))
            throw invalidResponse(NAME);
        const buckets = new Map();
        for (const info of response.balance_infos) {
            if (!isRecord(info)) continue;
            const {currency} = info;
            const balance = parseAmount(info.total_balance);
            if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || balance === null)
                continue;
            const id = `deepseek:${currency.toLowerCase()}`;
            if (buckets.has(id)) continue;
            buckets.set(
                id,
                createBucket({
                    id,
                    name: `${NAME} ${currency}`,
                    money: createMoney({kind: 'balance', currency, balance}),
                }),
            );
        }
        return {buckets: [...buckets.values()], plan: null};
    },
});
