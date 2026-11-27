// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// A point is added when the remaining percentage moved at least this much.
const MIN_CHANGE_PERCENT = 0.5;
const RETENTION_SECONDS = 8 * 24 * 3600;
const MAX_POINTS = 1500;
const MAX_SERIES = 8;

/**
 * Remaining percentages of one account's windows over time. It is saved as
 * is, so it holds no identity beyond the account key digest.
 *
 * @typedef {object} UsageHistory
 * @property {string|null} accountKey The account the points belong to.
 * @property {Object<string, Array<[number, number]>>} series Keyed by
 * seriesKey(); points are [Unix seconds, remaining percent], oldest first.
 */

/** @returns {UsageHistory} */
export function createHistory(accountKey) {
    return {accountKey, series: {}};
}

/**
 * Window ids are not unique within a bucket, so windows that share an id are
 * told apart by their position among them. Durations would not do: equal
 * windows share one, and a monthly window's length changes with the month.
 */
export function seriesKey(bucket, window) {
    const sameId = bucket.windows.filter(other => other.id === window.id);
    const suffix = sameId.length > 1 ? `#${sameId.indexOf(window)}` : '';
    return `${bucket.id}/${window.id}${suffix}`;
}

/**
 * Adds a point for each window with a duration whose remaining percentage
 * moved since its last point, so resets appear as rises, then drops old
 * points. A reading of another account replaces the history.
 *
 * @param {UsageHistory} history Changed in place.
 * @param {UsageResult} result A successful reading.
 * @returns {boolean} Whether the reading changed the history.
 */
export function recordHistory(history, result, nowSeconds) {
    let changed = false;
    if (result.accountKey !== history.accountKey) {
        history.accountKey = result.accountKey;
        history.series = {};
        changed = true;
    }
    for (const bucket of result.buckets) {
        for (const window of bucket.windows) {
            const remaining = window.remainingPercent;
            const hasDuration =
                Number.isFinite(window.durationMinutes) && window.durationMinutes > 0;
            if (!hasDuration || !Number.isFinite(remaining)) continue;
            const points = (history.series[seriesKey(bucket, window)] ??= []);
            const last = points.at(-1);
            if (last && Math.abs(remaining - last[1]) < MIN_CHANGE_PERCENT) continue;
            points.push([nowSeconds, Math.round(remaining * 10) / 10]);
            changed = true;
        }
    }
    pruneHistory(history, nowSeconds);
    return changed;
}

function pruneHistory(history, nowSeconds) {
    const oldest = nowSeconds - RETENTION_SECONDS;
    const kept = Object.entries(history.series)
        .map(([key, points]) => [key, points.filter(([time]) => time >= oldest).slice(-MAX_POINTS)])
        .filter(([, points]) => points.length > 0)
        // The most recently updated series are kept.
        .sort(([, a], [, b]) => b.at(-1)[0] - a.at(-1)[0])
        .slice(0, MAX_SERIES);
    history.series = Object.fromEntries(kept);
}

/**
 * Sums the drops of remaining percentage per slot, each in the slot of the
 * point that shows it; rises are resets. The last slot contains nowSeconds.
 * Slots start at multiples of slotSeconds in the zone of utcOffsetSeconds, one
 * offset for the whole range: for a week after a daylight-saving change, the
 * slots before it are off by that change.
 *
 * @param {Array<[number, number]>} points  One series of a UsageHistory.
 * @returns {{start: number, sums: number[], remaining: Array<number|null>}} start is the first slot's Unix
 *     time; sums and remaining are oldest first, remaining the percentage of each slot's last point, or null
 *     for a slot without one.
 */
export function historySlots(points, nowSeconds, {slotSeconds, slots, utcOffsetSeconds}) {
    const end =
        (Math.floor((nowSeconds + utcOffsetSeconds) / slotSeconds) + 1) * slotSeconds -
        utcOffsetSeconds;
    const start = end - slots * slotSeconds;
    const sums = new Array(slots).fill(0);
    const remaining = Array.from({length: slots}, () => null);
    for (const [index, [time, percent]] of points.entries()) {
        if (time < start || time >= end) continue;
        const slot = Math.floor((time - start) / slotSeconds);
        // Points are oldest first, so the slot's last point wins.
        remaining[slot] = percent;
        const drop = index > 0 ? points[index - 1][1] - percent : 0;
        if (drop > 0) sums[slot] += drop;
    }
    return {start, sums, remaining};
}
