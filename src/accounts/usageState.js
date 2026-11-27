// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Times are monotonic seconds from the controller.
export class UsageState {
    constructor() {
        // The most recent UsageResult, successful or not.
        this.latestResult = null;
        // The last result with usage, shown during a transient failure of the
        // same account.
        this.lastSuccess = null;
        this.updatedAt = null;
        // Whether lastSuccess is a reading from an earlier session that no
        // request has confirmed yet; it may belong to another login.
        this.restored = false;
        // Set while retaining: when the first transient failure happened, or
        // when the retry delay it requested ends.
        this.graceStartsAt = null;
    }

    /**
     * Shows a reading saved in an earlier session as the last success, so
     * the first refresh replaces it. Called before any accept().
     *
     * @param {UsageResult} reading Without identity, issue or provider state.
     * @param {number} readAt When it was read, on this state's clock.
     */
    restore(reading, readAt) {
        this.latestResult = reading;
        this.lastSuccess = reading;
        this.updatedAt = readAt;
        this.restored = true;
    }

    accept(result, now) {
        this.latestResult = result;
        // An account read failure has no identity; it cannot prove a switch.
        const sameKey =
            typeof result.accountKey === 'string' &&
            result.accountKey === this.lastSuccess?.accountKey;
        const unverifiedRead =
            result.accountKey === null && result.account.status === 'unavailable';
        const sameAccount =
            this.lastSuccess !== null &&
            result.providerType === this.lastSuccess.providerType &&
            (sameKey || unverifiedRead);
        if (result.issue?.transient && sameAccount) {
            // Later failures, and the delays they request, do not postpone grace.
            this.graceStartsAt ??= now + (result.issue.retryAfterSeconds ?? 0);
            return;
        }

        this.graceStartsAt = null;
        this.restored = false;
        const hasUsage =
            result.issue === null &&
            result.account.status === 'ready' &&
            result.buckets.some(
                bucket =>
                    bucket.windows.some(window => Number.isFinite(window.remainingPercent)) ||
                    Number.isFinite(bucket.money?.balance) ||
                    Number.isFinite(bucket.money?.used),
            );
        this.lastSuccess = hasUsage ? result : null;
        this.updatedAt = hasUsage ? now : null;
    }

    view(now, graceSeconds) {
        // While retaining, show the last successful reading; the latest issue
        // appears once grace expires.
        const retaining = this.graceStartsAt !== null;
        const remainingGrace = retaining
            ? Math.max(0, this.graceStartsAt + graceSeconds - now)
            : null;
        const stale = retaining && remainingGrace === 0;
        return {
            reading: retaining ? this.lastSuccess : this.latestResult,
            issue: retaining && !stale ? null : (this.latestResult?.issue ?? null),
            stale,
            ageSeconds: this.updatedAt === null ? null : Math.max(0, now - this.updatedAt),
            remainingGrace,
        };
    }
}
