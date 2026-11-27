// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {formatClockTime, formatMoney} from '../shared/formatting.js';
import {parseLabelTemplate, renderLabel} from '../shared/labelTemplate.js';
import {providerTypeName} from '../shared/providerTypes.js';
import {PanelWindow} from '../shared/settings.js';
import {issueText, statusText} from './issues.js';
import {historySlots, seriesKey} from './usageHistory.js';

// The history chart shows the last seven days in three-hour slots.
const HISTORY_SLOT_SECONDS = 3 * 3600;
const HISTORY_SLOTS = 56;

// The average rate of use is projected only once this share of the window, and
// at least this long, has elapsed.
const PACE_MIN_ELAPSED_FRACTION = 0.1;
const PACE_MIN_ELAPSED_SECONDS = 15 * 60;

// A well-formed ISO 4217 code; Intl.NumberFormat throws on anything else.
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/**
 * Builds everything an account's indicator, menu and notifications show. A
 * null text, setup, resets, history or URL hides its item, and an empty
 * panelText the panel label.
 *
 * @param {{reading: UsageResult|null, issue: UsageIssue|null, stale: boolean, ageSeconds: number|null}} view
 *     From UsageState.view().
 * @param {object} options  The account's settings and state: preferredLimitId '' selects the type's default bucket,
 *     panelWindow is a PanelWindow value, clockFormat the desktop's '24h' or '12h', and nowSeconds wall-clock time.
 */
