// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {levelFill} from './level.js';

// A bar takes this share of its slot; the rest is the gap to the next bar.
const BAR_SHARE = 0.6;
// Slots without use show a faint dash, so the chart spans the whole period.
const EMPTY_SLOT_OPACITY = 0.35;

// One bar per slot, oldest first. The slot with the most use fills the
// height. A bar has the level colour of what was left after its slot, as the
// top bar's meter, or the grey of a stale reading; the dashes have the text
// colour.
const HistoryBars = GObject.registerClass(
    class HistoryBars extends St.DrawingArea {
        _init() {
            super._init({style_class: 'codex-history-bars', x_expand: true});
            this._slots = [];
            this._remaining = [];
            // {colorScheme, customColors, staleColor}, set by the indicator
            // before the chart is shown.
            this._colors = null;
        }

        // The menu is updated every second during countdowns, but the slots
        // and colours rarely change; only a change repaints.
        setSlots(slots, remaining) {
            if (
                JSON.stringify([slots, remaining]) ===
                JSON.stringify([this._slots, this._remaining])
            )
                return;
            this._slots = slots;
            this._remaining = remaining;
            this.queue_repaint();
        }

        // staleColor, when given, replaces the level colours. It is kept as
        // numbers, which compare by value.
        setColors(colorScheme, customColors, staleColor) {
            const colors = {
                colorScheme,
                customColors,
                staleColor: staleColor && {
                    red: staleColor.red,
                    green: staleColor.green,
                    blue: staleColor.blue,
                    alpha: staleColor.alpha,
                },
            };
            if (JSON.stringify(colors) === JSON.stringify(this._colors)) return;
            this._colors = colors;
            this.queue_repaint();
        }

        vfunc_repaint() {
            const [width, height] = this.get_surface_size();
            const themeNode = this.get_theme_node();
            const foreground = themeNode.get_foreground_color();
            const iconColors = themeNode.get_icon_colors();
            const {colorScheme, customColors, staleColor} = this._colors;
            const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
            const most = Math.max(...this._slots);
            const slotWidth = width / this._slots.length;
            const barWidth = Math.max(1, Math.round(slotWidth * BAR_SHARE));
            const cr = this.get_context();

            for (const [index, value] of this._slots.entries()) {
                const used = value > 0;
                const barHeight = used ? Math.max(2, (height * value) / most) : 1;
                const offset = Math.round(index * slotWidth + (slotWidth - barWidth) / 2);
                const x = rtl ? width - offset - barWidth : offset;
                const {red, green, blue, alpha} = !used
                    ? foreground
                    : (staleColor ??
                      levelFill(iconColors, this._remaining[index], colorScheme, customColors));
                const opacity = used ? 1 : EMPTY_SLOT_OPACITY;
                cr.setSourceRGBA(red / 255, green / 255, blue / 255, (alpha / 255) * opacity);
                cr.rectangle(x, height - barHeight, barWidth, barHeight);
                cr.fill();
            }

            cr.$dispose();
        }
    },
);

// The use of the shown window per slot, and its busiest period in words,
// which also name the row for screen readers. The row is not insensitive, so
// that the bars and words have the text colour; the indicator puts the
// chart's title above it.
export const HistoryChartItem = GObject.registerClass(
    class HistoryChartItem extends PopupMenu.PopupBaseMenuItem {
        _init() {
            super._init({activate: false, can_focus: false, style_class: 'codex-history'});
            this.track_hover = false;

            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            this.add_child(box);
            this._bars = new HistoryBars();
            box.add_child(this._bars);
            this._summary = new St.Label({style_class: 'codex-history-summary'});
            box.add_child(this._summary);
            this.label_actor = this._summary;
        }

        /** @param {{slots: number[], remaining: Array<number|null>, summary: string}} history From the presentation. */
        update({slots, remaining, summary}) {
            this._summary.text = summary;
            this._bars.setSlots(slots, remaining);
        }

        setColors(colorScheme, customColors, staleColor) {
            this._bars.setColors(colorScheme, customColors, staleColor);
        }
    },
);
