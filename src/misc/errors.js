// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

/** An error with a stable code and a fixed message that is safe to show and log. */
export function codedError(code, message, details = {}) {
    return Object.assign(new Error(message), {code, ...details});
}
