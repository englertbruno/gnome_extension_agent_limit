// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {wallSeconds} from '../misc/clock.js';
import {sha256} from '../misc/digest.js';
import {DiagnosticReporter} from '../providers/diagnostics.js';
import {providerTypeName} from '../shared/providerTypes.js';
import {AccountKey, SettingsKey} from '../shared/settings.js';
import {LowRemainingTracker} from './lowRemaining.js';
import {
    buildPresentation,
    lowRemainingNotification,
    redeemNotification,
    resetExpiryNotification,
    unusedNotification,
} from './presentation.js';
import {autoRedeemCredits, RedeemAttempts} from './redeemAttempts.js';
import {ResetExpiryTracker, UnusedReminder} from './reminders.js';
import {MAX_NOTIFIED_ENTRIES, restoreTimes} from './savedStateFormat.js';
import {createHistory, recordHistory} from './usageHistory.js';
import {UsageState} from './usageState.js';

// While only the reading or a reported reset time changes, the reading file is
// written at most this often.
const READING_WRITE_SPACING_SECONDS = 60;
// An unchanged reading is written again this often, so that a restored one
// shows its age.
const READING_REWRITE_SECONDS = 600;
const HISTORY_WRITE_SPACING_SECONDS = 600;
// Accounts whose request floor is at least this long write the reading file
// for each request, so that the floor outlasts a lock; a shorter one is not
// worth a write per poll.
const SAVE_EACH_REQUEST_FLOOR_SECONDS = 60;
// GLib.timeout_add() takes a uint32 of milliseconds, so the refresh timer
// waits at most a day; the throttled refresh it starts schedules the rest.
const MAX_REFRESH_TIMER_SECONDS = 24 * 3600;

// Names a credit, or the next reset when null, in the saved state.
function creditDigest(creditId) {
    return sha256(creditId ?? '');
}

// Runs one account: polls its provider, shows the result in its indicator and
// saves what the next session restores.
export class UsageController {
    /**
     * The indicator, notifier, provider and store are used, not owned: the
     * account manager destroys them after destroy().
     *
     * @param {object} params
     * @param {Gio.Settings} params.settings  The extension's settings.
     * @param {Gio.Settings} params.accountSettings  The account's child settings.
     * @param {object} params.providerType  The account's PROVIDER_TYPES entry.
     * @param {object} params.i18n  {gettext, ngettext, pgettext} of the extension's domain.
     * @param {Gio.Settings} params.interfaceSettings  org.gnome.desktop.interface, for the clock format.
     * @param {LimitIndicator} params.indicator
     * @param {UsageNotifier} params.notifier
     * @param {object} params.provider
     * @param {SavedStateStore|null} params.store  Null for an account without an instance ID, which saves nothing.
     * @param {string} params.slot  Names the account's saved files.
     * @param {string} params.configKey  providerConfigKey() of the account, which its saved files belong to.
     * @param {SavedAccount|null} params.saved  What the account saved in an earlier session.
     */
    constructor({
        settings,
        accountSettings,
        providerType,
        i18n,
        interfaceSettings,
        indicator,
        notifier,
        provider,
        store,
        slot,
        configKey,
        saved,
        now = () => GLib.get_monotonic_time() / GLib.USEC_PER_SEC,
    }) {
        this._settings = settings;
        this._accountSettings = accountSettings;
        this._providerType = providerType;
        this._i18n = i18n;
        this._interfaceSettings = interfaceSettings;
        this._indicator = indicator;
        this._notifier = notifier;
        this._provider = provider;
        this._store = store;
        this._slot = slot;
        this._configKey = configKey;
        // Minimum seconds between automatic provider requests.
        this._minRefreshSeconds = providerType.minRefreshSeconds;
        this._cancellable = new Gio.Cancellable();
        this._usage = new UsageState();
        this._now = now;
        this._lastRefreshAt = null;
        // Set while the provider asked for no requests before this time.
        this._retryAt = null;
        // Advanced by each new reading that its key does not show to be of
        // the account of the last one. A redemption is confirmed from a menu
        // of one generation and refused in any other: a reading without a key,
        // as of a login without a user ID, cannot be told from another.
        this._accountGeneration = 0;
        if (saved !== null) {
            const times = restoreTimes(saved, {
                wallNow: wallSeconds(),
                monoNow: now(),
                minRefreshSeconds: this._minRefreshSeconds,
            });
            if (saved.reading !== null) this._usage.restore(saved.reading, times.readAt);
            this._lastRefreshAt = times.lastRefreshAt;
            this._retryAt = times.retryAt;
        }
        // What the provider gets back next session. The restored reading holds
        // none, so it is kept here until a result replaces it.
        this._providerState = saved?.providerState ?? null;
        this._refreshTimer = 0;
        this._displayTimer = 0;
        this._diagnostics = new DiagnosticReporter();
        this._lowRemaining = new LowRemainingTracker(saved?.notified?.lowRemaining ?? null);
        this._unusedReminder = new UnusedReminder(saved?.notified?.unused ?? null);
        this._resetExpiry = new ResetExpiryTracker(saved?.notified?.resetExpiry ?? null);
        // The UsageHistory; null while show-history is off or before a reading.
        // A reading file is written on each request and a history file only
        // every few minutes, so after a login switch the history can be the
        // old login's.
        this._history = saved?.history ?? null;
        if (
            this._history !== null &&
            saved.reading !== null &&
            this._history.accountKey !== saved.reading.accountKey
        )
            this._history = null;
        // Whether points were added since the history file was last written,
        // and when that was.
        this._historyChanged = false;
        this._historyWrittenAt = null;
        // {at, writeNow, content, readAt} of the last reading file this
        // controller wrote, in its own clock; null before the first.
        this._written = null;
        // Set while a refresh or a redemption runs; they never overlap, and
        // the menu shows both as refreshing.
        this._refreshing = false;
        // The diagnostic of the last redemption's failure, shown as the menu's
        // error details until the next redemption; null after a success.
        this._redeemDiagnostic = null;
        // Resolvers of the redemptions waiting for the running one to end.
        this._redeemWaiters = [];
        // The manual reset attempts, by creditDigest().
        this._redeemAttempts = new RedeemAttempts(saved?.notified?.redeem ?? null);
        // [emitter, handler ID] pairs.
        this._signals = [];
    }

