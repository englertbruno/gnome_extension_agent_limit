// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {isDateSeconds} from './formatting.js';

/**
 * Where a custom endpoint's JSON reply holds its usage, as RFC 6901 JSON
 * Pointers; '' leaves a value out. The percentage is used when set, otherwise
 * used and limit.
 *
 * @typedef {object} CustomMapping
 * @property {string} percentPointer A percentage from 0 to 100.
 * @property {'used'|'remaining'} percentMeaning
 * @property {string} usedPointer An amount used, in the limit's unit.
 * @property {string} limitPointer
 * @property {string} resetPointer An RFC 3339 time, such as
 * "2026-11-20T09:00:00Z", or Unix seconds, or Unix milliseconds.
 * @property {number} windowMinutes The window's length; 0 when unknown.
 */

const POINTER = /^(?:\/(?:[^~]|~[01])*)?$/u;
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;
// Some services quote numbers.
const DECIMAL = /^\s*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\s*$/u;
// RFC 3339 with an offset: a time without one is ambiguous.
const RFC_3339 =
    /^([0-9]{4}-[0-9]{2}-[0-9]{2})[Tt ]([0-9]{2}:[0-9]{2}(?::[0-9]{2})?)(?:[.,][0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$/u;
// Larger Unix times are milliseconds: 10^11 seconds is in the year 5138.
const MILLISECONDS_FROM = 1e11;

/** Whether text is a JSON Pointer; '' is one, which points at the whole reply. */
export function isValidPointer(text) {
    return POINTER.test(text);
}

/**
 * Reads one usage window from a custom endpoint's parsed JSON reply.
 * Percentages are clamped to 0–100. A reset that is missing or null is unknown.
 *
 * @param {unknown} response
 * @param {CustomMapping} mapping
 * @returns {{window: object}|{error: string, pointer: string}} window is the
 * UsageWindow; error is 'no-value' (neither a percentage nor both used and limit are set),
 * 'invalid-pointer', 'pointer-missing', 'not-a-number', 'limit-not-positive'
 * or 'not-a-time'; pointer is the one that failed.
 */
export function applyMapping(response, mapping) {
    const {percentPointer, percentMeaning, usedPointer, limitPointer, resetPointer, windowMinutes} =
        mapping;
    let remainingPercent;
    if (percentPointer !== '') {
        const percent = readNumber(response, percentPointer);
        if (percent.error) return percent;
        remainingPercent = percentMeaning === 'used' ? 100 - percent.value : percent.value;
    } else if (usedPointer !== '' && limitPointer !== '') {
        const used = readNumber(response, usedPointer);
        if (used.error) return used;
        const limit = readNumber(response, limitPointer);
        if (limit.error) return limit;
        if (limit.value <= 0) return {error: 'limit-not-positive', pointer: limitPointer};
        remainingPercent = 100 - (used.value / limit.value) * 100;
    } else {
        return {error: 'no-value', pointer: ''};
    }

    let resetsAt = null;
    if (resetPointer !== '') {
        const reset = readTime(response, resetPointer);
        if (reset.error) return reset;
        resetsAt = reset.value;
    }
    return {
        window: {
            id: 'quota',
            durationMinutes: windowMinutes > 0 ? windowMinutes : null,
            // Rounded to hundredths so 100 - 57 / 100 * 100 is 43, not 43.00000000000001,
            // and a 43% threshold notifies when 43% is shown.
            remainingPercent: Math.round(Math.min(100, Math.max(0, remainingPercent)) * 100) / 100,
            resetsAt,
            expiresAt: null,
        },
    };
}

// {value}, with undefined when nothing is at the pointer, or {error, pointer}.
function resolve(document, pointer) {
    if (!isValidPointer(pointer)) return {error: 'invalid-pointer', pointer};
    let value = document;
    for (const token of pointer.split('/').slice(1)) {
        const name = token.replaceAll('~1', '/').replaceAll('~0', '~');
        if (Array.isArray(value)) value = ARRAY_INDEX.test(name) ? value[Number(name)] : undefined;
        else if (value !== null && typeof value === 'object' && Object.hasOwn(value, name))
            value = value[name];
        else value = undefined;
        if (value === undefined) break;
    }
    return {value};
}

function readNumber(document, pointer) {
    const resolved = resolve(document, pointer);
    if (resolved.error) return resolved;
    if (resolved.value === undefined) return {error: 'pointer-missing', pointer};
    const number = toNumber(resolved.value);
    return number === null ? {error: 'not-a-number', pointer} : {value: number};
}

// Unix seconds, or null when the reply has no reset.
function readTime(document, pointer) {
    const resolved = resolve(document, pointer);
    if (resolved.error) return resolved;
    const {value} = resolved;
    if (value === undefined || value === null) return {value: null};
    const number = toNumber(value);
    if (number !== null && number >= 0) {
        const seconds = Math.round(number > MILLISECONDS_FROM ? number / 1000 : number);
        // A time Date cannot hold, such as a reset in nanoseconds, cannot be shown.
        return isDateSeconds(seconds) ? {value: seconds} : {error: 'not-a-time', pointer};
    }
    const match = typeof value === 'string' ? RFC_3339.exec(value) : null;
    // Date.parse() reads this form the same in every engine; others vary.
    const milliseconds = match
        ? Date.parse(`${match[1]}T${match[2]}${match[3].toUpperCase()}`)
        : NaN;
    return Number.isNaN(milliseconds)
        ? {error: 'not-a-time', pointer}
        : {value: Math.floor(milliseconds / 1000)};
}

function toNumber(value) {
    const number =
        typeof value === 'number' || (typeof value === 'string' && DECIMAL.test(value))
            ? Number(value)
            : NaN;
    // JSON.parse() turns 1e999 into Infinity.
    return Number.isFinite(number) ? number : null;
}
