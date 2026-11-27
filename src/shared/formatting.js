// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

const DAY_MILLISECONDS = 86400 * 1000;

/** Whether Date can hold the time, which is the range formatClockTime() can show. */
export function isDateSeconds(unixSeconds) {
    return !Number.isNaN(new Date(unixSeconds * 1000).getTime());
}

/**
 * Formats a time compactly in the locale's style: "09:00" today, "Thu 09:00"
 * within the next six days and the date alone, "26 Nov", a week or more ahead,
 * when the weekday would be ambiguous.
 *
 * @param {number} unixSeconds
 * @param {number} nowSeconds Wall-clock time that decides which day is today.
 * @param {string} clockFormat The '24h' or '12h' value of the desktop's
 * clock-format setting.
 * @returns {string} Empty when the time is outside the range of Date.
 */
export function formatClockTime(unixSeconds, nowSeconds, clockFormat) {
    const date = new Date(unixSeconds * 1000);
    // Outside the Date range, Intl throws; a time that cannot be shown is left out.
    if (Number.isNaN(date.getTime())) return '';
    const days = calendarDaysBetween(new Date(nowSeconds * 1000), date);
    if (days >= 7)
        return new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short'}).format(date);
    const options = {
        hour: 'numeric',
        minute: '2-digit',
        hourCycle: clockFormat === '24h' ? 'h23' : 'h12',
    };
    if (days !== 0) options.weekday = 'short';
    return new Intl.DateTimeFormat(undefined, options).format(date);
}

// Counts local calendar days, which are not always 24 hours long.
function calendarDaysBetween(from, to) {
    const day = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return (day(to) - day(from)) / DAY_MILLISECONDS;
}

/**
 * Formats an amount of money in the locale's style: "$12.40".
 *
 * @param {number} amount In major units, such as dollars.
 * @param {string} currency An ISO 4217 code; a malformed one throws RangeError.
 * @returns {string}
 */
export function formatMoney(amount, currency) {
    // A tiny negative balance that rounds to zero shows as $0.00, not -$0.00.
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        signDisplay: 'negative',
    }).format(amount);
}
