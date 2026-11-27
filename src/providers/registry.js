// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import {AntigravityProvider} from './antigravity/provider.js';
import {DEEPSEEK} from './apiKey/deepseek.js';
import {KIMI} from './apiKey/kimi.js';
import {OLLAMA} from './apiKey/ollama.js';
import {OPENROUTER} from './apiKey/openrouter.js';
import {ApiKeyProvider} from './apiKey/provider.js';
import {ClaudeProvider} from './claude/provider.js';
import {CodexProvider} from './codex/provider.js';
import {CustomEndpointProvider} from './custom/provider.js';

// The usage services of the types that read an API key from the keyring.
const API_KEY_SERVICES = Object.freeze({
    openrouter: OPENROUTER,
    deepseek: DEEPSEEK,
    ollama: OLLAMA,
    kimi: KIMI,
});

/**
 * Creates the provider of one account; its owner destroys it. The type is one
 * of the schema's choices, which readAccountConfig() has checked.
 *
 * @param {object} account  The AccountConfig from readAccountConfig().
 * @param {object} options
 * @param {string} options.version  Client version the Codex app-server is told.
 * @param {ApiKeyReader} options.apiKeys  Reads API keys from the keyring; the providers share it and do not destroy it.
 * @param {object|null} options.savedState  The providerState that the account saved in an earlier session.
 */
export function createProvider(account, {version, apiKeys, savedState}) {
    switch (account.type) {
        case 'codex':
            return new CodexProvider({account, version, savedState});
        case 'claude':
            return new ClaudeProvider({account, savedState});
        case 'antigravity':
            // agy has a single login, which an account cannot select.
            return new AntigravityProvider();
        case 'custom':
            return new CustomEndpointProvider({account, apiKeys, savedState});
    }
    return new ApiKeyProvider({
        account,
        service: API_KEY_SERVICES[account.type],
        apiKeys,
        savedState,
    });
}
