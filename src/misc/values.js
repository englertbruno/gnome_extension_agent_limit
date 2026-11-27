// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function nonemptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A percentage within 0 to 100. */
export function clampPercent(percent) {
    return Math.max(0, Math.min(100, percent));
}

/** Unix seconds of an ISO 8601 time, or null. */
export function parseTime(value) {
    const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(milliseconds) && milliseconds > 0
        ? Math.floor(milliseconds / 1000)
        : null;
}
