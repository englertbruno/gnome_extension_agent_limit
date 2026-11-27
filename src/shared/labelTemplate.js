// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

/** Placeholders of the panel label template; never translated. */
export const LABEL_PLACEHOLDERS = Object.freeze([
    'percent',
    'remaining',
    'used',
    'reset',
    'reset_time',
    'window',
    'account',
]);

/** Characters of a template that are used; the rest is ignored. */
export const LABEL_MAX_LENGTH = 100;

// Escaped braces, a placeholder, other text, or a single brace.
const TOKEN = /\{\{|\}\}|\{([^{}]+)\}|[^{}]+|[{}]/gu;
// Text of only spaces, punctuation and symbols, such as ' · ' or ' (', which
// only separates the values around it.
const SEPARATOR = /^[\s\p{P}\p{S}]+$/u;
const OPENING_BRACKET = /[([{<]\s*$/u;
const CLOSING_BRACKETS = /^[)\]}>]+/u;

/**
 * A parsed template is a list of parts: literal text, never empty, and
 * placeholders, which are LABEL_PLACEHOLDERS entries.
 *
 * @typedef {{type: 'text', text: string}|{type: 'placeholder', name: string}} LabelPart
 */

/**
 * Parses a panel label template such as "{percent} · {reset}". "{{" and "}}"
 * are literal braces. An unknown placeholder stays literal text and is listed,
 * once, in unknown.
 *
 * @param {string} template
 * @returns {{parts: LabelPart[], unknown: string[]}}
 */
export function parseLabelTemplate(template) {
    const text = Array.from(template).slice(0, LABEL_MAX_LENGTH).join('');
    const parts = [];
    const unknown = [];
    let literal = '';
    for (const [token, name] of text.matchAll(TOKEN)) {
        if (name !== undefined && LABEL_PLACEHOLDERS.includes(name)) {
            if (literal !== '') parts.push({type: 'text', text: literal});
            literal = '';
            parts.push({type: 'placeholder', name});
            continue;
        }
        if (name !== undefined && !unknown.includes(name)) unknown.push(name);
        literal += token === '{{' || token === '}}' ? token[0] : token;
    }
    if (literal !== '') parts.push({type: 'text', text: literal});
    return {parts, unknown};
}

/**
 * Renders parsed parts. A placeholder whose value is empty is left out with
 * the separators next to it; where it stood between two shown parts, the
 * first of those separators stays, unless it opens a bracket. So "{percent} · {reset}" renders "86%"
 * without a reset, "{percent} · {reset} · {window}" "86% · Weekly" and
 * "{percent} ({reset}) · {window}" "86% · Weekly".
 *
 * @param {LabelPart[]} parts
 * @param {Object<string, string>} values A string for every placeholder; ''
 * when its value is unavailable.
 * @returns {string} Without surrounding spaces; '' hides the label.
 */
export function renderLabel(parts, values) {
    const isEmpty = index =>
        parts[index]?.type === 'placeholder' && values[parts[index].name] === '';
    let label = '';
    // The first separator next to an empty value since the last shown part.
    let separator = null;
    for (const [index, part] of parts.entries()) {
        if (isEmpty(index)) continue;
        const text = part.type === 'placeholder' ? values[part.name] : part.text;
        if (
            part.type === 'text' &&
            SEPARATOR.test(text) &&
            (isEmpty(index - 1) || isEmpty(index + 1))
        ) {
            // A kept separator that opens a bracket would stay unmatched, as the
            // closing one is left out with the value; the next one replaces it,
            // without the brackets it closes.
            if (separator === null) separator = text;
            else if (OPENING_BRACKET.test(separator))
                separator = text.replace(CLOSING_BRACKETS, '');
            continue;
        }
        if (label !== '' && separator !== null) label += separator;
        label += text;
        separator = null;
    }
    return label.trim();
}
