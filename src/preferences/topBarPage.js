// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    gettext as _,
    ngettext,
    pgettext,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {LABEL_MAX_LENGTH, LABEL_PLACEHOLDERS, parseLabelTemplate} from '../shared/labelTemplate.js';
import {
    BarPosition,
    ColorScheme,
    DEFAULT_CUSTOM_COLORS,
    normalizeCustomColors,
    SettingsKey,
} from '../shared/settings.js';
import {CustomColorRow} from './customColorRow.js';
import {createComboRow, createSpinRow, createSwitchRow} from './rows.js';

// panel-box values in the order of the Area choices.
const PANEL_BOXES = ['left', 'center', 'right'];
// panel-label values in the order of the label choices; the last choice,
// Custom, shows the template entry.
const LABEL_PRESETS = ['{percent}', '{percent} · {reset}', '{reset}', ''];
const CUSTOM_LABEL = LABEL_PRESETS.length;

export const TopBarPage = GObject.registerClass(
    class TopBarPage extends Adw.PreferencesPage {
        _init(settings) {
            super._init({
                title: _('Top Bar'),
                icon_name: 'preferences-desktop-display-symbolic',
            });

            this._settings = settings;
            this._customColorRows = [];

            const positionGroup = new Adw.PreferencesGroup({title: _('Position')});
            this._panelBoxRow = new Adw.ComboRow({
                title: _('Area'),
                subtitle: _('Part of the top bar that holds the indicators'),
                model: Gtk.StringList.new([
                    pgettext('top bar area', 'Left'),
                    pgettext('top bar area', 'Center'),
                    pgettext('top bar area', 'Right'),
                ]),
            });
            positionGroup.add(this._panelBoxRow);
            positionGroup.add(
                createSpinRow(settings, SettingsKey.PANEL_INDEX, {
                    title: _('Position in the area'),
                    subtitle: _(
                        'Counts every item of the area, including those of GNOME Shell and other extensions',
                    ),
                }),
            );
            this.add(positionGroup);

            const labelGroup = new Adw.PreferencesGroup({
                title: _('Label'),
                description: _(
                    /* Translators: %s lists the placeholders, such as "{percent} {reset}". */
                    'A custom label can contain %s. Write {{ or }} for a literal brace.',
                ).format(LABEL_PLACEHOLDERS.map(name => `{${name}}`).join(' ')),
            });
            this._labelPresetRow = new Adw.ComboRow({
                title: _('Text'),
                model: Gtk.StringList.new([
                    _('Percentage'),
                    _('Percentage and reset countdown'),
                    _('Reset countdown'),
                    _('None'),
                    _('Custom'),
                ]),
            });
            labelGroup.add(this._labelPresetRow);
            this._labelTemplateRow = new Adw.EntryRow({
                title: _('Custom label'),
                max_length: LABEL_MAX_LENGTH,
            });
            this._labelWarning = new Gtk.Image({icon_name: 'dialog-warning-symbolic'});
            this._labelTemplateRow.add_suffix(this._labelWarning);
            labelGroup.add(this._labelTemplateRow);
            labelGroup.add(
                createSwitchRow(
                    settings,
                    SettingsKey.SHOW_USED,
                    _('Show Used Instead of Remaining'),
                    _('Percentages count up from 0% as the limit is used'),
                ),
            );
            this.add(labelGroup);

            const appearanceGroup = new Adw.PreferencesGroup({
                title: _('Appearance'),
                description: _(
                    'Hiding the label and every part removes the indicators from the top bar',
                ),
            });
            appearanceGroup.add(
                createSwitchRow(
                    settings,
                    SettingsKey.SHOW_LOGO,
                    _('Show Logo'),
                    _('Display the provider logo'),
                ),
            );
            appearanceGroup.add(
                createSwitchRow(
                    settings,
                    SettingsKey.SHOW_BAR,
                    _('Show Bar'),
                    _('Display the shown limit as a battery-shaped level bar'),
                ),
            );
            appearanceGroup.add(
                createSwitchRow(
                    settings,
                    SettingsKey.SHOW_DOTS,
                    _('Show Dots'),
                    _('Display one to four level dots below the logo'),
                ),
            );
            this._barPositionRow = createComboRow(
                settings,
                SettingsKey.BAR_POSITION,
                _('Bar position'),
                _('Choose where the bar appears relative to the logo'),
                [_('Left'), _('Right'), _('Below')],
            );
            appearanceGroup.add(this._barPositionRow);
            this._indicatorSizeRow = createSpinRow(settings, SettingsKey.INDICATOR_SIZE, {
                title: _('Logo size (%)'),
                subtitle: _('Adjust the logo above a bar or dots'),
            });
            appearanceGroup.add(this._indicatorSizeRow);
            this.add(appearanceGroup);

            const colorGroup = new Adw.PreferencesGroup({
                title: _('Level Colors'),
                description: _(
                    // xgettext:no-javascript-format
                    'Symbolic follows the Shell foreground color, Colored uses the success color, and both use the warning color at 20% or less. Customized uses the ranges below.',
                ),
            });
            this._colorSchemeRow = createComboRow(
                settings,
                SettingsKey.COLOR_SCHEME,
                _('Color scheme'),
                _('Choose how the bar and dots are colored'),
                [
                    // Translators: color scheme choices for the level meter:
                    // Symbolic follows the Shell foreground color, Colored uses success and warning colors,
                    // Customized uses the user's ranges.
                    _('Symbolic'),
                    _('Colored'),
                    _('Customized'),
                ],
            );
            colorGroup.add(this._colorSchemeRow);
            this.add(colorGroup);

            this._customColorGroup = new Adw.PreferencesGroup({
                title: _('Custom Colors'),
                description: _('Assign a color to each 10% range of remaining allowance'),
            });
            for (let index = DEFAULT_CUSTOM_COLORS.length - 1; index >= 0; index--) {
                const row = new CustomColorRow(index, color => this._setCustomColor(index, color));
                this._customColorRows[index] = row;
                this._customColorGroup.add(row);
            }
            this.add(this._customColorGroup);

            this._syncPanelBox();
            this._syncLabel();
            this._syncCustomColors();
            this._syncRowVisibility();

            this._widgetSignals = [
                [
                    this._panelBoxRow,
                    this._panelBoxRow.connect('notify::selected', () => this._panelBoxSelected()),
                ],
                [
                    this._labelPresetRow,
                    this._labelPresetRow.connect('notify::selected', () =>
                        this._labelPresetSelected(),
                    ),
                ],
                [
                    this._labelTemplateRow,
                    this._labelTemplateRow.connect('changed', () => this._labelTemplateChanged()),
                ],
            ];
            this._settingsSignalIds = [
                [SettingsKey.PANEL_BOX, () => this._syncPanelBox()],
                [SettingsKey.PANEL_LABEL, () => this._syncLabel()],
                [SettingsKey.CUSTOM_COLORS, () => this._syncCustomColors()],
                [SettingsKey.SHOW_LOGO, () => this._syncRowVisibility()],
                [SettingsKey.SHOW_BAR, () => this._syncRowVisibility()],
                [SettingsKey.SHOW_DOTS, () => this._syncRowVisibility()],
                [SettingsKey.BAR_POSITION, () => this._syncRowVisibility()],
                [SettingsKey.COLOR_SCHEME, () => this._syncRowVisibility()],
            ].map(([key, callback]) => this._settings.connect(`changed::${key}`, callback));
        }

        release() {
            for (const signalId of this._settingsSignalIds) this._settings.disconnect(signalId);
            this._settingsSignalIds = [];
            for (const [widget, signalId] of this._widgetSignals) widget.disconnect(signalId);
            this._widgetSignals = [];

            for (const row of this._customColorRows) row.release();
            this._customColorRows = [];

            this._settings = null;
            this._panelBoxRow = null;
            this._labelPresetRow = null;
            this._labelTemplateRow = null;
            this._labelWarning = null;
            this._barPositionRow = null;
            this._indicatorSizeRow = null;
            this._colorSchemeRow = null;
            this._customColorGroup = null;
        }

        _syncPanelBox() {
            this._panelBoxRow.selected = PANEL_BOXES.indexOf(
                this._settings.get_string(SettingsKey.PANEL_BOX),
            );
        }

        _panelBoxSelected() {
            const box = PANEL_BOXES[this._panelBoxRow.selected];
            if (box !== this._settings.get_string(SettingsKey.PANEL_BOX))
                this._settings.set_string(SettingsKey.PANEL_BOX, box);
        }

        // A preset label selects its choice, any other label Custom. Once the
        // user picks Custom, it stays selected while the template is edited,
        // even when the template matches a preset.
        _syncLabel() {
            const label = this._settings.get_string(SettingsKey.PANEL_LABEL);
            if (this._labelPresetRow.selected !== CUSTOM_LABEL) {
                const preset = LABEL_PRESETS.indexOf(label);
                this._labelPresetRow.selected = preset < 0 ? CUSTOM_LABEL : preset;
            }
            if (this._labelTemplateRow.text !== label) this._labelTemplateRow.text = label;
            this._labelTemplateRow.visible = this._labelPresetRow.selected === CUSTOM_LABEL;

            const {unknown} = parseLabelTemplate(label);
            if (unknown.length === 0) {
                this._labelTemplateRow.remove_css_class('error');
                this._labelWarning.visible = false;
                return;
            }
            this._labelTemplateRow.add_css_class('error');
            this._labelWarning.tooltip_text = ngettext(
                /* Translators: tooltip when the top bar label template contains unknown {placeholders}. %s lists them, such as "{foo} {bar}". */
                'Unknown placeholder: %s',
                'Unknown placeholders: %s',
                unknown.length,
            ).format(unknown.map(name => `{${name}}`).join(' '));
            this._labelWarning.visible = true;
        }

        _labelPresetSelected() {
            const selected = this._labelPresetRow.selected;
            this._labelTemplateRow.visible = selected === CUSTOM_LABEL;
            if (
                selected !== CUSTOM_LABEL &&
                LABEL_PRESETS[selected] !== this._settings.get_string(SettingsKey.PANEL_LABEL)
            )
                this._settings.set_string(SettingsKey.PANEL_LABEL, LABEL_PRESETS[selected]);
        }

        _labelTemplateChanged() {
            const label = this._labelTemplateRow.text;
            if (label !== this._settings.get_string(SettingsKey.PANEL_LABEL))
                this._settings.set_string(SettingsKey.PANEL_LABEL, label);
        }

        _syncCustomColors() {
            const colors = normalizeCustomColors(
                this._settings.get_strv(SettingsKey.CUSTOM_COLORS),
            );
            for (const [index, row] of this._customColorRows.entries()) row.setColor(colors[index]);
        }

        _setCustomColor(index, color) {
            const colors = normalizeCustomColors(
                this._settings.get_strv(SettingsKey.CUSTOM_COLORS),
            );
            colors[index] = color;
            this._settings.set_strv(SettingsKey.CUSTOM_COLORS, colors);
        }

        _syncRowVisibility() {
            const showLogo = this._settings.get_boolean(SettingsKey.SHOW_LOGO);
            const showBar = this._settings.get_boolean(SettingsKey.SHOW_BAR);
            const showDots = this._settings.get_boolean(SettingsKey.SHOW_DOTS);
            const barBelow = this._settings.get_int(SettingsKey.BAR_POSITION) === BarPosition.BELOW;
            const hasLevelIndicator = showBar || showDots;

            this._barPositionRow.visible = showBar;
            this._indicatorSizeRow.visible = showLogo && (showDots || (showBar && barBelow));
            this._colorSchemeRow.sensitive = hasLevelIndicator;
            this._customColorGroup.visible =
                hasLevelIndicator &&
                this._settings.get_uint(SettingsKey.COLOR_SCHEME) === ColorScheme.CUSTOM;
        }
    },
);
