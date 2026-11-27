// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {codedError} from '../../misc/errors.js';
import '../../misc/promisify.js';
import {PROVIDER_TYPES} from '../../shared/providerTypes.js';
import {CommandOutput} from '../commandOutput.js';
import {createDiagnostic} from '../diagnostics.js';
import {createExecutableLauncher, findExecutable} from '../executable.js';
import {createUsageResult} from '../usageResult.js';
import {MINIMUM_VERSION, loginIssue, supportsUsageCommand} from './account.js';
import {isQuotaResponse, normalizeQuota} from './quota.js';

// Issue codes for the coded errors of a failed refresh; any other failure
// makes usage unavailable.
const FAILURE_ISSUE_CODES = Object.freeze({
    timeout: 'timeout',
    'invalid-response': 'invalid-response',
    'output-too-large': 'invalid-response',
});

function invalidResponse() {
    return codedError('invalid-response', 'Antigravity CLI returned an invalid usage response.');
}

export class AntigravityProvider {
    constructor({executableSearch = {}} = {}) {
        this._executableSearch = executableSearch;
        this._cancellable = new Gio.Cancellable();
        this._command = null;
        // The agy file whose version supports /usage, as "path modification-time";
        // another path, or the same path after a change, is checked again.
        this._supportedExecutable = null;
    }

    async refresh() {
        const cancellable = this._cancellable;
        // The usage report names no account or plan.
        const result = createUsageResult({
            providerType: 'antigravity',
            account: {status: 'unavailable', identity: null, plan: null},
        });
        let operation = 'Find Antigravity CLI';
        try {
            // The user's installed Antigravity CLI.
            const executable = await findExecutable('agy', cancellable, this._executableSearch);
            cancellable.set_error_if_cancelled();
            if (!executable) {
                result.issue = {
                    code: 'cli-not-found',
                    setup: 'install',
                    diagnostic: null,
                    transient: false,
                };
                return result;
            }
            // stdin is /dev/null, so the CLI cannot prompt; stderr may contain
            // account data.
            const launcher = createExecutableLauncher(
                executable,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            );

            const info = await Gio.File.new_for_path(executable).query_info_async(
                'time::modified,time::modified-usec',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable,
            );
            cancellable.set_error_if_cancelled();
            const executableIdentity = `${executable} ${info.get_attribute_uint64('time::modified')}.${info.get_attribute_uint32('time::modified-usec')}`;

            if (executableIdentity !== this._supportedExecutable) {
                operation = 'Check Antigravity CLI version';
                const version = await this._collect(launcher.spawnv([executable, '--version']));
                cancellable.set_error_if_cancelled();
                // A failed run says nothing about the version, so it is a failure.
                if (!version.success)
                    throw codedError(
                        'command-failed',
                        'Antigravity CLI could not report its version.',
                    );
                if (!supportsUsageCommand(version.output)) {
                    result.account.status = 'unsupported';
                    result.issue = {
                        code: 'cli-update-required',
                        params: {version: MINIMUM_VERSION},
                        setup: 'update',
                        diagnostic: null,
                        transient: false,
                    };
                    return result;
                }
                this._supportedExecutable = executableIdentity;
            }
            operation = 'Read Antigravity CLI usage';
            // The built-in /usage command reports quotas without running an agent turn.
            const response = await this._collect(
                launcher.spawnv([
                    executable,
                    '-p',
                    '/usage',
                    '--output-format',
                    'json',
                    '--print-timeout',
                    '20s',
                ]),
            );
            cancellable.set_error_if_cancelled();
            operation = 'Interpret Antigravity CLI usage';
            let envelope;
            try {
                envelope = JSON.parse(response.output);
            } catch {
                // Parser errors can quote the response, so use a fixed message.
                throw invalidResponse();
            }
            if (envelope?.status === 'ERROR') {
                const login = loginIssue(envelope.error);
                if (login) {
                    result.account.status = login.status;
                    result.issue = login.issue;
                    return result;
                }
                throw codedError(
                    'cli-error',
                    'Antigravity CLI could not read usage. Open the CLI for details.',
                );
            }
            // The quota report is in command.data; the envelope's token usage is unrelated.
            if (
                !response.success ||
                envelope?.status !== 'SUCCESS' ||
                envelope.command?.name !== 'usage' ||
                !isQuotaResponse(envelope.command.data)
            )
                throw invalidResponse();
            result.buckets = normalizeQuota(envelope.command.data);
            result.account.status = 'ready';
            if (result.buckets.length === 0)
                result.issue = {code: 'no-quotas', setup: null, diagnostic: null, transient: false};
            return result;
        } catch (error) {
            cancellable.set_error_if_cancelled();
            // Spawn and file errors can contain paths; report fixed text instead.
            let reported = error;
            if (error instanceof GLib.Error) {
                reported =
                    error.domain === GLib.spawn_error_quark()
                        ? codedError('command-failed', 'Unable to run Antigravity CLI.')
                        : codedError('lookup-failed', 'Unable to read Antigravity CLI usage.');
            }
            const code = FAILURE_ISSUE_CODES[reported.code] ?? 'usage-unavailable';
            result.issue = {
                code,
                setup: null,
                diagnostic: createDiagnostic({
                    providerName: PROVIDER_TYPES.antigravity.name,
                    operation,
                    error: reported,
                    summary: 'Antigravity usage is unavailable',
                }),
                transient: code === 'timeout',
            };
            return result;
        }
    }

    async _collect(process) {
        const command = new CommandOutput(process, 'Antigravity CLI');
        this._command = command;
        try {
            return await command.collect();
        } finally {
            // Unless the provider's destroy() already released it.
            if (this._command === command) {
                command.destroy();
                this._command = null;
            }
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
        if (this._command) this._command.destroy();
        this._command = null;
    }
}