export function buildPresentation(view, options) {
    const {
        i18n,
        providerType,
        accountTitle,
        preferredLimitId,
        panelWindow,
        panelLabel,
        showUsed,
        showResetClock,
        clockFormat,
        showHistory,
        history,
        redeemDiagnostic,
        accountGeneration,
        usagePageUrl,
        nowSeconds,
        refreshing,
    } = options;
    const {gettext: _} = i18n;
    const {reading, issue, stale, ageSeconds} = view;
    const typeName = providerTypeName(providerType, _);
    const context = {i18n, typeName, nowSeconds, showUsed, showResetClock, clockFormat};

    const buckets = reading?.buckets ?? [];
    const initialLimitId = providerType.defaultLimitId ?? buckets[0]?.id ?? '';
    const limitId = preferredLimitId || initialLimitId;
    const selected = buckets.find(bucket => bucket.id === limitId);
    const selectedWindow = selectPanelWindow(selected, panelWindow);
    const remainingPercent = selectedWindow?.remainingPercent ?? null;
    // A bucket without windows shows its balance or spend instead.
    const selectedAmount = selected && !selectedWindow ? moneyAmount(selected.money) : null;
    const pace = selectedWindow && !stale ? paceText(selectedWindow, context) : null;

    const bucketRows = buckets.map(bucket =>
        bucketOptions(bucket, {
            selected: bucket === selected,
            selectedWindow: bucket === selected ? selectedWindow : null,
            pace,
            panelWindow,
            context,
        }),
    );
    // bucketOptions() makes one row per window, in order.
    const selectedRows = selected ? bucketRows[buckets.indexOf(selected)] : [];
    const bucketWindows = (selected?.windows ?? []).map((window, index) =>
        notifiedWindow(window, selectedRows[index], context),
    );
    const rows = bucketRows.flat();
    // Keep a selected but unavailable limit as the checked row.
    if (buckets.length > 0 && !rows.some(row => row.selected)) {
        const name = selected
            ? (bucketLabel(selected, typeName) ?? typeName)
            : limitId === initialLimitId
              ? typeName
              : limitId;
        rows.unshift({
            key: JSON.stringify([limitId, null]),
            limitId,
            panelWindow,
            name,
            percentText: formatPercent(null),
            remainingPercent: null,
            resetText: '',
            paceText: null,
            accessibleName: percentSentence(name, null, context),
            selected: true,
        });
    }
    const shownOption = rows.find(row => row.selected);

    // Each fact once: the row shows a balance and the submenu the manual
    // resets. The age stands beside a stale reading's status, else at the end.
    const details = [];
    const credits = selected?.credits ? creditsText(selected.credits, i18n) : null;
    if (credits) details.push(credits);
    const money =
        selected?.money && !(selected.money.kind === 'balance' && selectedAmount !== null)
            ? moneyText(selected.money, i18n)
            : null;
    if (money) details.push(money);
    const resets = reading?.resets ? manualResetsMenu(reading.resets, context) : null;
    if (reading?.resets && resets === null) details.push(manualResetsText(reading.resets, context));
    const age = ageSeconds === null ? null : lastUpdatedText(ageSeconds, i18n);

    let status = issue ? issueText(issue, {i18n, providerType}) : bucketStatusText(selected, i18n);
    if (reading && status === null) {
        const code = !selected
            ? 'selected-limit-unavailable'
            : !selectedWindow && selectedAmount === null
              ? 'no-windows'
              : selected.windows.some(window => window.remainingPercent === 0)
                ? 'window-exhausted'
                : null;
        if (code !== null) status = statusText({code}, {i18n});
    }
    if (stale)
        status = joinWithDots(
            [statusText({code: 'stale'}, {i18n}), status].filter(text => text !== null),
            i18n,
        );

    const {panelText, panelCountdown} = renderPanelLabel(panelLabel, {
        selectedWindow,
        selectedAmount,
        accountTitle,
        context,
    });

    const shownName = shownOption?.name ?? _('Usage');
    /* Translators: the top bar button's name for screen readers begins with the account and the limit it shows, such as “Work, Weekly”. */
    const subject = _('%1$s, %2$s').format(accountTitle, shownName);
    const shownSentence =
        selectedAmount === null
            ? percentSentence(subject, remainingPercent, context)
            : nameValue(subject, selectedAmount, i18n);

    // Credit grants and manual resets count down to their expiry; other
    // windows to their reset.
    const countdownTimes = [
        ...buckets.flatMap(bucket =>
            bucket.windows.map(window =>
                window.id === 'credit' ? window.expiresAt : window.resetsAt,
            ),
        ),
        ...(reading?.resets ? availableResets(reading.resets, nowSeconds) : []).map(
            credit => credit.expiresAt,
        ),
    ].filter(time => time !== null && time > nowSeconds);

    const accountState =
        reading === null
            ? _('Checking account and usage…')
            : (reading.account.identity ?? accountStateText(reading.account.status, i18n));
    const plan = reading?.account.plan ?? null;
    /* Translators: %s is a plan name as the service names it, such as Pro. */
    const planName = plan === null ? null : _('Plan: %s').format(plan);
    // The type's name only where the title does not already show it.
    const accountTexts = [
        accountTitle === typeName ? null : typeName,
        accountState,
        planName,
    ].filter(text => text !== null);
    return {
        title: accountTitle,
        accountText: accountTexts.length === 0 ? null : joinWithDots(accountTexts, i18n),
        panelText,
        panelCountdown,
        remainingPercent,
        options: rows,
        details,
        // A manual reset is redeemed only while the controller's generation is still this one.
        accountGeneration,
        resets,
        history:
            showHistory && history !== null && selectedWindow
                ? historyChart(history, selected, selectedWindow, context)
                : null,
        statusText: stale ? `${status}\n${age}` : status,
        lastUpdatedText: stale ? null : age,
        setup: setupAction(issue, providerType, i18n),
        diagnosticDetails: issue?.diagnostic?.details ?? redeemDiagnostic?.details ?? null,
        usagePageUrl: usagePageUrl || null,
        accessibleName: status
            ? /* Translators: the top bar button's name for screen readers: the usage it shows, then the account's status, such as “Work, Weekly: 86% remaining. Usage is stale”. */
              _('%1$s. %2$s').format(shownSentence, status)
            : shownSentence,
        stale,
        refreshing,
        timedCountdown: countdownTimes.length > 0,
        // Countdowns under an hour show seconds; longer ones show minutes.
        secondsCountdown: countdownTimes.some(time => time - nowSeconds < 3600),
        // Judged by the unused reminder, and the panel's window by the low-remaining tracker.
        bucketWindows,
        shownWindow: selectedWindow
            ? bucketWindows[selected.windows.indexOf(selectedWindow)]
            : null,
    };
}