    // Called once, after the indicator has been added to the panel. The first
    // refresh runs as soon as the restored request floor allows.
    start() {
        for (const key of [
            SettingsKey.GRACE_PERIOD,
            SettingsKey.PANEL_LABEL,
            SettingsKey.SHOW_USED,
            SettingsKey.SHOW_RESET_CLOCK,
        ])
            this._connect(this._settings, `changed::${key}`, () => this._updateDisplay());
        // The account manager deletes the history file when it is turned off.
        this._connect(this._settings, `changed::${SettingsKey.SHOW_HISTORY}`, () => {
            this._dropHistoryIfOff();
            this._updateDisplay();
        });
        this._connect(this._accountSettings, `changed::${AccountKey.REFRESH_INTERVAL}`, () =>
            this._scheduleRefresh(),
        );
        // A stored or removed API key is used as soon as the request floor allows.
        this._connect(this._accountSettings, `changed::${AccountKey.API_KEY_REVISION}`, () =>
            this._scheduleRefresh(0),
        );
        for (const key of [
            AccountKey.NAME,
            AccountKey.LIMIT_ID,
            AccountKey.PANEL_WINDOW,
            AccountKey.USAGE_PAGE_URL,
        ])
            this._connect(this._accountSettings, `changed::${key}`, () => this._updateDisplay());
        this._connect(this._interfaceSettings, 'changed::clock-format', () =>
            this._updateDisplay(),
        );
        this._connect(this._indicator.menu, 'open-state-changed', () => this._updateDisplay());
        this._dropHistoryIfOff();
        this._scheduleRefresh(0);
        this._updateDisplay();
    }

    _connect(emitter, signal, callback) {
        this._signals.push([emitter, emitter.connect(signal, callback)]);
    }

