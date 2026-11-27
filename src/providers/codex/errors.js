// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Categories for errors this extension creates.
export const ErrorKind = Object.freeze({
    EXECUTABLE_NOT_FOUND: 'executable-not-found',
    REQUEST_TIMEOUT: 'request-timeout',
    PROCESS_CLOSED: 'process-closed',
    INVALID_RESPONSE: 'invalid-response',
    INVALID_NOTIFICATION: 'invalid-notification',
});

export function createAppServerError(kind, message) {
    const error = new Error(message);
    error.kind = kind;
    return error;
}

const LOGIN_REQUIRED = Object.freeze({
    code: 'signed-out',
    summary: 'Codex login required',
    transient: false,
});
const UNAVAILABLE = Object.freeze({
    code: 'usage-unavailable',
    summary: 'Unable to refresh Codex limits',
    transient: false,
});

function temporaryFailure(code) {
    return {code, summary: UNAVAILABLE.summary, transient: true};
}

/**
 * Returns the issue code, whether earlier usage may still be shown, and the
 * English summary of the diagnostic.
 */
export function classifyError(error) {
    switch (error.kind) {
        case ErrorKind.EXECUTABLE_NOT_FOUND:
            return {code: 'cli-not-found', summary: 'Codex CLI not found', transient: false};
        case ErrorKind.REQUEST_TIMEOUT:
            return {code: 'timeout', summary: 'Codex did not respond', transient: true};
        case ErrorKind.PROCESS_CLOSED:
            return {
                code: 'process-stopped',
                summary: 'Codex process stopped unexpectedly',
                transient: false,
            };
        case ErrorKind.INVALID_RESPONSE:
            return {
                code: 'invalid-response',
                summary: 'Codex returned an invalid response',
                transient: false,
            };
        case ErrorKind.INVALID_NOTIFICATION:
            return UNAVAILABLE;
    }

    // Codex reports RPC errors as unstructured text, so classify by wording.
    const {message} = error;
    if (
        /\b401\b|\bunauthorized\b|not logged in|log(?:in|ged in) required|\bsign in\b|\bauthentication (?:required|failed)\b/i.test(
            message,
        )
    )
        return LOGIN_REQUIRED;
    // Login and permission failures are never transient, even when they mention a timeout.
    if (
        /\bauth(?:entication|orization)\b|\bunauthorized\b|login|logged in|sign in|forbidden|permission|\b40[13]\b/i.test(
            `${error.code ?? ''} ${message}`,
        )
    )
        return UNAVAILABLE;

    const status = message.match(
        /\b(?:HTTP(?:\/[\d.]+)?(?: status)?|status(?: code)?|failed)\s*[:=]?\s*(\d{3})\b/i,
    )?.[1];
    if (status === '503') return temporaryFailure('service-unavailable');
    if (status === '429') return temporaryFailure('rate-limited');
    if (status) return UNAVAILABLE;
    if (/\b503 Service Unavailable\b|\bHTTP 503\b/i.test(message))
        return temporaryFailure('service-unavailable');
    if (/\b(?:timeout|timed out)\b/i.test(message)) return temporaryFailure('timeout');
    if (
        /error sending request|connection (?:refused|reset|aborted|closed|terminated)|network (?:is )?unreachable|network is down|no route to host/i.test(
            message,
        ) ||
        /(?:dns|name) resolution|failed to lookup address/i.test(message)
    )
        return temporaryFailure('network');
    return UNAVAILABLE;
}
