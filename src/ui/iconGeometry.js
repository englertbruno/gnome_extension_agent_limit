// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-FileCopyrightText: 2024-2026 maniacx@github.com
// SPDX-License-Identifier: GPL-3.0-or-later

// Layout dimensions adapted from Bluetooth Battery Meter by maniacx:
// https://github.com/maniacx/Bluetooth-Battery-Meter/blob/13a751fb1b1d66f186726c7fc82628a4b6c2243f/lib/widgets/indicatorIconWidget.js
// Upstream credits Deminder's battery-indicator-icon:
// https://github.com/Deminder/battery-indicator-icon/blob/main/src/modules/drawicon.js

import {BarPosition} from '../shared/settings.js';

const SINGLE_LEVEL_LOGO_HEIGHT_RATIO = 12 / 16;
const HORIZONTAL_LEVEL_WIDTH_RATIO = 15 / 16;
const HORIZONTAL_LEVEL_HEIGHT_RATIO = 2.6 / 16;
const VERTICAL_BAR_WIDTH_RATIO = 4 / 16;
const VERTICAL_BAR_HEIGHT_RATIO = 15 / 16;
const SIDE_SPACING_RATIO = 3 / 16;

// Lengths are physical pixels. St.Icon.icon_size is an integer in logical pixels,
// so logo.size is a multiple of scaleFactor; the caller divides by it.
export function calculateIconGeometry({
    iconSize,
    scaleFactor,
    logoScale,
    showLogo,
    showBar,
    showDots,
    barPosition,
}) {
    const horizontalWidth = Math.max(1, Math.round(iconSize * HORIZONTAL_LEVEL_WIDTH_RATIO));
    const horizontalHeight = Math.max(1, Math.round(iconSize * HORIZONTAL_LEVEL_HEIGHT_RATIO));
    const verticalWidth = Math.max(1, Math.round(iconSize * VERTICAL_BAR_WIDTH_RATIO));
    const verticalHeight = Math.max(1, Math.round(iconSize * VERTICAL_BAR_HEIGHT_RATIO));
    const sideSpacing = Math.max(0, Math.round(iconSize * SIDE_SPACING_RATIO));

    const barOnLeft = showBar && barPosition === BarPosition.LEFT;
    const barOnRight = showBar && barPosition === BarPosition.RIGHT;
    const barBelow = showBar && barPosition === BarPosition.BELOW;
    const hasSideBar = barOnLeft || barOnRight;
    const horizontalLevelCount = Number(barBelow) + Number(showDots);
    const horizontalLevelsHeight = horizontalLevelCount * horizontalHeight;
    const hasCenter = showLogo || horizontalLevelCount > 0;
    const centerWidth = hasCenter ? iconSize : 0;
    const sideGap = hasSideBar && hasCenter ? sideSpacing : 0;
    const centerX = barOnLeft ? verticalWidth + sideGap : 0;

    const canvas = {
        width: Math.max(1, centerWidth + (hasSideBar ? verticalWidth : 0) + sideGap),
        height: iconSize,
    };

    // Lower indicators are stacked at the bottom with a logo, otherwise centered.
    const horizontalX = centerX + Math.floor((centerWidth - horizontalWidth) / 2);
    const horizontalY =
        showLogo && horizontalLevelCount > 0
            ? iconSize - horizontalLevelsHeight
            : Math.floor((iconSize - horizontalLevelsHeight) / 2);
    const bar = hasSideBar
        ? {
              x: barOnLeft ? 0 : centerWidth + sideGap,
              y: Math.floor((iconSize - verticalHeight) / 2),
              width: verticalWidth,
              height: verticalHeight,
              vertical: true,
          }
        : {
              x: horizontalX,
              y: barBelow ? horizontalY : 0,
              width: horizontalWidth,
              height: horizontalHeight,
              vertical: false,
          };
    const dots = {
        x: horizontalX,
        y: horizontalY + (barBelow ? horizontalHeight : 0),
        width: horizontalWidth,
        height: horizontalHeight,
    };

    let logoSize = Math.max(scaleFactor, Math.floor(iconSize / scaleFactor) * scaleFactor);
    let logoY = 0;
    if (horizontalLevelCount > 0) {
        const logoSpacing = Math.max(0, Math.round(iconSize / 16));
        const logoBottom = horizontalY - logoSpacing;
        // A second lower indicator shrinks the logo rather than growing the canvas.
        const maximumLogoSize = Math.max(
            1,
            Math.min(Math.round(iconSize * SINGLE_LEVEL_LOGO_HEIGHT_RATIO), logoBottom),
        );
        const requestedLogoSize = Math.round(maximumLogoSize * logoScale);
        logoSize = Math.max(scaleFactor, Math.floor(requestedLogoSize / scaleFactor) * scaleFactor);
        logoY = logoBottom - logoSize;
    }
    const logo = {
        x: centerX + Math.floor((centerWidth - logoSize) / 2),
        y: logoY,
        size: logoSize,
    };

    return {canvas, logo, bar, dots};
}
