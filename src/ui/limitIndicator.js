// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import '../misc/promisify.js';
import {endpointHost, isHttpsUrl} from '../shared/endpointRules.js';
import {normalizeCustomColors, SettingsKey} from '../shared/settings.js';
import {HistoryChartItem} from './historyChart.js';
import {IndicatorIcon} from './indicatorIcon.js';
import {LimitOptionItem} from './limitOptionItem.js';
import {RedeemDialog} from './redeemDialog.js';

// A menu section whose actor is a scroll view around its box, as PopupSubMenu's
// is; PopupMenuBase destroys the actor and lays it out in the menu.
class ScrolledMenuSection extends PopupMenu.PopupMenuSection {
    constructor() {
        super();
        this.actor = new St.ScrollView({
            style_class: 'codex-limit-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            clip_to_allocation: true,
            child: this.box,
        });
        this.actor._delegate = this;
    }
}

export const LimitIndicator = GObject.registerClass(
    class LimitIndicator extends PanelMenu.Button {
        _init({
            settings,
            iconFile,
            onSelectLimit,
            onOpenPreferences,
            onRefresh,
            onRedeemReset,
            title,
        }) {
            super._init(0.0, title);

            this.add_style_class_name('codex-limit-indicator');

            this._settings = settings;
            this._onSelectLimit = onSelectLimit;
            this._onRedeemReset = onRedeemReset;
            this._limitItems = new Map();
            this._detailItems = [];
            // The rows of the resets submenu, each {item, reset}: reset is the
            // presentation's item it shows, or null for the next reset.
            this._resetRows = new Map();
            // The open confirmation, until it destroys itself.
            this._redeemDialog = null;
            // The account generation of the presentation the menu was last built from.
            this._accountGeneration = null;
            this._remainingPercent = null;
            this._panelText = '';
            // The shown setup and usage page, which their items open.
            this._setup = null;
            this._usagePageUrl = null;
            // Cancels opening a page when the indicator is destroyed.
            this._cancellable = new Gio.Cancellable();

            this.menu.actor.add_style_class_name('codex-limit-indicator-menu');

            this._box = new St.BoxLayout({
                style_class: 'panel-status-indicators-box power-status',
            });
            this.add_child(this._box);

            this._indicatorIcon = new IndicatorIcon(iconFile);
            this._box.add_child(this._indicatorIcon);

            this._label = new St.Label({
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._label.get_clutter_text().ellipsize = Pango.EllipsizeMode.NONE;
            this._box.add_child(this._label);

            this._stale = false;
            this._staleMarker = new St.Icon({
                icon_name: 'dialog-warning-symbolic',
                style_class: 'system-status-icon',
                accessible_name: _('Usage is stale'),
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            this._box.add_child(this._staleMarker);

            // update() fills in the texts before the indicator is shown. The
            // heading shows the provider's logo, names the account and ends in
            // Refresh, which the spinner replaces while a request runs.
            this._headingItem = new PopupMenu.PopupSeparatorMenuItem('');
            this._headingItem.add_style_class_name('codex-heading');
            // The button makes the heading taller than its text.
            this._headingItem.label.y_align = Clutter.ActorAlign.CENTER;
            this._headingItem.insert_child_below(
                new St.Icon({
                    gicon: new Gio.FileIcon({file: iconFile}),
                    style_class: 'popup-menu-icon',
                }),
                this._headingItem.label,
            );
            this._refreshButton = new St.Button({
                style_class: 'icon-button codex-refresh-button',
                icon_name: 'view-refresh-symbolic',
                accessible_name: _('Refresh'),
                can_focus: true,
            });
            this._refreshButton.connectObject('clicked', onRefresh, this);
            this._headingItem.add_child(this._refreshButton);
            this._refreshSpinner = new Spinner(16, {hideOnStop: true});
            this._refreshSpinner.add_style_class_name('codex-refresh-spinner');
            this._headingItem.add_child(this._refreshSpinner);
            this.menu.addMenuItem(this._headingItem);
            this._accountItem = this._addInformationItem(this.menu, 'codex-account');
            // The account's facts, such as its credits.
            this._detailSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._detailSection);

            this._statusItem = this._addInformationItem(this.menu, 'codex-status');
            this._statusItem.insert_child_below(
                new St.Icon({
                    icon_name: 'dialog-warning-symbolic',
                    style_class: 'popup-menu-icon',
                    y_align: Clutter.ActorAlign.START,
                }),
                this._statusItem.label,
            );
            // A stale reading's age is its second line.
            const statusText = this._statusItem.label.get_clutter_text();
            statusText.ellipsize = Pango.EllipsizeMode.NONE;
            statusText.line_wrap = true;
            this._statusItem.hide();

            this._setupItem = new PopupMenu.PopupMenuItem('');
            this._setupItem.connectObject(
                'activate',
                () => {
                    if (this._setup.settings) onOpenPreferences();
                    else this._openUrl(this._setup.url);
                },
                this,
            );
            this.menu.addMenuItem(this._setupItem);
            this._setupItem.hide();

            // The limits and the chart scroll when the menu is taller than the
            // work area (the panel button caps its height), so that Settings
            // below stays on screen.
            this._scrolledSection = new ScrolledMenuSection();
            this.menu.addMenuItem(this._scrolledSection);
            this._limitSection = new PopupMenu.PopupMenuSection();
            this._scrolledSection.addMenuItem(this._limitSection);
            // The chart's title, in the grey Shell gives a row that is not
            // reactive.
            this._historyTitleItem = new PopupMenu.PopupMenuItem(_('Use in the Last Seven Days'), {
                reactive: false,
                can_focus: false,
            });
            this._historyTitleItem.add_style_class_name('codex-history-title');
            this._scrolledSection.addMenuItem(this._historyTitleItem);
            this._historyTitleItem.hide();
            this._historyItem = new HistoryChartItem();
            this._scrolledSection.addMenuItem(this._historyItem);
            this._historyItem.hide();

            this._resetsItem = new PopupMenu.PopupSubMenuMenuItem('');
            this.menu.addMenuItem(this._resetsItem);
            this._resetsItem.hide();

            this._errorDetailsItem = new PopupMenu.PopupSubMenuMenuItem(_('Error Details'));
            const errorDetails = this._addInformationItem(
                this._errorDetailsItem.menu,
                'codex-information',
            );
            this._errorDetailsLabel = errorDetails.label;
            this._errorDetailsLabel.add_style_class_name('codex-error-details');
            const errorText = this._errorDetailsLabel.get_clutter_text();
            errorText.ellipsize = Pango.EllipsizeMode.NONE;
            errorText.line_wrap = true;
            errorText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            this.menu.addMenuItem(this._errorDetailsItem);
            this._errorDetailsItem.hide();

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._usagePageItem = new PopupMenu.PopupMenuItem(_('Usage Page'));
            this._usagePageItem.connectObject(
                'activate',
                () => this._openUrl(this._usagePageUrl),
                this,
            );
            this.menu.addMenuItem(this._usagePageItem);
            this._usagePageItem.hide();

            this._settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
            this._settingsItem.connectObject('activate', onOpenPreferences, this);
            this.menu.addMenuItem(this._settingsItem);

            // The age of the reading, in the grey Shell gives a row that is
            // not reactive.
            this._lastUpdatedItem = new PopupMenu.PopupMenuItem('', {
                reactive: false,
                can_focus: false,
            });
            this._lastUpdatedItem.add_style_class_name('codex-information');
            this.menu.addMenuItem(this._lastUpdatedItem);
            this._lastUpdatedItem.hide();

            for (const key of [
                SettingsKey.SHOW_LOGO,
                SettingsKey.SHOW_BAR,
                SettingsKey.SHOW_DOTS,
                SettingsKey.BAR_POSITION,
                SettingsKey.INDICATOR_SIZE,
                SettingsKey.COLOR_SCHEME,
                SettingsKey.CUSTOM_COLORS,
            ]) {
                this._settings.connectObject(`changed::${key}`, () => this._syncAppearance(), this);
            }

            this._syncAppearance();
        }

        destroy() {
            this._cancellable.cancel();
            this._settings.disconnectObject(this);
            if (this._redeemDialog) this._redeemDialog.destroy();

            this._cancellable = null;
            this._settings = null;
            this._limitItems = null;
            this._detailItems = null;
            this._resetRows = null;
            this._redeemDialog = null;
            this._onRedeemReset = null;
            this._accountGeneration = null;
            this._setup = null;
            this._box = null;
            this._indicatorIcon = null;
            this._label = null;
            this._staleMarker = null;
            this._statusItem = null;
            this._setupItem = null;
            this._resetsItem = null;
            this._errorDetailsItem = null;
            this._errorDetailsLabel = null;
            this._settingsItem = null;
            this._onSelectLimit = null;
            this._headingItem = null;
            this._refreshButton = null;
            this._refreshSpinner = null;
            this._accountItem = null;
            this._usagePageItem = null;
            this._scrolledSection = null;
            this._limitSection = null;
            this._detailSection = null;
            this._historyTitleItem = null;
            this._historyItem = null;
            this._lastUpdatedItem = null;

            super.destroy();
        }

        /** @param {object} presentation From accounts/presentation.js. */
        update({
            title,
            accountText,
            panelText,
            remainingPercent,
            options,
            details,
            resets,
            accountGeneration,
            history,
            statusText,
            lastUpdatedText,
            setup,
            diagnosticDetails,
            usagePageUrl,
            accessibleName,
            stale,
            refreshing,
        }) {
            // A dialog built from a reading that may be another login's must not
            // redeem a reset for this one.
            if (accountGeneration !== this._accountGeneration && this._redeemDialog)
                this._redeemDialog.destroy();
            this._accountGeneration = accountGeneration;
            this._stale = stale;
            this._remainingPercent = remainingPercent;
            this._panelText = panelText;
            this._headingItem.label.text = title;
            if (refreshing !== this._refreshSpinner.visible) {
                // Hiding the focused button would leave the focus outside the menu.
                if (this._refreshButton.has_key_focus()) this.menu.actor.grab_key_focus();
                this._refreshButton.visible = !refreshing;
                if (refreshing) this._refreshSpinner.play();
                else this._refreshSpinner.stop();
            }
            this._accountItem.label.text = accountText ?? '';
            this._accountItem.visible = accountText !== null;
            this._syncLimitItems(options);
            for (const option of options)
                this._limitItems.get(option.key).update(option, options.length > 1);
            this._syncInformationItems(this._detailItems, this._detailSection, details);

            const resetRows = [...(resets?.items ?? [])];
            if (resets?.canRedeemNext) resetRows.push(null);
            if (resetRows.length === 0) this._resetsItem.setSubmenuShown(false);
            this._resetsItem.label.text = resets?.summary ?? '';
            this._resetsItem.visible = resetRows.length > 0;
            this._syncResetRows(resetRows);
            if (history !== null) this._historyItem.update(history);
            this._historyTitleItem.visible = history !== null;
            this._historyItem.visible = history !== null;

            this._statusItem.label.text = statusText ?? '';
            this._statusItem.visible = statusText !== null;
            this._lastUpdatedItem.label.text = lastUpdatedText ?? '';
            this._lastUpdatedItem.visible = lastUpdatedText !== null;
            this._setup = setup;
            this._setupItem.label.text = setup?.text ?? '';
            this._setupItem.visible = setup !== null;
            if (diagnosticDetails === null) this._errorDetailsItem.setSubmenuShown(false);
            this._errorDetailsLabel.text = diagnosticDetails ?? '';
            this._errorDetailsItem.visible = diagnosticDetails !== null;
            // A custom account's usage page comes from a setting; open only https.
            this._usagePageUrl = usagePageUrl;
            this._usagePageItem.visible = usagePageUrl !== null && isHttpsUrl(usagePageUrl);
            this.accessible_name = accessibleName;
            this._syncAppearance();
        }

        // A row of text that is neither an action nor insensitive, so that it
        // keeps the normal text colour; the pointer does not highlight it.
        _addInformationItem(menu, styleClass) {
            const item = new PopupMenu.PopupMenuItem('', {activate: false, can_focus: false});
            item.track_hover = false;
            item.add_style_class_name(styleClass);
            menu.addMenuItem(item);
            return item;
        }

        // Shows texts in the information items of a menu, reusing the items
        // it already has.
        _syncInformationItems(items, menu, texts) {
            while (items.length > texts.length) items.pop().destroy();
            while (items.length < texts.length)
                items.push(this._addInformationItem(menu, 'codex-information'));
            for (const [index, item] of items.entries()) item.label.text = texts[index];
        }

        // Shows a row per reset. A row belongs to its credit id (null for the
        // next reset) and moves with it, so that a poll while the menu is open
        // never makes a focused row activate another credit.
        _syncResetRows(resets) {
            const ids = resets.map(reset => (reset === null ? null : reset.id));
            for (const [id, row] of this._resetRows) {
                if (ids.includes(id)) continue;
                row.item.destroy();
                this._resetRows.delete(id);
            }
            for (const [index, reset] of resets.entries()) {
                const id = ids[index];
                let row = this._resetRows.get(id);
                if (!row) {
                    row = {item: new PopupMenu.PopupMenuItem(''), reset};
                    this._resetsItem.menu.addMenuItem(row.item);
                    // After the menu's own handler, which closes the menu, so that
                    // the dialog takes the grab last.
                    row.item.connectObject('activate', () => this._confirmRedeem(row.reset), this);
                    this._resetRows.set(id, row);
                }
                this._resetsItem.menu.moveMenuItem(row.item, index);
                row.reset = reset;
                if (reset === null) row.item.label.text = _('Manual Reset…');
                else if (reset.expiryText === '') row.item.label.text = reset.text;
                else
                    /* Translators: a manual reset in the menu: its name and its expiry, such as “Gift · Expires in 3d 5h”. */
                    row.item.label.text = _('%1$s · %2$s').format(reset.text, reset.expiryText);
            }
        }

        // Asks before the reset, or the next one when null, is used.
        _confirmRedeem(reset) {
            // A dialog still fading out after its answer goes at once.
            if (this._redeemDialog) this._redeemDialog.destroy();
            const creditId = reset === null ? null : reset.id;
            const accountGeneration = this._accountGeneration;
            this._redeemDialog = new RedeemDialog({
                resetName: reset === null ? null : reset.text,
                onConfirm: () => this._onRedeemReset(creditId, accountGeneration),
            });
            this._redeemDialog.connectObject(
                'destroy',
                () => {
                    this._redeemDialog = null;
                },
                this,
            );
            if (!this._redeemDialog.open()) this._redeemDialog.destroy();
        }

        async _openUrl(url) {
            try {
                await Gio.AppInfo.launch_default_for_uri_async(
                    url,
                    global.create_app_launch_context(0, -1),
                    this._cancellable,
                );
            } catch (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(this._launchFailureText(url, error));
            }
        }

        // Names neither the URL nor the error's text, which can repeat it: a
        // custom page's path or query can hold a token.
        _launchFailureText(url, error) {
            return `Failed to open a page of ${endpointHost(url)}: error code ${error.code}`;
        }

        // Keeps the rows of options that persist, so that a focused row keeps its
        // key focus, and adds or removes the others.
        _syncLimitItems(options) {
            const keys = new Set(options.map(option => option.key));
            for (const [key, item] of this._limitItems) {
                if (keys.has(key)) continue;
                // A destroyed focused row would leave the focus on the stage.
                if (item.active) this.menu.actor.grab_key_focus();
                item.destroy();
                this._limitItems.delete(key);
            }
            for (const [index, option] of options.entries()) {
                let item = this._limitItems.get(option.key);
                if (item === undefined) {
                    item = new LimitOptionItem();
                    item.connectObject('activate', () => this._onSelectLimit(item.option), this);
                    this._limitSection.addMenuItem(item, index);
                    this._limitItems.set(option.key, item);
                } else {
                    this._limitSection.moveMenuItem(item, index);
                }
            }
        }

        _syncAppearance() {
            const colorScheme = this._settings.get_uint(SettingsKey.COLOR_SCHEME);
            const customColors = normalizeCustomColors(
                this._settings.get_strv(SettingsKey.CUSTOM_COLORS),
            );

            this._label.text = this._panelText;
            this._label.visible = this._panelText !== '';
            this._indicatorIcon.update({
                remainingPercentage: this._remainingPercent,
                colorScheme,
                customColors,
                showLogo: this._settings.get_boolean(SettingsKey.SHOW_LOGO),
                showBar: this._settings.get_boolean(SettingsKey.SHOW_BAR),
                showDots: this._settings.get_boolean(SettingsKey.SHOW_DOTS),
                barPosition: this._settings.get_int(SettingsKey.BAR_POSITION),
                indicatorSize: this._settings.get_int(SettingsKey.INDICATOR_SIZE),
            });
            this.visible = this._indicatorIcon.visible || this._label.visible;
            this._staleMarker.visible = this._stale && this.visible;
            // A stale reading's bars and chart take the heading's grey, which
            // is opaque: a level bar draws its end over the track.
            const staleColor = this._stale
                ? this._headingItem.label.get_theme_node().get_foreground_color()
                : null;
            for (const item of this._limitItems.values())
                item.setBarColor(colorScheme, customColors, staleColor);
            this._historyItem.setColors(colorScheme, customColors, staleColor);
        }
    },
);