// A window as the notification trackers judge it, with its row's name and
// reset as one line: "Weekly: 86% remaining · Resets in 3d 5h".
function notifiedWindow(window, row, context) {
    return {
        key: row.key,
        durationMinutes: window.durationMinutes,
        remainingPercent: window.remainingPercent,
        resetsAt: window.resetsAt,
        summary: joinWithDots(
            [percentSentence(row.name, window.remainingPercent, context), row.resetText].filter(
                text => text !== '',
            ),
            context.i18n,
        ),
    };
}

// Texts joined by middle dots, as "Usage is stale · Rate limit reached"; one
// text or more.
function joinWithDots(texts, i18n) {
    const {gettext: _} = i18n;
    /* Translators: two texts joined by a middle dot, such as a limit and its reset: “Weekly: 86% remaining · Resets in 3d 5h”. */
    return texts.reduce((joined, text) => _('%1$s · %2$s').format(joined, text));
}

/**
 * The notification for the shown window running low.
 *
 * @param {{title: string, shownWindow: object}} presentation From buildPresentation().
 * @returns {{title: string, body: string}}
 */
export function lowRemainingNotification({title, shownWindow}, {i18n}) {
    const {gettext: _} = i18n;
    return {
        /* Translators: notification title when little of the limit shown in the top bar is left. %s is an account name, such as Codex or Work. */
        title: _('%s limit running low').format(title),
        body: shownWindow.summary,
    };
}

/**
 * The reminder that much of a window will reset unused.
 *
 * @param {{title: string}} presentation From buildPresentation().
 * @param {{summary: string}} window One of the presentation's bucketWindows.
 * @param {number} projectedPercent From UnusedReminder.update().
 * @returns {{title: string, body: string}}
 */
export function unusedNotification({title}, window, projectedPercent, {i18n}) {
    const {gettext: _} = i18n;
    /* Translators: %s is a percentage. */
    const projection = _('At the current pace, about %s will be left at the reset').format(
        formatPercent(projectedPercent),
    );
    return {
        /* Translators: notification title. %s is an account name, such as Codex or Work. */
        title: _('%s usage will reset unused').format(title),
        body: `${projection}\n${window.summary}`,
    };
}

/**
 * The notice that a manual reset expires soon.
 *
 * @param {{title: string}} presentation From buildPresentation().
 * @param {{title: string|null, expiresAt: number}} credit From ResetExpiryTracker.update().
 * @returns {{title: string, body: string}}
 */
export function resetExpiryNotification({title}, credit, {i18n, nowSeconds}) {
    const {gettext: _} = i18n;
    return {
        /* Translators: notification title. %s is an account name, such as Codex or Work. */
        title: _('%s manual reset expires soon').format(title),
        /* Translators: %1$s is the name of a manual reset and %2$s a countdown. */
        body: _('%1$s expires in %2$s').format(
            credit.title ?? _('Manual reset'),
            formatCountdown(credit.expiresAt - nowSeconds, i18n),
        ),
    };
}

/**
 * The notice of an attempt to use a manual reset. outcome is the provider's,
 * 'unconfirmed' or 'unsaved' for one refused before it was sent, or null for
 * one that failed.
 *
 * @param {{title: string}} account
 * @param {{outcome: string|null, creditTitle: string|null, automatic: boolean}} attempt
 * @returns {{title: string, body: string}}
 */
export function redeemNotification({title}, {outcome, creditTitle, automatic}, {i18n}) {
    const {gettext: _} = i18n;
    const name = creditTitle ?? _('Manual reset');
    if (outcome === 'reset' || outcome === 'alreadyRedeemed') {
        return {
            /* Translators: %s is an account name, such as Codex or Work. */
            title: _('%s usage limits reset').format(title),
            body: automatic
                ? /* Translators: %s is the name of a manual reset. */
                  _('“%s” was used automatically before it expired').format(name)
                : /* Translators: %s is the name of a manual reset. */
                  _('“%s” was used').format(name),
        };
    }
    let reason = _('The request failed.');
    if (outcome === 'nothingToReset') reason = _('No usage limit can be reset now.');
    else if (outcome === 'noCredit') reason = _('No manual reset is available.');
    else if (outcome === 'unconfirmed')
        reason = _('The account is not confirmed. Try again once its limits are shown.');
    else if (outcome === 'unsaved')
        reason = _('The extension could not write to disk, so the reset was not requested.');
    return {
        /* Translators: %s is an account name, such as Codex or Work. */
        title: _('%s manual reset not used').format(title),
        body: automatic
            ? /* Translators: %1$s is the name of a manual reset and %2$s the reason it was not used. */
              _('Auto-redeem tried “%1$s” before it expired. %2$s').format(name, reason)
            : reason,
    };
}

