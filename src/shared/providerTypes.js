// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * What every account of one provider type shares; the account's `type`
 * setting names its entry.
 *
 * @typedef {object} ProviderType
 * @property {string} id                 The account's `type` value.
 * @property {string} name               Product name; the custom type's is English, and providerTypeName() translates it.
 * @property {'cli'|'api-key'|'endpoint'} credential  How the account signs in.
 * @property {string|null} configDirectoryVariable  CLI variable that selects a login; null allows one account.
 * @property {number} minRefreshSeconds  Minimum seconds between automatic requests.
 * @property {number} defaultRefreshSeconds  Refresh interval of a new account.
 * @property {boolean} manualResets      The provider lists and redeems manual resets.
 * @property {boolean} beta              Not verified against a live account: built from documentation or from observed behaviour.
 * @property {string|null} defaultLimitId  Bucket shown until the user selects one; null shows the first.
 * @property {string|null} installUrl    Official install page of the CLI.
 * @property {string|null} keyUrl        Where to create an API key.
 * @property {string|null} usageUrl      The provider's usage page.
 * @property {string} icon               File name in icons/.
 */

/** @type {Readonly<Record<string, ProviderType>>} */
export const PROVIDER_TYPES = Object.freeze({
    codex: Object.freeze({
        id: 'codex',
        name: 'Codex',
        credential: 'cli',
        configDirectoryVariable: 'CODEX_HOME',
        minRefreshSeconds: 30,
        defaultRefreshSeconds: 30,
        manualResets: true,
        beta: false,
        defaultLimitId: 'codex',
        installUrl: 'https://learn.chatgpt.com/docs/codex/cli',
        keyUrl: null,
        usageUrl: 'https://chatgpt.com/settings/usage?tab=overview',
        icon: 'codex.svg',
    }),
    claude: Object.freeze({
        id: 'claude',
        name: 'Claude',
        credential: 'cli',
        configDirectoryVariable: 'CLAUDE_CONFIG_DIR',
        // Frequent polling of Claude's usage endpoint gets persistent HTTP 429.
        minRefreshSeconds: 300,
        defaultRefreshSeconds: 300,
        manualResets: false,
        beta: false,
        defaultLimitId: null,
        installUrl: 'https://code.claude.com/docs/en/setup',
        keyUrl: null,
        usageUrl: 'https://claude.ai/settings/usage',
        icon: 'claude.svg',
    }),
    antigravity: Object.freeze({
        id: 'antigravity',
        name: 'Antigravity',
        credential: 'cli',
        // agy keeps its login in the system keyring for every Antigravity product.
        configDirectoryVariable: null,
        minRefreshSeconds: 30,
        defaultRefreshSeconds: 30,
        manualResets: false,
        beta: false,
        defaultLimitId: null,
        installUrl: 'https://antigravity.google/docs/getting-started',
        keyUrl: null,
        usageUrl: null,
        icon: 'antigravity.svg',
    }),
    openrouter: Object.freeze({
        id: 'openrouter',
        name: 'OpenRouter',
        credential: 'api-key',
        configDirectoryVariable: null,
        minRefreshSeconds: 60,
        defaultRefreshSeconds: 300,
        manualResets: false,
        beta: true,
        defaultLimitId: null,
        installUrl: null,
        keyUrl: 'https://openrouter.ai/keys',
        usageUrl: 'https://openrouter.ai/activity',
        icon: 'openrouter.svg',
    }),
    deepseek: Object.freeze({
        id: 'deepseek',
        name: 'DeepSeek',
        credential: 'api-key',
        configDirectoryVariable: null,
        minRefreshSeconds: 60,
        defaultRefreshSeconds: 300,
        manualResets: false,
        beta: true,
        defaultLimitId: null,
        installUrl: null,
        keyUrl: 'https://platform.deepseek.com/api_keys',
        usageUrl: null,
        // DeepSeek's terms forbid using its logo without permission.
        icon: 'agent.svg',
    }),
    ollama: Object.freeze({
        id: 'ollama',
        name: 'Ollama Cloud',
        credential: 'api-key',
        configDirectoryVariable: null,
        // Ollama allows 10 requests a minute, shared across devices.
        minRefreshSeconds: 60,
        defaultRefreshSeconds: 300,
        manualResets: false,
        beta: true,
        defaultLimitId: null,
        installUrl: null,
        keyUrl: 'https://ollama.com/settings/keys',
        usageUrl: 'https://ollama.com/settings',
        icon: 'ollama.svg',
    }),
    kimi: Object.freeze({
        id: 'kimi',
        name: 'Kimi Code',
        credential: 'api-key',
        configDirectoryVariable: null,
        minRefreshSeconds: 60,
        defaultRefreshSeconds: 300,
        manualResets: false,
        beta: true,
        defaultLimitId: null,
        installUrl: null,
        keyUrl: 'https://www.kimi.com/code/console',
        usageUrl: 'https://www.kimi.com/code/console',
        // Kimi licenses its logo only for editorial, media and non-commercial promotional use.
        icon: 'agent.svg',
    }),
    custom: Object.freeze({
        id: 'custom',
        name: 'Custom endpoint',
        credential: 'endpoint',
        configDirectoryVariable: null,
        minRefreshSeconds: 60,
        defaultRefreshSeconds: 300,
        manualResets: false,
        beta: false,
        defaultLimitId: null,
        installUrl: null,
        keyUrl: null,
        // Each custom account sets its own usage page.
        usageUrl: null,
        icon: 'agent.svg',
    }),
});

/** Provider type IDs in the order preferences list them. */
export const PROVIDER_TYPE_IDS = Object.freeze(Object.keys(PROVIDER_TYPES));

/**
 * The name users see: a product name as it is, the custom type's translated.
 *
 * @param {ProviderType} type
 * @param {(text: string) => string} _ The caller's gettext.
 * @returns {string}
 */
export function providerTypeName(type, _) {
    return type.id === 'custom' ? _('Custom endpoint') : type.name;
}
