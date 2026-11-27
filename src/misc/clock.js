// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

/** The wall-clock time in seconds, the clock that saved times use. */
export function wallSeconds() {
    return GLib.get_real_time() / GLib.USEC_PER_SEC;
}