// The panel label; panelCountdown tells that it shows a reset time.
function renderPanelLabel(template, {selectedWindow, selectedAmount, accountTitle, context}) {
    const {i18n, nowSeconds, showUsed, clockFormat} = context;
    const remainingPercent = selectedWindow?.remainingPercent ?? null;
    const resetsAt = selectedWindow?.resetsAt ?? null;
    const futureReset = resetsAt !== null && resetsAt > nowSeconds ? resetsAt : null;
    const {parts} = parseLabelTemplate(template);
    const panelText = renderLabel(parts, {
        percent: selectedAmount ?? formatPercent(shownPercent(remainingPercent, showUsed)),
        remaining: formatPercent(remainingPercent),
        used: formatPercent(shownPercent(remainingPercent, true)),
        reset:
            futureReset === null
                ? ''
                : formatMinuteCountdown(futureReset - nowSeconds, i18n, {padded: true}),
        reset_time:
            futureReset === null ? '' : formatClockTime(futureReset, nowSeconds, clockFormat),
        window: selectedWindow ? windowLabel(selectedWindow, i18n) : '',
        account: accountTitle,
    });
    const showsReset = parts.some(
        part =>
            part.type === 'placeholder' && (part.name === 'reset' || part.name === 'reset_time'),
    );
    return {panelText, panelCountdown: futureReset !== null && showsReset};
}

// Every window becomes a row; only the weekly and shortest are selectable. A
// bucket without windows but with money becomes one selectable row. The pace
// is the selected window's.
function bucketOptions(bucket, {selected, selectedWindow, pace, panelWindow, context}) {
    const {gettext: _} = context.i18n;
    if (bucket.windows.length === 0) {
        const amount = moneyAmount(bucket.money);
        if (amount === null) return [];
        const name = bucketLabel(bucket, context.typeName) ?? context.typeName;
        return [
            {
                key: JSON.stringify([bucket.id, 'money']),
                limitId: bucket.id,
                panelWindow,
                name,
                percentText: amount,
                remainingPercent: null,
                resetText: '',
                paceText: null,
                accessibleName: nameValue(name, amount, context.i18n),
                selected,
            },
        ];
    }

    const weekly = selectPanelWindow(bucket, PanelWindow.WEEKLY);
    const shortest = selectPanelWindow(bucket, PanelWindow.SHORTEST);
    // Window IDs can repeat within a bucket, so repeats add their occurrence to the key.
    const occurrences = new Map();
    return bucket.windows.map(window => {
        const occurrence = occurrences.get(window.id) ?? 0;
        occurrences.set(window.id, occurrence + 1);
        const name = optionName(bucket, window, context);
        const resetText =
            window.id === 'credit'
                ? expiryText(window.expiresAt, context)
                : resetTimeText(window.resetsAt, context);
        const sentence = percentSentence(name, window.remainingPercent, context);
        return {
            key: JSON.stringify(
                occurrence ? [bucket.id, window.id, occurrence] : [bucket.id, window.id],
            ),
            limitId: bucket.id,
            panelWindow:
                window === weekly
                    ? PanelWindow.WEEKLY
                    : window === shortest
                      ? PanelWindow.SHORTEST
                      : null,
            name,
            percentText: rowPercentText(window.remainingPercent, context),
            remainingPercent: window.remainingPercent,
            resetText,
            paceText: window === selectedWindow ? pace : null,
            accessibleName: resetText
                ? /* Translators: a limit's menu row as screen readers name it: its usage, then its reset, such as “Weekly: 86% remaining, Resets in 3d 5h”. */
                  _('%1$s, %2$s').format(sentence, resetText)
                : sentence,
            selected: window === selectedWindow,
        };
    });
}

