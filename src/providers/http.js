// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {codedError} from '../misc/errors.js';
import '../misc/promisify.js';

// libsoup sends no User-Agent by default.
const USER_AGENT = 'gnome-extension-codex-limit-indicator';
// The session timeout is an idle timeout, so a body that keeps trickling in
// would never hit it; the deadline bounds the whole request.
const TIMEOUT_SECONDS = 30;
const REQUEST_DEADLINE_SECONDS = 60;
// Usage responses are a few kilobytes; a larger body is not buffered.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
// A longer Retry-After is shortened to the longest refresh interval.
const MAX_RETRY_AFTER_SECONDS = 24 * 3600;

/**
 * Returns the body, or null when it is longer than MAX_RESPONSE_BYTES. Each
 * read is copied into one buffer, so that a body sent in many small reads
 * does not keep an array per read.
 */
async function readBody(stream, cancellable) {
    let body = new Uint8Array(0);
    let length = 0;
    while (true) {
        const chunk = await stream.read_bytes_async(
            READ_CHUNK_BYTES,
            GLib.PRIORITY_DEFAULT,
            cancellable,
        );
        const size = chunk.get_size();
        if (size === 0) break;
        if (length + size > MAX_RESPONSE_BYTES) return null;
        if (length + size > body.length) {
            const larger = new Uint8Array(
                Math.min(MAX_RESPONSE_BYTES, Math.max(2 * body.length, length + size)),
            );
            larger.set(body.subarray(0, length));
            body = larger;
        }
        body.set(chunk.get_data(), length);
        length += size;
    }
    return body.subarray(0, length);
}

function isSuccess(status) {
    return status >= 200 && status < 300;
}

/** Returns the Retry-After delay in seconds, at most a day, or null when absent/invalid. */
function parseRetryAfter(value) {
    const text = value?.trim();
    if (!text) return null;
    let seconds = null;
    if (/^\d+$/.test(text)) {
        // A very long digit string parses to Infinity.
        seconds = Number(text);
    } else if (/[a-z]/i.test(text)) {
        // Otherwise Retry-After is an HTTP date, which contains letters.
        const date = Date.parse(text);
        if (Number.isFinite(date)) seconds = Math.max(0, Math.ceil((date - Date.now()) / 1000));
    }
    return seconds === null ? null : Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/** Owns HTTP connections; providers own and cancel the supplied cancellable. */
export class UsageHttpClient {
    constructor() {
        this._session = new Soup.Session({timeout: TIMEOUT_SECONDS, user_agent: USER_AGENT});
        // The only plain-HTTP endpoints are on loopback. The desktop proxy
        // resolver could send such a request, with its key, to a remote proxy.
        this._loopbackSession = new Soup.Session({
            timeout: TIMEOUT_SECONDS,
            user_agent: USER_AGENT,
            proxy_resolver: null,
        });
        // The source that ends the running request at its deadline.
        this._deadlineId = 0;
    }

    async getJson({url, headers}, cancellable) {
        const message = Soup.Message.new('GET', url);
        // A redirect would forward the Authorization header.
        message.add_flags(Soup.MessageFlags.NO_REDIRECT);
        for (const [name, value] of Object.entries(headers))
            message.get_request_headers().replace(name, value);
        // Soup lowercases the scheme, which the URL may spell in capitals.
        const session =
            message.get_uri().get_scheme() === 'http' ? this._loopbackSession : this._session;

        // Past the deadline, abort() fails the pending operation as cancelled.
        // The client has one request at a time, so it cancels only this one.
        let deadlineExpired = false;
        if (this._deadlineId) GLib.Source.remove(this._deadlineId);
        this._deadlineId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REQUEST_DEADLINE_SECONDS,
            () => {
                this._deadlineId = 0;
                deadlineExpired = true;
                session.abort();
                return GLib.SOURCE_REMOVE;
            },
        );
        let status;
        let body = null;
        try {
            const stream = await session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable);
            // get_status() maps through the Soup.Status enum, which lacks 429.
            status = message.status_code;
            try {
                // Error responses are judged by their status; the body is not read.
                if (isSuccess(status)) body = await readBody(stream, cancellable);
            } finally {
                // Close without the cancellable so cancellation cannot leak the
                // stream. Closing before the end drops the rest of the body.
                await stream.close_async(GLib.PRIORITY_DEFAULT, null);
            }
        } catch (error) {
            cancellable.set_error_if_cancelled();
            const timedOut =
                deadlineExpired ||
                (error instanceof GLib.Error &&
                    error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT));
            // Transport errors can include the request URL; report only the category.
            throw timedOut
                ? codedError('timeout', 'The service request timed out')
                : codedError('network', 'Could not connect to the service');
        } finally {
            if (this._deadlineId) GLib.Source.remove(this._deadlineId);
            this._deadlineId = 0;
        }
        cancellable.set_error_if_cancelled();
        if (!isSuccess(status)) {
            throw codedError('http-status', `The service returned HTTP ${status}`, {
                status,
                retryAfterSeconds: parseRetryAfter(
                    message.get_response_headers().get_one('Retry-After'),
                ),
            });
        }
        if (body === null)
            throw codedError('response-too-large', 'The service returned too much data');

        try {
            return JSON.parse(new TextDecoder().decode(body));
        } catch (_error) {
            // The body may contain tokens, so it is not included.
            throw codedError('invalid-json', 'The service returned invalid JSON');
        }
    }

    destroy() {
        if (this._deadlineId) GLib.Source.remove(this._deadlineId);
        this._deadlineId = 0;
        this._session.abort();
        this._session = null;
        this._loopbackSession.abort();
        this._loopbackSession = null;
    }
}