    // Schedules the next refresh in `seconds`, by default the polling
    // interval, but never before the request floor or a requested retry.
    _scheduleRefresh(seconds = this._pollSeconds()) {
        const interval = Math.min(
            MAX_REFRESH_TIMER_SECONDS,
            Math.ceil(Math.max(seconds, this._refreshDelay(this._now()))),
        );
        // timeout_add_seconds() may fire early, and the request floor would
        // then skip that poll for a whole interval.
        if (this._refreshTimer) GLib.Source.remove(this._refreshTimer);
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval * 1000, () => {
            this._refreshTimer = 0;
            this.refresh({automatic: true}).catch(error =>
                logError(error, `Failed to refresh ${this._accountTitle()} usage`),
            );
            return GLib.SOURCE_REMOVE;
        });
    }

    _pollSeconds() {
        const localRetry = this._usage.latestResult?.localRetryAfterSeconds;
        if (Number.isFinite(localRetry) && localRetry > 0) return localRetry;
        return Math.max(
            this._minRefreshSeconds,
            this._accountSettings.get_uint(AccountKey.REFRESH_INTERVAL),
        );
    }

    // Writes nothing, so that disable() starts no I/O; changes not saved yet
    // are lost.
    destroy() {
        if (this._refreshTimer) GLib.Source.remove(this._refreshTimer);
        this._refreshTimer = 0;
        if (this._displayTimer) GLib.Source.remove(this._displayTimer);
        this._displayTimer = 0;
        this._cancellable.cancel();
        // The waiting redemptions return once they see the cancellation.
        for (const resolve of this._redeemWaiters) resolve();
        this._redeemWaiters = null;
        for (const [emitter, id] of this._signals) emitter.disconnect(id);
        this._signals = [];
        this._diagnostics = null;
        this._lowRemaining = null;
        this._unusedReminder = null;
        this._resetExpiry = null;
        this._history = null;
        this._written = null;
        this._redeemDiagnostic = null;
        this._redeemAttempts = null;
        this._store = null;
        this._provider = null;
        this._notifier = null;
        this._cancellable = null;
        this._indicator = null;
        this._settings = null;
        this._accountSettings = null;
        this._providerType = null;
        this._i18n = null;
        this._interfaceSettings = null;
        this._usage = null;
    }

    saveLimitSelection({limitId, panelWindow}) {
        this._accountSettings.set_uint(AccountKey.PANEL_WINDOW, panelWindow);
        this._accountSettings.set_string(AccountKey.LIMIT_ID, limitId);
    }

    // A manual refresh, such as Refresh in the menu, asks at once unless a
    // request or a redemption runs. Only automatic ones wait for the request
    // floor and for a retry time the provider asked for.
    async refresh({automatic = false} = {}) {
        const now = this._now();
        const waiting = this._refreshDelay(now) > 0;
        // Automatic ticks always schedule the next poll; a skipped manual
        // refresh keeps the existing deadline.
        if (automatic || !this._refreshing) this._scheduleRefresh();
        if (this._refreshing || (automatic && waiting)) return;
        const previousRefreshAt = this._lastRefreshAt;
        this._lastRefreshAt = now;
        this._refreshing = true;
        const cancellable = this._cancellable;
        let freshReading = false;
        try {
            this._updateDisplay();
            // The request time is written first, so that a lock during the
            // request cannot lose it; a retry after a local credential check
            // may send no request, so its result writes it. A failed write
            // does not hold back the request.
            if (
                this._minRefreshSeconds >= SAVE_EACH_REQUEST_FLOOR_SECONDS &&
                !(this._usage.latestResult?.localRetryAfterSeconds > 0)
            ) {
                await this._saveState({beforeRequest: true});
                if (cancellable.is_cancelled()) return;
            }
            const result = await this._provider.refresh();
            if (cancellable.is_cancelled()) return;
            const acceptedAt = this._now();
            const previousLocalRetry = this._usage.latestResult?.localRetryAfterSeconds;
            const previousKey = this._usage.lastSuccess?.accountKey ?? null;
            this._usage.accept(result, acceptedAt);
            this._providerState = result.providerState;
            freshReading = this._usage.lastSuccess === result;
            if (freshReading && (result.accountKey === null || result.accountKey !== previousKey))
                this._accountGeneration++;
            if (freshReading) {
                this._recordHistory(result);
                this._autoRedeem(result);
            }
            // Issues without a diagnostic, such as signed-out, neither log nor
            // end an outage.
            if (freshReading) this._diagnostics.recovered();
            else if (result.issue?.diagnostic) this._diagnostics.update(result.issue.diagnostic);
            const localRetry = result.localRetryAfterSeconds;
            const localOnly = Number.isFinite(localRetry) && localRetry > 0;
            if (localOnly) {
                // Local credential checks do not count against the request limit.
                this._lastRefreshAt = previousRefreshAt;
            } else {
                const retryAfter = result.issue?.retryAfterSeconds;
                this._retryAt = Number.isFinite(retryAfter) ? acceptedAt + retryAfter : null;
            }
            // A manual request sent while waiting was scheduled after the
            // wait; the next poll now counts from this request.
            if (
                localOnly ||
                (Number.isFinite(previousLocalRetry) && previousLocalRetry > 0) ||
                this._retryAt !== null ||
                waiting
            )
                this._scheduleRefresh();
        } catch (error) {
            // Providers return failures as results; only cancellation rejects.
            if (!cancellable.is_cancelled()) throw error;
        } finally {
            if (!cancellable.is_cancelled()) {
                this._endOperation();
                this._updateDisplay({freshReading});
            }
        }
        // After the display update, which judges the reading for notifications.
        if (!cancellable.is_cancelled()) this._saveState();
    }

    /**
     * Redeems a manual reset of a type with manualResets once no refresh or
     * other redemption runs, posts its outcome and reads the limits again. The
     * credit is spent for the current login, so a redemption is refused unless
     * a request this session confirmed the account of the menu it came from,
     * named by that presentation's accountGeneration.
     *
     * @param {string|null} creditId  Null lets the service choose the next one.
     * @param {{automatic?: boolean, accountGeneration: number}} options
     */
    async redeemReset(creditId, {automatic = false, accountGeneration}) {
        const cancellable = this._cancellable;
        while (this._refreshing) {
            const {promise, resolve} = Promise.withResolvers();
            this._redeemWaiters.push(resolve);
            await promise;
            if (cancellable.is_cancelled()) return;
        }
        const digest = creditDigest(creditId);
        const reading = this._usage.lastSuccess;
        const confirmed =
            reading !== null &&
            !this._usage.restored &&
            accountGeneration === this._accountGeneration;
        // Auto-redeem can be turned off while the attempt is saved and the
        // provider verifies the account; the provider asks right before it sends.
        const stillAllowed = () =>
            !automatic || this._autoRedeemCredits(reading).some(({id}) => id === creditId);
        if (!confirmed || !stillAllowed()) {
            this._refuseRedemption(digest, automatic, 'unconfirmed');
            return;
        }
        this._refreshing = true;
        this._redeemDiagnostic = null;
        this._updateDisplay();
        const creditTitle =
            reading.resets?.credits?.find(credit => credit.id === creditId)?.title ?? null;
        // An attempt without an outcome is tried again with its key.
        const pendingKey = this._redeemAttempts.pendingKey(digest);
        const idempotencyKey = pendingKey ?? GLib.uuid_string_random();
        this._redeemAttempts.start(digest, idempotencyKey);
        // Before the request, and written out first, so that a retry after a
        // lock or restart reuses the key.
        const saved = await this._saveState();
        if (cancellable.is_cancelled()) return;
        if (!saved) {
            // A retry after a lock or restart would get a new key and could
            // use a second reset, so none is requested. A reused key was
            // written before.
            this._endOperation();
            if (pendingKey === null) this._redeemAttempts.end(digest);
            this._refuseRedemption(digest, automatic, 'unsaved', creditTitle);
            this._updateDisplay();
            return;
        }
        let outcome = null;
        let failure = null;
        try {
            outcome = await this._provider.redeemReset({creditId, idempotencyKey, stillAllowed});
        } catch (error) {
            failure = error;
        }
        if (cancellable.is_cancelled()) return;
        this._endOperation();
        if (outcome === 'withdrawn') {
            // Nothing was sent; auto-redeem may try the credit again.
            this._redeemAttempts.allowAutomaticAgain(digest);
            this._updateDisplay();
            return;
        }
        if (outcome === 'unconfirmed') {
            // The provider found another login or workspace and sent nothing;
            // the attempt keeps its key.
            this._refuseRedemption(digest, automatic, outcome);
        } else {
            if (failure !== null) {
                if (failure.code !== 'redeem-failed') throw failure;
                if (failure.diagnostic) this._diagnostics.update(failure.diagnostic);
                this._redeemDiagnostic = failure.diagnostic ?? null;
            } else {
                this._redeemAttempts.end(digest);
                this._saveState();
            }
            this._notifier.show(
                redeemNotification(
                    {title: this._accountTitle()},
                    {outcome, creditTitle, automatic},
                    {i18n: this._i18n},
                ),
            );
        }
        // A redemption changes the limits, and a refused one may mean that
        // the login changed; read them again at once.
        await this.refresh();
    }

    // Says why a redemption was refused before anything was sent: outcome
    // is 'unconfirmed' or 'unsaved'. An automatic attempt used nothing and
    // may be tried again; it says nothing, except the first time a credit's
    // key cannot be saved, so that the credit cannot expire unnoticed.
    _refuseRedemption(digest, automatic, outcome, creditTitle = null) {
        if (automatic) {
            this._redeemAttempts.allowAutomaticAgain(digest);
            if (outcome !== 'unsaved' || !this._redeemAttempts.reportUnsavedOnce(digest)) return;
        }
        this._notifier.show(
            redeemNotification(
                {title: this._accountTitle()},
                {outcome, creditTitle, automatic},
                {i18n: this._i18n},
            ),
        );
    }

    // Ends the running refresh or redemption and lets the redemptions waiting
    // for it continue.
    _endOperation() {
        this._refreshing = false;
        for (const resolve of this._redeemWaiters.splice(0)) resolve();
    }

    // The credits auto-redeem may use now, while it is on for an account whose
    // type has manual resets. Whether one was tried is not considered.
    _autoRedeemCredits(reading) {
        return autoRedeemCredits(reading, {
            enabled:
                this._providerType.manualResets &&
                this._accountSettings.get_boolean(AccountKey.AUTO_REDEEM),
            nowSeconds: wallSeconds(),
        });
    }

    // Redeems an available manual reset that expires within the hour, once
    // per credit.
    _autoRedeem(reading) {
        const credit = this._autoRedeemCredits(reading).find(
            ({id}) => !this._redeemAttempts.triedAutomatically(creditDigest(id)),
        );
        if (!credit) return;
        this._redeemAttempts.markAutomatic(creditDigest(credit.id));
        this.redeemReset(credit.id, {
            automatic: true,
            accountGeneration: this._accountGeneration,
        }).catch(error =>
            logError(error, `Failed to redeem a ${this._accountTitle()} manual reset`),
        );
    }

    _recordHistory(result) {
        if (!this._settings.get_boolean(SettingsKey.SHOW_HISTORY)) return;
        this._history ??= createHistory(result.accountKey);
        if (recordHistory(this._history, result, Math.floor(wallSeconds())))
            this._historyChanged = true;
    }

    // Turning history off forgets it; the account manager deletes the file of
    // every account, running or not.
    _dropHistoryIfOff() {
        if (this._settings.get_boolean(SettingsKey.SHOW_HISTORY)) return;
        this._history = null;
        this._historyChanged = false;
    }

    // Writes the reading file at once when a writeNow field changed, so that a
    // lock right after cannot lose it, and other changes at most once a minute.
    // beforeRequest writes only when a writeNow field changed, and leaves the
    // reading's write spacing and the history to the result that follows.
    // Resolves to false when the account has no store or the write failed.
    _saveState({beforeRequest = false} = {}) {
        if (this._store === null) return Promise.resolve(false);
        let committed = Promise.resolve(true);
        const now = this._now();
        const usage = this._usage;
        // The store accepts lists of at most MAX_NOTIFIED_ENTRIES; older
        // entries are dropped first.
        const notified = {
            lowRemaining: this._lowRemaining.state,
            unused: this._unusedReminder.state.slice(-MAX_NOTIFIED_ENTRIES),
            resetExpiry: this._resetExpiry.state.slice(-MAX_NOTIFIED_ENTRIES),
            redeem: this._redeemAttempts.state.slice(-MAX_NOTIFIED_ENTRIES),
        };
        // The fields whose change is written at once; JSON text compares them.
        const writeNow = JSON.stringify({
            requestedAt:
                this._minRefreshSeconds >= SAVE_EACH_REQUEST_FLOOR_SECONDS
                    ? this._lastRefreshAt
                    : null,
            retryAt: this._retryAt,
            providerState: this._providerState,
            // A confirmed sign-out, which leaves no reading, must outlast a lock.
            hasReading: usage.lastSuccess !== null,
            // Their reset times shift slightly with each reading, so they are left out.
            lowRemaining: notified.lowRemaining.map(({key, armed}) => [key, armed]),
            unused: notified.unused,
            resetExpiry: notified.resetExpiry,
            redeem: notified.redeem,
        });
        // What else is written: the reading and what `notified` holds.
        const content = JSON.stringify([usage.lastSuccess, notified]);
        const written = this._written;
        const writeNowChanged = written === null || writeNow !== written.writeNow;
        const contentDue =
            written !== null &&
            content !== written.content &&
            now - written.at >= READING_WRITE_SPACING_SECONDS;
        const rewriteDue =
            written !== null &&
            usage.updatedAt !== null &&
            written.readAt !== null &&
            usage.updatedAt - written.readAt >= READING_REWRITE_SECONDS;
        if (writeNowChanged || (!beforeRequest && (contentDue || rewriteDue))) {
            const wallNow = wallSeconds();
            const wallTime = time => (time === null ? null : Math.round(wallNow - (now - time)));
            committed = this._store.saveAccount(this._slot, this._configKey, {
                reading: usage.lastSuccess,
                readAt: wallTime(usage.updatedAt),
                requestedAt: wallTime(this._lastRefreshAt),
                retryAt: wallTime(this._retryAt),
                providerState: this._providerState,
                notified,
            });
            this._written = beforeRequest
                ? {
                      at: written?.at ?? -Infinity,
                      writeNow,
                      content: written?.content ?? null,
                      readAt: written?.readAt ?? null,
                  }
                : {at: now, writeNow, content, readAt: usage.updatedAt};
        }
        if (
            !beforeRequest &&
            this._historyChanged &&
            (this._historyWrittenAt === null ||
                now - this._historyWrittenAt >= HISTORY_WRITE_SPACING_SECONDS)
        ) {
            this._store.saveHistory(this._slot, this._configKey, this._history);
            this._historyChanged = false;
            this._historyWrittenAt = now;
        }
        return committed;
    }

    _refreshDelay(now) {
        return Math.max(
            0,
            this._lastRefreshAt === null ? 0 : this._lastRefreshAt + this._minRefreshSeconds - now,
            this._retryAt === null ? 0 : this._retryAt - now,
        );
    }

    _accountTitle() {
        return (
            this._accountSettings.get_string(AccountKey.NAME) ||
            providerTypeName(this._providerType, this._i18n.gettext)
        );
    }

    // refresh() passes freshReading when it shows a new successful reading.
    // Only such readings are judged for notifications, once each; a restored
    // one can be days old.
    _updateDisplay({freshReading = false} = {}) {
        const now = this._now();
        const nowSeconds = Math.floor(wallSeconds());
        const view = this._usage.view(now, this._settings.get_uint(SettingsKey.GRACE_PERIOD));
        const presentation = buildPresentation(view, {
            i18n: this._i18n,
            providerType: this._providerType,
            accountTitle: this._accountTitle(),
            preferredLimitId: this._accountSettings.get_string(AccountKey.LIMIT_ID),
            panelWindow: this._accountSettings.get_uint(AccountKey.PANEL_WINDOW),
            panelLabel: this._settings.get_string(SettingsKey.PANEL_LABEL),
            showUsed: this._settings.get_boolean(SettingsKey.SHOW_USED),
            showResetClock: this._settings.get_boolean(SettingsKey.SHOW_RESET_CLOCK),
            clockFormat: this._interfaceSettings.get_string('clock-format'),
            showHistory: this._settings.get_boolean(SettingsKey.SHOW_HISTORY),
            history: this._history,
            redeemDiagnostic: this._redeemDiagnostic,
            accountGeneration: this._accountGeneration,
            usagePageUrl:
                this._providerType.id === 'custom'
                    ? this._accountSettings.get_string(AccountKey.USAGE_PAGE_URL)
                    : this._providerType.usageUrl,
            nowSeconds,
            refreshing: this._refreshing,
        });
        if (freshReading && presentation.shownWindow)
            this._notifyIfLow(view.reading, presentation, nowSeconds);
        if (freshReading) this._remind(view.reading, presentation, nowSeconds);
        this._scheduleDisplayUpdate(view, presentation);
        this._indicator.update(presentation);
    }

    // The tracker judges each successful reading once, so redisplays and
    // readings retained during grace never notify.
    _notifyIfLow(reading, presentation, nowSeconds) {
        const {shownWindow} = presentation;
        const notify = this._lowRemaining.update(
            {
                key: JSON.stringify([reading.accountKey, shownWindow.key]),
                readAt: this._usage.updatedAt,
                remainingPercent: shownWindow.remainingPercent,
                resetsAt: shownWindow.resetsAt,
            },
            {
                enabled: this._settings.get_boolean(SettingsKey.NOTIFY_LOW_REMAINING),
                threshold: this._settings.get_uint(SettingsKey.LOW_REMAINING_THRESHOLD),
                nowSeconds,
            },
        );
        if (notify) this._notifier.show(lowRemainingNotification(presentation, {i18n: this._i18n}));
    }

    // Every window of the selected bucket is judged, so that a weekly window
    // is reminded of while the panel shows a shorter one.
    _remind(reading, presentation, nowSeconds) {
        const unusedOptions = {
            enabled: this._settings.get_boolean(SettingsKey.NOTIFY_UNUSED),
            threshold: this._settings.get_uint(SettingsKey.UNUSED_THRESHOLD),
            hours: this._settings.get_uint(SettingsKey.UNUSED_HOURS),
            nowSeconds,
        };
        for (const window of presentation.bucketWindows) {
            const projectedPercent = this._unusedReminder.update(
                {
                    key: JSON.stringify([reading.accountKey, window.key]),
                    durationMinutes: window.durationMinutes,
                    remainingPercent: window.remainingPercent,
                    resetsAt: window.resetsAt,
                },
                unusedOptions,
            );
            if (projectedPercent !== null) {
                this._notifier.show(
                    unusedNotification(presentation, window, projectedPercent, {i18n: this._i18n}),
                );
            }
        }
        const expiring = this._resetExpiry.update(reading.resets, {
            enabled: this._settings.get_boolean(SettingsKey.NOTIFY_RESET_EXPIRY),
            nowSeconds,
        });
        for (const credit of expiring) {
            this._notifier.show(
                resetExpiryNotification(presentation, credit, {i18n: this._i18n, nowSeconds}),
            );
        }
    }

    // Seconds until the panel countdown changes, which rounds up to the minute,
    // so that it neither lags nor outlasts the reset; 60 without a countdown.
    _secondsToCountdownMinute(presentation) {
        if (!presentation.panelCountdown) return 60;
        const remaining = presentation.shownWindow.resetsAt - wallSeconds();
        return (remaining % 60 || 60) + 0.01;
    }

    // Seconds until grace expiry, the reading's age, the panel countdown or an
    // open menu's countdowns change the display between polls; null when none
    // is shown.
    _secondsToDisplayChange(view, presentation) {
        const menuOpen = this._indicator.menu.isOpen;
        if (
            view.ageSeconds === null &&
            !presentation.panelCountdown &&
            !(menuOpen && presentation.timedCountdown)
        )
            return null;
        // Second ticks land just after the wall-clock second changes.
        const interval =
            presentation.secondsCountdown && menuOpen
                ? 1 - (GLib.get_real_time() % GLib.USEC_PER_SEC) / GLib.USEC_PER_SEC + 0.01
                : this._secondsToCountdownMinute(presentation);
        return view.remainingGrace > 0 ? Math.min(interval, view.remainingGrace) : interval;
    }

    _scheduleDisplayUpdate(view, presentation) {
        const seconds = this._secondsToDisplayChange(view, presentation);
        if (this._displayTimer) GLib.Source.remove(this._displayTimer);
        this._displayTimer = 0;
        if (seconds === null) return;
        this._displayTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(seconds * 1000)),
            () => {
                this._displayTimer = 0;
                this._updateDisplay();
                return GLib.SOURCE_REMOVE;
            },
        );
    }
}