// The bucket's name without the type's name, which the menu already shows;
// null for the type's own bucket and unnamed grants.
function bucketLabel(bucket, typeName) {
    if (bucket.name === null || bucket.name === typeName) return null;
    return bucket.name.startsWith(`${typeName} `)
        ? bucket.name.slice(typeName.length + 1)
        : bucket.name;
}

// "Weekly" for the type's own bucket, "Spark Weekly" for another.
function optionName(bucket, window, {i18n, typeName}) {
    const label = windowLabel(window, i18n);
    const name = bucketLabel(bucket, typeName);
    if (name === null) return label;
    if ((window.id === 'quota' || window.id === 'credit') && window.durationMinutes === null)
        return name;
    const {pgettext} = i18n;
    /* Translators: a limit and its window, such as "Spark Weekly". */
    return pgettext('limit and window', '%1$s %2$s').format(name, label);
}

function selectPanelWindow(bucket, preference) {
    const windows = bucket?.windows ?? [];
    const timed = windows.filter(window => window.durationMinutes !== null);
    if (preference === PanelWindow.WEEKLY) {
        const weekly = timed.find(window => window.durationMinutes === 10080);
        if (weekly) return weekly;
    }

    // Without a weekly window, fall back to the longest or shortest one.
    return (
        timed.reduce((selected, window) => {
            if (!selected) return window;
            const prefer =
                preference === PanelWindow.SHORTEST
                    ? window.durationMinutes < selected.durationMinutes
                    : window.durationMinutes > selected.durationMinutes;
            return prefer ? window : selected;
        }, null) ??
        windows[0] ??
        null
    );
}

function windowLabel(window, i18n) {
    const {gettext: _, ngettext} = i18n;
    const minutes = window.durationMinutes;
    if (minutes === null) {
        if (window.id === 'quota') return _('Quota');
        if (window.id === 'credit') return _('Credit');
        if (window.id === 'spend') return _('Extra usage');
        return window.id === 'secondary' ? _('Secondary window') : _('Primary window');
    }
    if (minutes === 10080) return _('Weekly');
    if (minutes % 1440 === 0) {
        const days = minutes / 1440;
        /* Translators: the length of a usage window, shown as a row label in the menu, such as "5-day". */
        return ngettext('%d-day', '%d-day', days).format(days);
    }
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        /* Translators: the length of a usage window, shown as a row label in the menu, such as "5-hour". */
        return ngettext('%d-hour', '%d-hour', hours).format(hours);
    }
    const formattedMinutes = new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 2,
        useGrouping: false,
    }).format(minutes);
    /* Translators: the length of a usage window, shown as a row label in the menu, such as "15-minute". %s is a number. */
    return ngettext('%s-minute', '%s-minute', Math.round(minutes)).format(formattedMinutes);
}

function resetTimeText(resetsAt, {i18n, nowSeconds, showResetClock, clockFormat}) {
    const {gettext: _} = i18n;
    if (resetsAt === null) return _('Reset time unavailable');
    if (resetsAt <= nowSeconds) return _('Reset pending refresh');
    const countdown = formatCountdown(resetsAt - nowSeconds, i18n);
    /* Translators: %s is a countdown, such as "3d 5h". */
    if (!showResetClock) return _('Resets in %s').format(countdown);
    const clock = formatClockTime(resetsAt, nowSeconds, clockFormat);
    /* Translators: %1$s is a countdown and %2$s a clock time, such as "Resets in 3d 5h (Thu 09:00)". */
    return _('Resets in %1$s (%2$s)').format(countdown, clock);
}

// An empty string hides the time column when a credit has no expiry date.
function expiryText(expiresAt, {i18n, nowSeconds, showResetClock, clockFormat}) {
    const {gettext: _} = i18n;
    if (expiresAt === null) return '';
    if (expiresAt <= nowSeconds) return _('Expired');
    const countdown = formatCountdown(expiresAt - nowSeconds, i18n);
    /* Translators: %s is a countdown, such as "3d 5h". */
    if (!showResetClock) return _('Expires in %s').format(countdown);
    const clock = formatClockTime(expiresAt, nowSeconds, clockFormat);
    /* Translators: %1$s is a countdown and %2$s a clock time, such as "Expires in 3d 5h (Thu 09:00)". */
    return _('Expires in %1$s (%2$s)').format(countdown, clock);
}

