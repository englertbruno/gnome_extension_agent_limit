// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {clampPercent, isRecord, nonemptyString, parseTime} from '../../misc/values.js';
import {createBucket} from '../usageResult.js';

// Bounds on a reply from the user's CLI, so a broken one cannot make the
// Shell build thousands of rows or megabyte-long identifiers.
const MAX_ROWS = 64;
const MAX_NAME_LENGTH = 256;

function isBoundedName(value) {
    return nonemptyString(value) !== null && value.length <= MAX_NAME_LENGTH;
}

// A missing or null optional name is allowed.
function isOptionalName(value) {
    return (
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.length <= MAX_NAME_LENGTH)
    );
}

function rowId(groupName, row) {
    const bucketId = nonemptyString(row.id) ?? row.name.trim();
    const windowName = nonemptyString(row.window);
    return `${encodeURIComponent(groupName.trim())}/${encodeURIComponent(bucketId)}${windowName ? `/${encodeURIComponent(windowName)}` : ''}`;
}

/**
 * `agy /usage` data: groups of model quotas, without window durations. Every
 * row needs a name; at most 64 rows with names of at most 256 characters are
 * accepted. Rows with the same group, ID and window are rejected, as the
 * later would replace the earlier.
 */
export function isQuotaResponse(response) {
    if (!isRecord(response) || !Array.isArray(response.groups)) return false;
    let rows = 0;
    const ids = new Set();
    for (const group of response.groups) {
        if (!isRecord(group) || !isBoundedName(group.name) || !Array.isArray(group.buckets))
            return false;
        rows += group.buckets.length;
        if (rows > MAX_ROWS) return false;
        for (const row of group.buckets) {
            if (
                !isRecord(row) ||
                !isBoundedName(row.name) ||
                !isOptionalName(row.id) ||
                !isOptionalName(row.window)
            )
                return false;
            const id = rowId(group.name, row);
            if (ids.has(id)) return false;
            ids.add(id);
        }
    }
    return true;
}

/** Expects a response accepted by isQuotaResponse(). */
export function normalizeQuota(response) {
    const buckets = new Map();
    for (const group of response.groups) {
        const groupName = group.name.trim();
        for (const row of group.buckets) {
            const name = row.name.trim();
            const windowName = nonemptyString(row.window);
            const id = rowId(group.name, row);
            const fraction = row.remaining_fraction;
            const remainingPercent =
                row.disabled === true
                    ? null
                    : Number.isFinite(fraction)
                      ? clampPercent(fraction * 100)
                      : null;
            const resetsAt = parseTime(row.reset_time);
            buckets.set(
                id,
                createBucket({
                    id,
                    name: `${groupName}: ${name}${windowName ? ` (${windowName})` : ''}`,
                    windows: [{id: 'quota', durationMinutes: null, remainingPercent, resetsAt}],
                    statuses: row.disabled === true ? [{code: 'unavailable-for-account'}] : [],
                }),
            );
        }
    }
    return [...buckets.values()].sort((first, second) => first.id.localeCompare(second.id));
}
