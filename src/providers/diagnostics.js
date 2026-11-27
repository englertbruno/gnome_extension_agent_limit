// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

const MAX_TEXT_LENGTH = 1600;
const MAX_INPUT_LENGTH = 16384;

function sanitizeDiagnosticText(value, maximumLength = MAX_TEXT_LENGTH, {tail = false} = {}) {
    if (typeof value !== 'string') return '';

    // Bound the text and redact credentials before it is displayed or logged.
    const text = (tail ? value.slice(-MAX_INPUT_LENGTH) : value.slice(0, MAX_INPUT_LENGTH))
        // Terminal escape sequences, then other control and bidirectional
        // characters; tabs and line breaks stay.
        .replace(/\p{Cc}\[[0-?]*[ -/]*[@-~]/gu, '')
        .replace(/(?![\t\n])\p{Cc}|[\u202a-\u202e\u2066-\u2069]/gu, '')
        .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[redacted authorization]')
        .replace(/\b(?:sk-[a-zA-Z0-9_-]+|AIza[a-zA-Z0-9_-]{20,})\b/g, '[redacted key]')
        .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]*)?/g, '[redacted token]')
        .replace(/\b(authorization|cookie|set-cookie)\s*:[^\n]*/gi, '$1: [redacted]')
        .replace(
            /(["']?(?:api[-_]?key|(?:access|refresh|id)[-_]?token|token|password|secret|authorization|(?:set-)?cookie)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&,;}]+)/gi,
            '$1[redacted]',
        )
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
        .replace(
            /(?<![a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-])[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
            '[redacted email]',
        )
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (text.length <= maximumLength && value.length <= MAX_INPUT_LENGTH) return text;
    return tail
        ? `[truncated]\n${text.slice(-maximumLength)}`
        : `${text.slice(0, maximumLength)}\n[truncated]`;
}

export function createDiagnostic({providerName, operation, error, summary}) {
    const lines = [
        `Provider: ${sanitizeDiagnosticText(providerName, 100)}`,
        `Operation: ${sanitizeDiagnosticText(operation, 150)}`,
    ];
    if (typeof error.method === 'string')
        lines.push(`Request: ${sanitizeDiagnosticText(error.method, 150)}`);
    if (typeof error.code === 'string' || typeof error.code === 'number')
        lines.push(`Code: ${sanitizeDiagnosticText(String(error.code), 100)}`);
    // The journal gets the lines above; the message and process output can
    // hold paths, account or workspace IDs and URLs, so only the menu shows them.
    const logLines = [...lines];
    lines.push(
        `Message: ${sanitizeDiagnosticText(error.message) || 'No error message was provided.'}`,
    );
    const sanitizedSummary = sanitizeDiagnosticText(summary, 200);
    // The message and process output vary between attempts of the same failure
    // (request IDs, timestamps), so the key holds the logged lines only.
    const key = [sanitizedSummary, ...logLines].join('\n');
    const stderr = sanitizeDiagnosticText(error.stderr, MAX_TEXT_LENGTH, {tail: true});
    if (stderr) lines.push(`Recent process output:\n${stderr}`);
    return {
        summary: sanitizedSummary,
        details: lines.join('\n'),
        logText: [sanitizedSummary, ...logLines].join('\n'),
        key,
    };
}

/** Logs each failure once, until a refresh succeeds. */
export class DiagnosticReporter {
    constructor() {
        // Keys logged since the last success, so that failures alternating
        // during an outage are not logged on every poll.
        this._loggedKeys = new Set();
    }

    recovered() {
        this._loggedKeys.clear();
    }

    /**
     * @param {{summary: string, details: string, logText: string, key: string}} diagnostic
     *     logText holds the summary, provider, operation, request and code only.
     */
    update(diagnostic) {
        if (this._loggedKeys.has(diagnostic.key)) return;
        this._loggedKeys.add(diagnostic.key);
        console.warn(`[Agent Usage Indicator] ${diagnostic.logText}`);
    }
}
