// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {BarPosition} from '../shared/settings.js';
import {calculateIconGeometry} from './iconGeometry.js';
import {LevelBar} from './levelBar.js';
import {LevelDots} from './levelDots.js';

const DEFAULT_SYSTEM_ICON_SIZE = 16;

export const IndicatorIcon = GObject.registerClass(
    class IndicatorIcon extends St.Bin {
        _init(iconFile) {
            super._init({
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._logoScale = 1;
            this._showLogo = true;
            this._showBar = true;
            this._showDots = false;
            this._barPosition = BarPosition.RIGHT;

            // A fixed canvas keeps visibility changes from resizing the panel button.
            this._canvas = new St.Widget({
                layout_manager: new Clutter.FixedLayout(),
            });
            this.set_child(this._canvas);

            this._logo = new St.Icon({
                // The provider logo keeps its own colors.
                gicon: new Gio.FileIcon({file: iconFile}),
            });
            this._canvas.add_child(this._logo);

            this._dots = new LevelDots();
            this._canvas.add_child(this._dots);

            this._bar = new LevelBar();
            this._canvas.add_child(this._bar);

            this._themeContext = St.ThemeContext.get_for_stage(global.stage);
            this._systemIconSize = DEFAULT_SYSTEM_ICON_SIZE * this._themeContext.scale_factor;
            this._syncLayout();
        }

        update({
            remainingPercentage,
            colorScheme,
            customColors,
            showLogo,
            showBar,
            showDots,
            barPosition,
            indicatorSize,
        }) {
            this._showLogo = showLogo;
            // A balance without a percentage would draw as an empty meter beside
            // a positive balance; the panel text shows the balance.
            this._showBar = showBar && remainingPercentage !== null;
            this._showDots = showDots && remainingPercentage !== null;
            this._barPosition = barPosition;
            this._logoScale = indicatorSize / 100;

            this._bar.update(remainingPercentage, colorScheme, customColors);
            this._dots.update(remainingPercentage, colorScheme, customColors);
            this._syncLayout();
        }

        vfunc_style_changed() {
            super.vfunc_style_changed();
            this._syncSystemIconSize();
        }

        _syncSystemIconSize() {
            const themeNode = this.peek_theme_node();
            if (themeNode === null) return;

            const [found, iconSize] = themeNode.lookup_length('icon-size', false);
            this._systemIconSize = found
                ? iconSize
                : DEFAULT_SYSTEM_ICON_SIZE * this._themeContext.scale_factor;
            // A scale change also restyles: the theme length may stay the same while
            // St.Icon's logical size changes.
            this._syncGeometry();
        }

        _syncLayout() {
            this._logo.visible = this._showLogo;
            this._bar.visible = this._showBar;
            this._dots.visible = this._showDots;
            this.visible = this._showLogo || this._showBar || this._showDots;

            this._syncGeometry();
        }

        _syncGeometry() {
            const {canvas, logo, bar, dots} = calculateIconGeometry({
                iconSize: this._systemIconSize,
                scaleFactor: this._themeContext.scale_factor,
                logoScale: this._logoScale,
                showLogo: this._showLogo,
                showBar: this._showBar,
                showDots: this._showDots,
                barPosition: this._barPosition,
            });

            this._canvas.set_size(canvas.width, canvas.height);
            this._logo.icon_size = logo.size / this._themeContext.scale_factor;
            this._logo.set_position(logo.x, logo.y);
            this._bar.setVertical(bar.vertical);
            this._bar.set_position(bar.x, bar.y);
            this._bar.set_size(bar.width, bar.height);
            this._dots.set_position(dots.x, dots.y);
            this._dots.set_size(dots.width, dots.height);
        }
    },
);
