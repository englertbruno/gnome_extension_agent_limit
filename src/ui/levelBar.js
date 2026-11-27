// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-FileCopyrightText: 2024-2026 maniacx@github.com
// SPDX-License-Identifier: GPL-3.0-or-later

// Battery geometry and drawing adapted from Bluetooth Battery Meter by maniacx:
// https://github.com/maniacx/Bluetooth-Battery-Meter/blob/13a751fb1b1d66f186726c7fc82628a4b6c2243f/lib/widgets/indicatorIconWidget.js
// Upstream credits Deminder's battery-indicator-icon:
// https://github.com/Deminder/battery-indicator-icon/blob/main/src/modules/drawicon.js

import GObject from 'gi://GObject';

import {Level} from './level.js';

export const LevelBar = GObject.registerClass(
    class LevelBar extends Level {
        _init() {
            super._init();
            this._vertical = false;
        }

        setVertical(vertical) {
            if (this._vertical === vertical) return;

            this._vertical = vertical;
            if (this.has_allocation()) this.queue_repaint();
        }

        vfunc_repaint() {
            const [width, height] = this.get_surface_size();
            if (width <= 0 || height <= 0) return;

            const remainingPercentage = this._remainingPercentageForDrawing();
            const colors = this._levelColors(remainingPercentage);
            const cr = this.get_context();
            const bounds = this._barBounds(width, height);

            this._appendRoundedBar(
                cr,
                bounds.barX,
                bounds.barY,
                bounds.barWidth,
                bounds.barHeight,
                bounds.radius,
            );
            this._useLevelColor(cr, colors.background, 0.5);
            cr.fill();

            this._appendRoundedBar(
                cr,
                bounds.notchX,
                bounds.notchY,
                bounds.notchWidth,
                bounds.notchHeight,
                bounds.radius,
            );
            this._useLevelColor(
                cr,
                remainingPercentage >= 100 ? colors.fill : colors.background,
                remainingPercentage >= 100 ? 1 : 0.5,
            );
            cr.fill();

            if (remainingPercentage > 0) {
                this._useLevelColor(cr, colors.fill);
                if (this._vertical) {
                    const fillHeight = (bounds.barHeight * remainingPercentage) / 100;
                    this._appendRoundedBar(
                        cr,
                        bounds.barX,
                        bounds.barY + bounds.barHeight - fillHeight,
                        bounds.barWidth,
                        fillHeight,
                        bounds.radius,
                    );
                } else {
                    this._appendRoundedBar(
                        cr,
                        bounds.barX,
                        bounds.barY,
                        (bounds.barWidth * remainingPercentage) / 100,
                        bounds.barHeight,
                        bounds.radius,
                    );
                }
                cr.fill();
            }

            cr.$dispose();
        }

        _barBounds(width, height) {
            const thickness = this._vertical ? width : height;
            const notchLength = thickness * 0.4;
            const notchDepth = thickness * 0.6;
            const radius = thickness * 0.06;

            if (this._vertical) {
                return {
                    barX: 0,
                    barY: notchLength,
                    barWidth: width,
                    barHeight: height - notchLength,
                    notchX: (width - notchDepth) / 2,
                    notchY: 0,
                    notchWidth: notchDepth,
                    notchHeight: notchLength,
                    radius,
                };
            }

            return {
                barX: 0,
                barY: 0,
                barWidth: width - notchLength,
                barHeight: height,
                notchX: width - notchLength,
                notchY: (height - notchDepth) / 2,
                notchWidth: notchLength,
                notchHeight: notchDepth,
                radius,
            };
        }

        _appendRoundedBar(cr, x, y, width, height, radius) {
            const safeRadius = Math.min(radius, width / 2, height / 2);

            cr.newPath();
            cr.arc(x + width - safeRadius, y + safeRadius, safeRadius, -Math.PI / 2, 0);
            cr.arc(x + width - safeRadius, y + height - safeRadius, safeRadius, 0, Math.PI / 2);
            cr.arc(x + safeRadius, y + height - safeRadius, safeRadius, Math.PI / 2, Math.PI);
            cr.arc(x + safeRadius, y + safeRadius, safeRadius, Math.PI, (3 * Math.PI) / 2);
            cr.closePath();
        }
    },
);
