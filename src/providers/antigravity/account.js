// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Print-mode /usage is read-only from Antigravity CLI 1.1.11:
// https://antigravity.google/docs/changelog/
export const MINIMUM_VERSION = '1.1.11';
const MINIMUM_PARTS = MINIMUM_VERSION.split('.').map(Number);

export function supportsUsageCommand(output) {
    const match = typeof output === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(output.trim()) : null;
    if (!match) return false;
    const parts = match.slice(1).map(Number);
    const index = parts.findIndex((part, position) => part !== MINIMUM_PARTS[position]);
    return index === -1 || parts[index] > MINIMUM_PARTS[index];
}

/** Maps agy login errors to an account status and its issue. */
export function loginIssue(message) {
    if (typeof message !== 'string') return null;
    if (/eligibility check failed|not eligible for Antigravity/i.test(message)) {
        return {
            status: 'unsupported',
            issue: {code: 'not-eligible', setup: null, diagnostic: null, transient: false},
        };
    }
    if (
        /not (?:signed|logged) in|please (?:sign|log) in|authentication required|login required|no (?:saved )?credentials/i.test(
            message,
        )
    ) {
        return {
            status: 'signed-out',
            // Sign-in happens in an interactive agy session.
            issue: {
                code: 'signed-out',
                params: {command: 'agy'},
                setup: 'sign-in',
                diagnostic: null,
                transient: false,
            },
        };
    }
    return null;
}
