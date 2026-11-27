// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-FileCopyrightText: 2024-2026 maniacx@github.com
// SPDX-License-Identifier: GPL-3.0-or-later

// Color modes based on Bluetooth Battery Meter by maniacx:
// https://github.com/maniacx/Bluetooth-Battery-Meter/blob/13a751fb1b1d66f186726c7fc82628a4b6c2243f/lib/widgets/indicatorIconWidget.js
// Upstream credits Deminder's battery-indicator-icon:
// https://github.com/Deminder/battery-indicator-icon/blob/main/src/modules/drawicon.js

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {ColorScheme} from '../shared/settings.js';

/**
 * The fill of a level for the remaining percentage under the color-scheme
 * setting: the text or success colour, the warning colour at 20% or less, or
 * the user's colour for each tenth. The top bar's meters and the menu's bars
 * share it.
 *
 * @param {St.IconColors} iconColors Of the theme node the level is drawn with.
 */
export function levelFill(iconColors, remainingPercentage, colorScheme, customColors) {
    if (colorScheme === ColorScheme.CUSTOM) {
        const bucketIndex = Math.min(9, Math.max(0, Math.ceil(remainingPercentage / 10) - 1));
        const value = customColors[bucketIndex];
        return {
            red: Number.parseInt(value.slice(1, 3), 16),
            green: Number.parseInt(value.slice(3, 5), 16),
            blue: Number.parseInt(value.slice(5, 7), 16),
            alpha: 255,
        };
    }
    if (remainingPercentage <= 20) return iconColors.warning;
    return colorScheme === ColorScheme.SYMBOLIC ? iconColors.foreground : iconColors.success;
}

// BarLevel cannot draw a vertical battery or dots. This base holds value and
// color; subclasses draw.
export const Level = GObject.registerClass(
    class Level extends St.DrawingArea {
        _init() {
            super._init({
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._remainingPercentage = null;
            this._colorScheme = ColorScheme.COLORED;
            this._customColors = [];
        }

        update(remainingPercentage, colorScheme, customColors) {
            this._remainingPercentage = remainingPercentage;
            this._colorScheme = colorScheme;
            this._customColors = customColors;
            if (this.has_allocation()) this.queue_repaint();
        }

        _remainingPercentageForDrawing() {
            return Math.min(100, Math.max(0, this._remainingPercentage ?? 0));
        }

        _levelColors(remainingPercentage) {
            const iconColors = this.get_theme_node().get_icon_colors();
            return {
                background: iconColors.foreground,
                fill: levelFill(
                    iconColors,
                    remainingPercentage,
                    this._colorScheme,
                    this._customColors,
                ),
            };
        }

        _useLevelColor(cr, color, opacity = 1) {
            cr.setSourceRGBA(
                color.red / 255,
                color.green / 255,
                color.blue / 255,
                (color.alpha / 255) * opacity,
            );
        }
    },
);
