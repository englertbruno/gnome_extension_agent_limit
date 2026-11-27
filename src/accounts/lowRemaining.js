// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {MAX_NOTIFIED_ENTRIES} from './savedStateFormat.js';

/**
 * Decides when the window shown in the panel has run low: once per window
 * cycle, for a new reading at or below the threshold. A window without a reset
 * time has no cycle, so there a reading above the threshold arms it again. The
 * first reading of a window only sets its baseline. Up to MAX_NOTIFIED_ENTRIES
 * windows are kept, so that a poll that shows another window drops none; the
 * saved state keeps a lock or restart from repeating or losing a notification.
 */
export class LowRemainingTracker {
    /**
     * @param {Array<{key: string, resetsAt: number|null, armed: boolean}>|null} saved
     * State from an earlier session, already checked by parseSavedReading().
     */
    constructor(saved) {
        // Window key → {resetsAt, armed}, the least recently judged first. A
        // key identifies the account and window of a reading; resetsAt is the
        // Unix seconds of the last reported reset, or null; armed tells
        // whether the next low reading notifies.
        this._windows = new Map(
            (saved ?? []).map(({key, resetsAt, armed}) => [key, {resetsAt, armed}]),
        );
        // Monotonic time of the last judged reading; not saved, as the
        // monotonic clock starts again with the session.
        this._readAt = null;
    }

    /** @returns {Array<{key: string, resetsAt: number|null, armed: boolean}>} JSON-safe state to save. */
    get state() {
        return [...this._windows].map(([key, {resetsAt, armed}]) => ({key, resetsAt, armed}));
    }

    /**
     * Judges each reading once, so a reading retained during grace never
     * notifies. A low reading while disabled still uses up its cycle.
     *
     * @param {{key: string, readAt: number|null, remainingPercent: number|null, resetsAt: number|null}} reading
     * readAt is null without a successful reading.
     * @param {{enabled: boolean, threshold: number, nowSeconds: number}} options
     * @returns {boolean} Whether to notify.
     */
    update({key, readAt, remainingPercent, resetsAt}, {enabled, threshold, nowSeconds}) {
        if (readAt === null || readAt === this._readAt || remainingPercent === null) return false;
        this._readAt = readAt;
        const low = remainingPercent <= threshold;
        const known = this._windows.get(key);
        // Moves the window to the end, where the newest are kept.
        this._windows.delete(key);
        if (!known) {
            this._windows.set(key, {resetsAt, armed: !low});
            if (this._windows.size > MAX_NOTIFIED_ENTRIES)
                this._windows.delete(this._windows.keys().next().value);
            return false;
        }
        // Reported reset times can shift slightly between readings, so a cycle
        // ends only once its reset time has passed and a later one is reported.
        const reset =
            known.resetsAt !== null &&
            known.resetsAt <= nowSeconds &&
            resetsAt !== null &&
            resetsAt > nowSeconds;
        // A reading without a reset time keeps the last one, so that it does
        // not hide the cycle change.
        known.resetsAt = resetsAt ?? known.resetsAt;
        // Without any reset time there is no cycle to wait for.
        if (reset || (known.resetsAt === null && !low)) known.armed = true;
        this._windows.set(key, known);
        if (!low || !known.armed) return false;
        known.armed = false;
        return enabled;
    }
}
