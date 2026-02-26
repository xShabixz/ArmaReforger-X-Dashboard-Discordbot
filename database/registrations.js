/**
 * Registrations Module
 * Maps Discord ID -> Game UID for linking accounts
 * Players use /register to link their Discord account with their Game UID
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// In-memory cache: { discordId: { gameUID, playerName, registeredAt } }
var registrations = {};

function ensureDir() {
    var dbPath = path.resolve(config.databasePath);
    if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
    }
}

function load() {
    ensureDir();
    var filePath = path.resolve(config.registrationsFile);

    try {
        if (fs.existsSync(filePath)) {
            var data = fs.readFileSync(filePath, 'utf8');
            registrations = JSON.parse(data);
            console.log('[Registrations] Loaded ' + Object.keys(registrations).length + ' registrations');
        } else {
            registrations = {};
            save();
            console.log('[Registrations] Created new registrations file');
        }
    } catch (error) {
        console.error('[Registrations] Error loading:', error.message);
        registrations = {};
        save();
    }

    return registrations;
}

function save() {
    ensureDir();
    var filePath = path.resolve(config.registrationsFile);

    try {
        fs.writeFileSync(filePath, JSON.stringify(registrations, null, 2), 'utf8');
    } catch (error) {
        console.error('[Registrations] Error saving:', error.message);
    }
}

/**
 * Register a Discord user's Game UID
 * @param {string} discordId
 * @param {string} gameUID
 * @param {string} playerName - Discord display name
 * @returns {{ success: boolean, error?: string }}
 */
function register(discordId, gameUID, playerName) {
    if (!discordId || !gameUID) {
        return { success: false, error: 'Missing discordId or gameUID' };
    }

    // Check if this Game UID is already registered by someone else
    for (var key in registrations) {
        if (registrations[key].gameUID === gameUID && key !== discordId) {
            return { success: false, error: 'Game UID นี้ถูกลงทะเบียนโดยคนอื่นแล้ว' };
        }
    }

    registrations[discordId] = {
        gameUID: gameUID,
        playerName: playerName || null,
        registeredAt: new Date().toISOString()
    };

    save();
    console.log('[Registrations] Registered: Discord ' + discordId + ' -> Game UID ' + gameUID);
    return { success: true };
}

/**
 * Unregister a Discord user
 * @param {string} discordId
 * @returns {boolean}
 */
function unregister(discordId) {
    if (registrations[discordId]) {
        var gameUID = registrations[discordId].gameUID;
        delete registrations[discordId];
        save();
        console.log('[Registrations] Unregistered: Discord ' + discordId + ' (was Game UID ' + gameUID + ')');
        return true;
    }
    return false;
}

/**
 * Get Game UID by Discord ID
 * @param {string} discordId
 * @returns {string|null} Game UID or null
 */
function getGameUID(discordId) {
    var entry = registrations[discordId];
    return entry ? entry.gameUID : null;
}

/**
 * Get Discord ID by Game UID
 * @param {string} gameUID
 * @returns {string|null} Discord ID or null
 */
function getDiscordId(gameUID) {
    for (var key in registrations) {
        if (registrations[key].gameUID === gameUID) {
            return key;
        }
    }
    return null;
}

/**
 * Get registration entry by Discord ID
 * @param {string} discordId
 * @returns {Object|null}
 */
function getByDiscordId(discordId) {
    return registrations[discordId] || null;
}

/**
 * Check if a Discord user is registered
 * @param {string} discordId
 * @returns {boolean}
 */
function isRegistered(discordId) {
    return registrations.hasOwnProperty(discordId);
}

/**
 * Get all registrations as array
 * @returns {Array}
 */
function getAll() {
    return Object.entries(registrations).map(function(pair) {
        return {
            discordId: pair[0],
            gameUID: pair[1].gameUID,
            playerName: pair[1].playerName,
            registeredAt: pair[1].registeredAt
        };
    });
}

/**
 * Get count
 * @returns {number}
 */
function getCount() {
    return Object.keys(registrations).length;
}

module.exports = {
    load: load,
    save: save,
    register: register,
    unregister: unregister,
    getGameUID: getGameUID,
    getDiscordId: getDiscordId,
    getByDiscordId: getByDiscordId,
    isRegistered: isRegistered,
    getAll: getAll,
    getCount: getCount
};
