// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-FileCopyrightText: 2024-2026 maniacx@github.com
// SPDX-License-Identifier: GPL-3.0-or-later

// Dot placement adapted from Bluetooth Battery Meter by maniacx:
// https://github.com/maniacx/Bluetooth-Battery-Meter/blob/13a751fb1b1d66f186726c7fc82628a4b6c2243f/lib/widgets/indicatorIconWidget.js
// Upstream credits Deminder's battery-indicator-icon:
// https://github.com/Deminder/battery-indicator-icon/blob/main/src/modules/drawicon.js

import GObject from 'gi://GObject';

import {Level} from './level.js';

const DOT_COUNT = 4;

export const LevelDots = GObject.registerClass(
    class LevelDots extends Level {
        vfunc_repaint() {
            const [width, height] = this.get_surface_size();
            if (width <= 0 || height <= 0) return;

            const remainingPercentage = this._remainingPercentageForDrawing();
            // The last dot stays visible when usage is depleted or unknown.
            const filledCount = Math.min(
                DOT_COUNT,
                Math.max(1, Math.ceil(remainingPercentage / 25)),
            );
            const colors = this._levelColors(remainingPercentage);
            const cr = this.get_context();

            this._appendDots(cr, width, height, filledCount);
            this._useLevelColor(cr, colors.fill);
            cr.fill();

            cr.$dispose();
        }

        _appendDots(cr, width, height, count) {
            const radius = height / 2;
            const diameter = height;
            const centerX = width / 2;
            const centerY = height / 2;
            let centers;

            if (count === 1) {
                centers = [centerX];
            } else if (count === 2) {
                centers = [centerX - diameter, centerX + diameter];
            } else if (count === 3) {
                centers = [centerX - diameter - radius, centerX, centerX + diameter + radius];
            } else {
                const spacing = (width - DOT_COUNT * diameter) / (DOT_COUNT - 1);
                centers = Array.from(
                    {length: DOT_COUNT},
                    (_value, index) => radius + index * (diameter + spacing),
                );
            }

            cr.newPath();
            for (const dotCenterX of centers) {
                cr.newSubPath();
                cr.arc(dotCenterX, centerY, radius, 0, 2 * Math.PI);
            }
        }
    },
);