// Extrapolates the average rate of use since the window started. Null without a
// duration and a future reset, early in the window, or when none or all is used.
function paceText({durationMinutes, remainingPercent, resetsAt}, {i18n, nowSeconds}) {
    const {gettext: _} = i18n;
    if (durationMinutes === null || resetsAt === null || resetsAt <= nowSeconds) return null;
    if (remainingPercent === null || remainingPercent === 0) return null;
    const usedPercent = 100 - remainingPercent;
    const durationSeconds = durationMinutes * 60;
    const elapsedSeconds = nowSeconds - (resetsAt - durationSeconds);
    if (
        usedPercent === 0 ||
        elapsedSeconds < durationSeconds * PACE_MIN_ELAPSED_FRACTION ||
        elapsedSeconds < PACE_MIN_ELAPSED_SECONDS
    )
        return null;
    const secondsUntilEmpty = (remainingPercent * elapsedSeconds) / usedPercent;
    if (secondsUntilEmpty >= resetsAt - nowSeconds)
        return _('At the current pace, lasts until the reset');
    /* Translators: %s is a countdown, such as "4h 30m". */
    return _('At the current pace, runs out in %s').format(
        formatMinuteCountdown(secondsUntilEmpty, i18n),
    );
}

function creditsText(credits, i18n) {
    const {gettext: _} = i18n;
    if (credits.unlimited) return _('Credits: unlimited');
    if (!credits.available) return _('No credits available');
    if (credits.balance === null) return _('Credits available');
    const balance = new Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(
        credits.balance,
    );
    /* Translators: %s is a number of credits. */
    return _('Credits: %s').format(balance);
}

// Null for an unknown amount or a malformed currency code.
function formatAmount(amount, currency) {
    if (!Number.isFinite(amount) || !CURRENCY_CODE.test(currency)) return null;
    return formatMoney(amount, currency);
}

// The balance, or else the spend, of a bucket shown by its money.
function moneyAmount(money) {
    if (money === null) return null;
    return formatAmount(money.balance, money.currency) ?? formatAmount(money.used, money.currency);
}

function moneyText(money, i18n) {
    const {gettext: _} = i18n;
    const used = formatAmount(money.used, money.currency);
    const limit = formatAmount(money.limit, money.currency);
    const balance = formatAmount(money.balance, money.currency);
    switch (money.kind) {
        case 'extra-usage':
            if (money.enabled === false) return _('Extra usage disabled');
            if (used === null) return _('Extra usage enabled');
            /* Translators: %1$s is the amount spent and %2$s its monthly cap. */
            if (limit !== null) return _('Extra usage: %1$s of %2$s').format(used, limit);
            // An unknown cap (undefined) shows the spend alone; null means no cap.
            /* Translators: %s is the amount spent. */
            if (money.limit === undefined) return _('Extra usage: %s').format(used);
            /* Translators: %s is the amount spent. */
            return _('Extra usage: %s (no cap)').format(used);
        case 'key-limit': {
            const left =
                balance ??
                (Number.isFinite(money.limit) && Number.isFinite(money.used)
                    ? formatAmount(money.limit - money.used, money.currency)
                    : null);
            if (left !== null && limit !== null)
                /* Translators: %1$s is the amount left and %2$s the API key's limit. */
                return _('Key limit: %1$s of %2$s left').format(left, limit);
            /* Translators: %s is the amount spent with the API key. */
            return used === null ? null : _('Key usage: %s').format(used);
        }
        case 'allowance':
            if (balance !== null && limit !== null)
                /* Translators: Allowance is the amount an API account may still use, such as a credit balance. %1$s is what is left and %2$s the total limit. */
                return _('Allowance: %1$s of %2$s left').format(balance, limit);
            /* Translators: Allowance is the amount an API account may still use, such as a credit balance. %s is what is left. */
            return balance === null ? null : _('Allowance: %s left').format(balance);
        case 'balance':
            /* Translators: %s is an amount of money. */
            return balance === null ? null : _('Balance: %s').format(balance);
    }
    return null;
}

