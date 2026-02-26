/**
 * Settings Module
 * Stores runtime settings that can be toggled via Discord or Dashboard
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// Default settings
var defaults = {
    whitelistEnabled: true,         // Enable/disable whitelist enforcement
    chatBridgeEnabled: true,        // Enable/disable Discord <-> Game chat bridge
    killfeedEnabled: true,          // Enable/disable killfeed notifications
    joinLeaveNotifications: true,   // Enable/disable join/leave notifications
    autoKickEnabled: true,          // Enable/disable auto-kick for non-whitelisted
    kickDelaySeconds: 60,           // Kick delay override
    statusMessages: [               // Rotating bot status messages
        'Codex Team since 2015.',
        'Contact DC\uD83D\uDCE7: alphabay911'
    ],
    statusInterval: 40,             // Seconds between status rotation
    creditEditCode: 'codex2015'     // Unlock code to edit credit/status messages via dashboard
};

var settings = {};

function ensureDir() {
    var dbPath = path.resolve(config.databasePath);
    if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
    }
}

function load() {
    ensureDir();
    var filePath = path.resolve(config.settingsFile);

    try {
        if (fs.existsSync(filePath)) {
            var data = fs.readFileSync(filePath, 'utf8');
            var loaded = JSON.parse(data);
            // Merge with defaults (in case new settings are added)
            settings = Object.assign({}, defaults, loaded);
            console.log('[Settings] Loaded settings');
        } else {
            settings = Object.assign({}, defaults);
            save();
            console.log('[Settings] Created default settings');
        }
    } catch (error) {
        console.error('[Settings] Error loading:', error.message);
        settings = Object.assign({}, defaults);
        save();
    }

    return settings;
}

function save() {
    ensureDir();
    var filePath = path.resolve(config.settingsFile);

    try {
        fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (error) {
        console.error('[Settings] Error saving:', error.message);
    }
}

/**
 * Get a setting value
 * @param {string} key
 * @returns {*}
 */
function get(key) {
    return settings.hasOwnProperty(key) ? settings[key] : defaults[key];
}

/**
 * Set a setting value
 * @param {string} key
 * @param {*} value
 * @returns {boolean}
 */
function set(key, value) {
    settings[key] = value;
    save();
    console.log('[Settings] Set ' + key + ' = ' + JSON.stringify(value));
    return true;
}

/**
 * Toggle a boolean setting
 * @param {string} key
 * @returns {{ success: boolean, value?: boolean }}
 */
function toggle(key) {
    if (!defaults.hasOwnProperty(key)) {
        return { success: false };
    }
    if (typeof settings[key] !== 'boolean') {
        return { success: false };
    }
    settings[key] = !settings[key];
    save();
    console.log('[Settings] Toggled ' + key + ' -> ' + settings[key]);
    return { success: true, value: settings[key] };
}

/**
 * Get all settings
 * @returns {Object}
 */
function getAll() {
    return Object.assign({}, settings);
}

/**
 * Reset to defaults
 */
function reset() {
    settings = Object.assign({}, defaults);
    save();
    console.log('[Settings] Reset to defaults');
}

module.exports = {
    load: load,
    save: save,
    get: get,
    set: set,
    toggle: toggle,
    getAll: getAll,
    reset: reset
};
