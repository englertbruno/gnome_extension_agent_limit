// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// What the settings of a custom endpoint may hold. Preferences refuse to save
// other values.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// An RFC 9110 field name. libsoup drops other names with a warning.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
// libsoup refuses line breaks in a header value and cuts it at NUL.
const CONTROL_CHARACTER = /\p{Cc}/u;
// GLib.Uri converts international names to ASCII; libsoup rejects names with
// other characters, such as spaces.
const HOST_NAME = /^[0-9A-Za-z_.-]+$/u;
// What a URL without a port connects to.
const DEFAULT_PORTS = {http: 80, https: 443};

/** Whether `name` can name the header that carries the endpoint's key. */
export function isValidHeaderName(name) {
    // `headers['__proto__'] = value` sets no header, so the key would not be sent.
    return HEADER_NAME.test(name) && name !== '__proto__';
}

/** Whether `text` can be sent in a header value, before the key. */
export function isValidHeaderPrefix(text) {
    return !CONTROL_CHARACTER.test(text);
}

// The scheme, host and effective port of an absolute URL, or null.
function parseUrl(url) {
    let uri;
    try {
        uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch {
        return null;
    }
    const host = uri.get_host();
    if (!host || !(GLib.hostname_is_ip_address(host) || HOST_NAME.test(host))) return null;
    const scheme = uri.get_scheme();
    const port = uri.get_port() === -1 ? DEFAULT_PORTS[scheme] : uri.get_port();
    return {scheme, host, port};
}

function isLoopback(host) {
    if (host.toLowerCase() === 'localhost') return true;
    const address = Gio.InetAddress.new_from_string(host);
    return address !== null && address.get_is_loopback();
}

/**
 * Whether usage may be requested from `url`: https, or http to this computer,
 * where neither the key nor the usage crosses the network.
 */
export function isAllowedEndpointUrl(url) {
    const parsed = parseUrl(url);
    if (parsed === null) return false;
    return parsed.scheme === 'https' || (parsed.scheme === 'http' && isLoopback(parsed.host));
}

/** The host of `url`, which identifies a custom endpoint; '' when the URL is not valid. */
export function endpointHost(url) {
    return parseUrl(url)?.host ?? '';
}

/**
 * The scheme, host and port of `url`, such as 'https://example.test:443', which
 * identify the service that a custom endpoint's key belongs to; '' when the
 * URL is not valid or has no known default port.
 */
export function endpointOrigin(url) {
    const parsed = parseUrl(url);
    if (parsed === null || parsed.port === undefined) return '';
    return `${parsed.scheme}://${parsed.host.toLowerCase()}:${parsed.port}`;
}

/** Whether `url` is an https page, such as the endpoint's usage page. */
export function isHttpsUrl(url) {
    return parseUrl(url)?.scheme === 'https';
}