// Available manual resets, the soonest expiry first and those without one last.
// A credit past its expiry is not offered, whatever the last reading says.
function availableResets(resets, nowSeconds) {
    return (resets.credits ?? [])
        .filter(
            credit =>
                credit.status === 'available' &&
                (credit.expiresAt === null || credit.expiresAt > nowSeconds),
        )
        .sort((first, second) => {
            if (first.expiresAt === second.expiresAt) return 0;
            if (first.expiresAt === null) return 1;
            if (second.expiresAt === null) return -1;
            return first.expiresAt - second.expiresAt;
        });
}

function manualResetsText(resets, {i18n, nowSeconds}) {
    const {gettext: _} = i18n;
    const next = availableResets(resets, nowSeconds).find(credit => credit.expiresAt !== null);
    /* Translators: %d is a number of manual resets. */
    if (!next) return _('Manual resets: %d').format(resets.available);
    /* Translators: %1$d is a number of manual resets and %2$s a countdown. */
    return _('Manual resets: %1$d · next expires in %2$s').format(
        resets.available,
        formatCountdown(next.expiresAt - nowSeconds, i18n),
    );
}

// The submenu of manual resets. Without listed resets, the next one is
// redeemed by the count alone.
function manualResetsMenu(resets, context) {
    const {gettext: _} = context.i18n;
    if (resets.available === 0) return null;
    const items = availableResets(resets, context.nowSeconds).map(credit => ({
        id: credit.id,
        text: credit.title ?? _('Manual reset'),
        expiryText: expiryText(credit.expiresAt, context),
    }));
    return {
        /* Translators: a submenu title. %d is a number of manual resets. */
        summary: _('Manual Resets (%d)').format(resets.available),
        items,
        canRedeemNext: (resets.credits ?? []).length === 0,
    };
}

// The use of the shown window per three-hour slot over the last seven days,
// with what was left after each slot, and the busiest slot in words.
function historyChart(history, bucket, window, {i18n, nowSeconds, clockFormat}) {
    const {gettext: _} = i18n;
    const points =
        window.durationMinutes === null ? null : history.series[seriesKey(bucket, window)];
    if (!points || points.length < 2) return null;
    const utcOffsetSeconds = -new Date(nowSeconds * 1000).getTimezoneOffset() * 60;
    const {start, sums, remaining} = historySlots(points, nowSeconds, {
        slotSeconds: HISTORY_SLOT_SECONDS,
        slots: HISTORY_SLOTS,
        utcOffsetSeconds,
    });
    const most = Math.max(...sums);
    if (most <= 0) return {slots: sums, remaining, summary: _('No use in the last seven days')};
    const from = start + sums.indexOf(most) * HISTORY_SLOT_SECONDS;
    const range = new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hourCycle: clockFormat === '24h' ? 'h23' : 'h12',
    }).formatRange(from * 1000, (from + HISTORY_SLOT_SECONDS) * 1000);
    /* Translators: %s is a weekday and time range, such as "Tue 15:00 – 18:00". */
    return {slots: sums, remaining, summary: _('Most use on %s').format(range)};
}

function setupAction(issue, providerType, i18n) {
    const {gettext: _} = i18n;
    const {name, installUrl} = providerType;
    switch (issue?.setup) {
        case 'install':
            return installUrl === null
                ? null
                : /* Translators: a menu item that opens the install page. %s is a product name, such as Codex. */
                  {text: _('Install %s…').format(name), url: installUrl};
        case 'update':
            return installUrl === null
                ? null
                : /* Translators: a menu item that opens the install page. %s is a product name, such as Codex. */
                  {text: _('Update %s…').format(name), url: installUrl};
        case 'api-key':
            return {text: _('Add API Key…'), settings: true};
        case 'settings':
            return {text: _('Open Settings…'), settings: true};
    }
    // Signing in needs the command the status text names.
    return null;
}

function bucketStatusText(bucket, i18n) {
    if (!bucket || bucket.statuses.length === 0) return null;
    return joinWithDots(
        bucket.statuses.map(status => statusText(status, {i18n})),
        i18n,
    );
}

function accountStateText(status, i18n) {
    const {gettext: _} = i18n;
    switch (status) {
        case 'signed-out':
            return _('Not signed in');
        case 'unsupported':
            return _('Unsupported login');
        case 'unavailable':
            return _('Account unavailable');
        case 'setup-required':
            return _('Setup required');
    }
    return null;
}

