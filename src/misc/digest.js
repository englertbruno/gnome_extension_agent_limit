// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

/** Hex SHA-256 digest, for keys that must not hold account data or tokens. */
export function sha256(text) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
}
