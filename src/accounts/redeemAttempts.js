// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Auto-redeem uses a manual reset that expires within this time.
const AUTO_REDEEM_SECONDS = 3600;

/**
 * The credits auto-redeem may use now, soonest expiry first: some usage is
 * counted, and the credit is available and expires within the hour. Whether
 * one was tried is not considered.
 *
 * @param {{resets: object|null, buckets: Array<object>}} reading A successful UsageResult.
 * @param {{enabled: boolean, nowSeconds: number}} options
 * @returns {Array<object>} Credits of reading.resets.
 */
export function autoRedeemCredits({resets, buckets}, {enabled, nowSeconds}) {
    if (
        !enabled ||
        !buckets.some(bucket =>
            bucket.windows.some(
                ({remainingPercent}) => Number.isFinite(remainingPercent) && remainingPercent < 100,
            ),
        )
    )
        return [];
    return (resets?.credits ?? [])
        .filter(
            ({status, expiresAt}) =>
                status === 'available' &&
                expiresAt !== null &&
                expiresAt > nowSeconds &&
                expiresAt - nowSeconds <= AUTO_REDEEM_SECONDS,
        )
        .sort((first, second) => first.expiresAt - second.expiresAt);
}

/**
 * Remembers the attempts to use manual resets: the idempotency key of an
 * attempt without an outcome, which the next attempt reuses, and the credits
 * auto-redeem has tried, which it tries once. A credit is named by the digest
 * of its ID.
 *
 * Its saved state keeps a lock or restart from using a second reset for an
 * attempt whose outcome is unknown, and from trying a credit again.
 */
export class RedeemAttempts {
    /**
     * @param {Array<[string, string|null]>|null} saved  State from an earlier
     * session, already checked by parseSavedReading().
     */
    constructor(saved) {
        // Credit digest → {key, auto}, oldest first. key is the idempotency key
        // of an attempt without an outcome, else null; auto is set once
        // auto-redeem tried the credit. The saved state keeps only the key: an
        // entry without one was tried automatically, and one with a key, such
        // as an attempt a lock interrupted, may be tried again.
        this._attempts = new Map(
            (saved ?? []).map(([digest, key]) => [digest, {key, auto: key === null}]),
        );
        // The credits whose automatic attempt was refused for an unsaved key
        // and reported. Not saved: a new session reports once more.
        this._unsavedReported = new Set();
    }

    /** @returns {Array<[string, string|null]>} JSON-safe state to save, the oldest attempt first. */
    get state() {
        return [...this._attempts].map(([digest, {key}]) => [digest, key]);
    }

    triedAutomatically(digest) {
        return this._attempts.get(digest)?.auto === true;
    }

    markAutomatic(digest) {
        this._newest(digest).auto = true;
    }

    /** Lets auto-redeem try the credit again: a refused attempt used nothing. */
    allowAutomaticAgain(digest) {
        const attempt = this._attempts.get(digest);
        if (!attempt) return;
        attempt.auto = false;
        if (attempt.key === null) this._attempts.delete(digest);
    }

    pendingKey(digest) {
        return this._attempts.get(digest)?.key ?? null;
    }

    start(digest, key) {
        this._newest(digest).key = key;
    }

    /**
     * Forgets the key of the attempt that start() noted: it has an outcome, or
     * nothing was sent. A credit auto-redeem tried stays remembered.
     */
    end(digest) {
        const attempt = this._attempts.get(digest);
        attempt.key = null;
        if (!attempt.auto) this._attempts.delete(digest);
    }

    /**
     * Whether to report that the key of the credit's automatic attempt could
     * not be saved: the first time only, so that the credit cannot expire
     * unnoticed.
     */
    reportUnsavedOnce(digest) {
        if (this._unsavedReported.has(digest)) return false;
        this._unsavedReported.add(digest);
        return true;
    }

    // The attempt record of the credit, created when missing and moved to the
    // end, where the saved state keeps the newest.
    _newest(digest) {
        const attempt = this._attempts.get(digest) ?? {key: null, auto: false};
        this._attempts.delete(digest);
        this._attempts.set(digest, attempt);
        return attempt;
    }
}
