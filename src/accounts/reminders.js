// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Shorter windows reset too often for a reminder to be useful.
const MIN_REMINDER_WINDOW_SECONDS = 86400;
// A reminded cycle is remembered this long after its reset, longer than any
// shift of a reported reset time within one cycle.
const REMINDED_KEPT_SECONDS = MIN_REMINDER_WINDOW_SECONDS / 2;
// How long before its expiry a manual reset is announced.
const EXPIRY_NOTICE_SECONDS = 48 * 3600;

/**
 * Reminds once per window cycle that a window of a day or more will reset with
 * much of it unused. Judge each successful reading once, when it is read.
 *
 * Its saved state keeps a lock or restart from repeating a reminder. Without
 * saved state, a window that is already due is reminded at once.
 */
export class UnusedReminder {
    /**
     * @param {Array<[string, number]>|null} saved  State from an earlier
     * session, already checked by parseSavedReading().
     */
    constructor(saved) {
        // Window key → reset time (Unix seconds) of its last reminded cycle.
        this._reminded = new Map(saved ?? []);
    }

    /** @returns {Array<[string, number]>} JSON-safe state to save. */
    get state() {
        return [...this._reminded];
    }

    /**
     * Projects the percentage left at the reset from the average rate of use
     * since the window started: within `hours` of the reset, and once the
     * window has run as long as is left of it, so that the projection never
     * reaches further than the usage behind it. A reminder due while disabled
     * still uses up its cycle.
     *
     * @param {{key: string, durationMinutes: number|null, remainingPercent: number|null, resetsAt: number|null}} window
     * @param {{enabled: boolean, threshold: number, hours: number, nowSeconds: number}} options
     * @returns {number|null} The projection, when a reminder of at least threshold percent is due.
     */
    update(
        {key, durationMinutes, remainingPercent, resetsAt},
        {enabled, threshold, hours, nowSeconds},
    ) {
        for (const [remindedKey, remindedResetsAt] of this._reminded) {
            if (remindedResetsAt + REMINDED_KEPT_SECONDS <= nowSeconds)
                this._reminded.delete(remindedKey);
        }
        if (durationMinutes === null || remainingPercent === null || resetsAt === null) return null;
        const durationSeconds = durationMinutes * 60;
        const leftSeconds = resetsAt - nowSeconds;
        const elapsedSeconds = durationSeconds - leftSeconds;
        if (
            durationSeconds < MIN_REMINDER_WINDOW_SECONDS ||
            leftSeconds <= 0 ||
            leftSeconds > hours * 3600 ||
            elapsedSeconds < leftSeconds
        )
            return null;
        const projectedPercent =
            remainingPercent - ((100 - remainingPercent) / elapsedSeconds) * leftSeconds;
        if (projectedPercent < threshold) return null;
        // Reported reset times shift slightly between readings; the next
        // cycle's is a whole window later.
        const remindedResetsAt = this._reminded.get(key);
        if (
            remindedResetsAt !== undefined &&
            Math.abs(resetsAt - remindedResetsAt) < durationSeconds / 2
        )
            return null;
        this._reminded.set(key, resetsAt);
        return enabled ? projectedPercent : null;
    }
}

/**
 * Announces each available manual reset once, when it expires within 48
 * hours. Judge each successful reading once.
 *
 * Its saved state keeps a lock or restart from repeating an announcement.
 * Without saved state, resets that already expire soon are announced at once.
 */
export class ResetExpiryTracker {
    /**
     * @param {Array<[string, number]>|null} saved  State from an earlier
     * session, already checked by parseSavedReading().
     */
    constructor(saved) {
        // Credit ID → expiry (Unix seconds) of each announced reset, until
        // that expiry passes. A reset whose expiry was postponed is then
        // announced again before its new expiry.
        this._announced = new Map(saved ?? []);
    }

    /** @returns {Array<[string, number]>} JSON-safe state to save. */
    get state() {
        return [...this._announced];
    }

    /**
     * An announcement due while disabled is used up.
     *
     * @param {{credits: Array<{id: string, expiresAt: number|null, status: string}>|null}|null} resets
     * The reading's manual resets; null, or null credits, when not reported.
     * @param {{enabled: boolean, nowSeconds: number}} options
     * @returns {Array<object>} The credits from resets to announce, soonest
     * expiry first.
     */
    update(resets, {enabled, nowSeconds}) {
        for (const [id, expiresAt] of this._announced) {
            if (!expiresSoon(expiresAt, nowSeconds)) this._announced.delete(id);
        }
        const expiring = (resets?.credits ?? [])
            .filter(
                credit =>
                    credit.status === 'available' &&
                    credit.expiresAt !== null &&
                    expiresSoon(credit.expiresAt, nowSeconds) &&
                    !this._announced.has(credit.id),
            )
            .sort((first, second) => first.expiresAt - second.expiresAt);
        for (const credit of expiring) this._announced.set(credit.id, credit.expiresAt);
        return enabled ? expiring : [];
    }
}

function expiresSoon(expiresAt, nowSeconds) {
    return expiresAt > nowSeconds && expiresAt - nowSeconds <= EXPIRY_NOTICE_SECONDS;
}
