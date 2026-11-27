// SPDX-FileCopyrightText: 2026 Bruno Englert
// SPDX-License-Identifier: GPL-2.0-or-later

// Keys of the main schema.
export const SettingsKey = Object.freeze({
    ACCOUNTS: 'accounts',
    GRACE_PERIOD: 'grace-period',
    PANEL_BOX: 'panel-box',
    PANEL_INDEX: 'panel-index',
    PANEL_LABEL: 'panel-label',
    SHOW_USED: 'show-used',
    SHOW_RESET_CLOCK: 'show-reset-clock',
    SHOW_HISTORY: 'show-history',
    NOTIFY_LOW_REMAINING: 'notify-low-remaining',
    LOW_REMAINING_THRESHOLD: 'low-remaining-threshold',
    NOTIFY_UNUSED: 'notify-unused',
    UNUSED_THRESHOLD: 'unused-threshold',
    UNUSED_HOURS: 'unused-hours',
    NOTIFY_RESET_EXPIRY: 'notify-reset-expiry',
    TOGGLE_MENU_SHORTCUT: 'toggle-agent-usage-menu',
    SHOW_LOGO: 'show-logo',
    SHOW_BAR: 'show-bar',
    SHOW_DOTS: 'show-dots',
    BAR_POSITION: 'level-bar-position',
    INDICATOR_SIZE: 'indicator-size',
    COLOR_SCHEME: 'color-scheme',
    CUSTOM_COLORS: 'custom-colors',
});

// The values of an account's panel-window key: which window of its limit the
// panel shows.
export const PanelWindow = Object.freeze({WEEKLY: 0, SHORTEST: 1});

// Keys of each account-N child settings object.
export const AccountKey = Object.freeze({
    TYPE: 'type',
    NAME: 'name',
    ENABLED: 'enabled',
    INSTANCE_ID: 'instance-id',
    CONFIG_DIRECTORY: 'config-directory',
    REFRESH_INTERVAL: 'refresh-interval',
    LIMIT_ID: 'limit-id',
    PANEL_WINDOW: 'panel-window',
    API_KEY_REVISION: 'api-key-revision',
    KIMI_REGION: 'kimi-region',
    ENDPOINT_URL: 'endpoint-url',
    AUTH_HEADER: 'auth-header',
    AUTH_PREFIX: 'auth-prefix',
    PERCENT_POINTER: 'percent-pointer',
    PERCENT_MEANING: 'percent-meaning',
    USED_POINTER: 'used-pointer',
    LIMIT_POINTER: 'limit-pointer',
    RESET_POINTER: 'reset-pointer',
    WINDOW_MINUTES: 'window-minutes',
    USAGE_PAGE_URL: 'usage-page-url',
    AUTO_REDEEM: 'auto-redeem',
});

export const BarPosition = Object.freeze({
    LEFT: 0,
    RIGHT: 1,
    BELOW: 2,
});

export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export const ColorScheme = Object.freeze({
    SYMBOLIC: 0,
    COLORED: 1,
    CUSTOM: 2,
});

export const DEFAULT_CUSTOM_COLORS = Object.freeze([
    '#ff7800',
    '#ff7800',
    '#15c931',
    '#15c931',
    '#15c931',
    '#15c931',
    '#15c931',
    '#15c931',
    '#15c931',
    '#15c931',
]);

/**
 * Settings can be edited outside preferences. Preferences and the panel both
 * replace each malformed or missing custom color with its default.
 */
export function normalizeCustomColors(colors) {
    return DEFAULT_CUSTOM_COLORS.map((defaultColor, index) => {
        const color = colors[index];
        return HEX_COLOR_PATTERN.test(color ?? '') ? color.toLowerCase() : defaultColor;
    });
}
