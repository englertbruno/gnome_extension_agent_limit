// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

// Asks before a manual reset is used. It destroys itself once closed.
export const RedeemDialog = GObject.registerClass(
    class RedeemDialog extends ModalDialog.ModalDialog {
        /**
         * @param {object} params
         * @param {string|null} params.resetName The reset's name; null for the next one.
         * @param {Function} params.onConfirm Called when the user chooses Use Reset.
         */
        _init({resetName, onConfirm}) {
            super._init();
            let description = _(
                'This uses the next manual reset and resets your current usage limits. It cannot be undone.',
            );
            if (resetName !== null) {
                description = _(
                    /* Translators: %s is the name of a manual reset. */
                    'This uses “%s” and resets your current usage limits. It cannot be undone.',
                ).format(resetName);
            }
            this.contentLayout.add_child(
                new Dialog.MessageDialogContent({title: _('Use a Manual Reset?'), description}),
            );
            this.setButtons([
                {label: _('Cancel'), action: () => this.close(), key: Clutter.KEY_Escape},
                {
                    label: _('Use Reset'),
                    action: () => {
                        this.close();
                        onConfirm();
                    },
                    default: true,
                },
            ]);
        }
    },
);