function lastUpdatedText(ageSeconds, i18n) {
    const {gettext: _, ngettext} = i18n;
    if (ageSeconds < 60) return _('Last updated less than a minute ago');
    const minutes = Math.floor(ageSeconds / 60);
    if (minutes < 60)
        return ngettext(
            /* Translators: %d is a number of minutes. */
            'Last updated %d minute ago',
            'Last updated %d minutes ago',
            minutes,
        ).format(minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        /* Translators: %d is a number of hours. */
        return ngettext('Last updated %d hour ago', 'Last updated %d hours ago', hours).format(
            hours,
        );
    const days = Math.floor(hours / 24);
    /* Translators: %d is a number of days. */
    return ngettext('Last updated %d day ago', 'Last updated %d days ago', days).format(days);
}

// "29m 5s" under an hour, otherwise as formatMinuteCountdown().
function formatCountdown(totalSeconds, i18n) {
    const {pgettext} = i18n;
    if (totalSeconds >= 3600) return formatMinuteCountdown(totalSeconds, i18n);
    /* Translators: a countdown in the menu until a limit resets. %1$s is minutes and %2$s is seconds; m and s abbreviate minutes and seconds. Example: "29m 5s". */
    return pgettext('countdown', '%1$sm %2$ss').format(
        Math.floor(totalSeconds / 60),
        totalSeconds % 60,
    );
}

// At most two units, rounded up to the minute: "5m", "4h 30m", "2d 3h". The
// top bar pads each number to two digits, so that its label keeps its width.
function formatMinuteCountdown(totalSeconds, i18n, {padded = false} = {}) {
    const {pgettext} = i18n;
    const number = value => String(value).padStart(padded ? 2 : 1, '0');
    const totalMinutes = Math.ceil(totalSeconds / 60);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    /* Translators: a countdown until a limit resets. %1$s is days and %2$s is hours, in the top bar with two digits each; d and h abbreviate days and hours. Example: "2d 3h". */
    if (days) return pgettext('countdown', '%1$sd %2$sh').format(number(days), number(hours));
    /* Translators: a countdown until a limit resets. %1$s is hours and %2$s is minutes, in the top bar with two digits each; h and m abbreviate hours and minutes. Example: "4h 30m". */
    if (hours) return pgettext('countdown', '%1$sh %2$sm').format(number(hours), number(minutes));
    /* Translators: a countdown until a limit resets. %s is minutes, in the top bar with two digits; m abbreviates minutes. Example: "5m". */
    return pgettext('countdown', '%sm').format(number(minutes));
}

function shownPercent(remainingPercent, showUsed) {
    return showUsed && remainingPercent !== null ? 100 - remainingPercent : remainingPercent;
}

function formatPercent(percent) {
    if (percent === null) return '--%';
    const format = value =>
        new Intl.NumberFormat(undefined, {style: 'percent'}).format(value / 100);
    // Keep nearly empty and nearly full quotas from rounding to 0% or 100%.
    if (percent > 0 && percent < 1) return `<${format(1)}`;
    if (percent > 99 && percent < 100) return `>${format(99)}`;
    return format(percent);
}

// Remaining percentages stand alone; used ones say so: "14% used".
function rowPercentText(remainingPercent, {i18n, showUsed}) {
    const {gettext: _} = i18n;
    const text = formatPercent(shownPercent(remainingPercent, showUsed));
    if (!showUsed || remainingPercent === null) return text;
    /* Translators: %s is a percentage. */
    return _('%s used').format(text);
}

// "Weekly: 86% remaining" or "Weekly: 14% used".
function percentSentence(name, remainingPercent, {i18n, showUsed}) {
    const {gettext: _} = i18n;
    const text = formatPercent(shownPercent(remainingPercent, showUsed));
    /* Translators: %1$s names a limit and %2$s is a percentage. */
    if (showUsed) return _('%1$s: %2$s used').format(name, text);
    /* Translators: %1$s names a limit and %2$s is a percentage. */
    return _('%1$s: %2$s remaining').format(name, text);
}

function nameValue(name, value, i18n) {
    const {gettext: _} = i18n;
    /* Translators: %1$s names a limit and %2$s is an amount of money. */
    return _('%1$s: %2$s').format(name, value);
}
