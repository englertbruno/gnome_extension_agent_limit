// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {levelFill} from './level.js';

// One limit: its name and amount on one line, a bar of the remaining share
// below, and its reset and pace in small text under the bar.
export const LimitOptionItem = GObject.registerClass(
    class LimitOptionItem extends PopupMenu.PopupBaseMenuItem {
        _init() {
            super._init({style_class: 'codex-limit-option'});

            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            this.add_child(box);
            const header = new St.BoxLayout({style_class: 'codex-limit-option-header'});
            box.add_child(header);
            this._nameLabel = new St.Label({x_expand: true});
            header.add_child(this._nameLabel);
            this._percentLabel = new St.Label({style_class: 'codex-limit-option-percent'});
            header.add_child(this._percentLabel);
            // Shell's slider style gives the bar the theme's track.
            this._bar = new BarLevel({style_class: 'slider codex-limit-option-bar'});
            box.add_child(this._bar);
            this._resetLabel = new St.Label({style_class: 'codex-limit-option-note'});
            box.add_child(this._resetLabel);
            this._paceLabel = new St.Label({style_class: 'codex-limit-option-note'});
            box.add_child(this._paceLabel);

            // The presentation option shown by this row.
            this.option = null;
        }

        /** @param {boolean} choice Whether the menu has other rows to choose; a lone row has no dot. */
        update(option, choice) {
            this.option = option;
            this._nameLabel.text = option.name;
            this._percentLabel.text = option.percentText;
            this._bar.visible = option.remainingPercent !== null;
            this._bar.value = (option.remainingPercent ?? 0) / 100;
            this._resetLabel.text = option.resetText;
            this._resetLabel.visible = option.resetText !== '';
            this._paceLabel.text = option.paceText ?? '';
            this._paceLabel.visible = option.paceText !== null;
            this.accessible_name = option.accessibleName;
            this.setSensitive(option.panelWindow !== null);
            if (!choice) this.setOrnament(PopupMenu.Ornament.HIDDEN);
            else if (option.selected) this.setOrnament(PopupMenu.Ornament.DOT);
            else this.setOrnament(PopupMenu.Ornament.NO_DOT);
        }

        // The fill follows the color-scheme setting, as the top bar's meter
        // does, so it is set here rather than in the stylesheet; staleColor,
        // when given, replaces it.
        setBarColor(colorScheme, customColors, staleColor) {
            const {red, green, blue, alpha} =
                staleColor ??
                levelFill(
                    this._bar.get_theme_node().get_icon_colors(),
                    this.option.remainingPercent,
                    colorScheme,
                    customColors,
                );
            this._bar.style = `-barlevel-active-background-color: rgba(${red}, ${green}, ${blue}, ${alpha / 255});`;
        }
    },
);
