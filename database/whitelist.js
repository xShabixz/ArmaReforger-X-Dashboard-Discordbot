/**
 * Whitelist Manager
 * Handles all whitelist operations with safe file access
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');

// In-memory cache of whitelist
let whitelist = {};

/**
 * Ensures the database directory exists
 */
function ensureDatabaseDir() {
    const dbPath = path.resolve(config.databasePath);
    if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
        console.log('[Whitelist] Created database directory');
    }
}

/**
 * Loads whitelist from JSON file
 * @returns {Object} The whitelist object
 */
function loadWhitelist() {
    ensureDatabaseDir();
    const filePath = path.resolve(config.whitelistFile);

    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            whitelist = JSON.parse(data);
            console.log(`[Whitelist] Loaded ${Object.keys(whitelist).length} entries`);
        } else {
            whitelist = {};
            saveWhitelist();
            console.log('[Whitelist] Created new whitelist file');
        }
    } catch (error) {
        console.error('[Whitelist] Error loading whitelist:', error.message);
        whitelist = {};
        saveWhitelist();
    }

    return whitelist;
}

/**
 * Saves whitelist to JSON file
 */
function saveWhitelist() {
    ensureDatabaseDir();
    const filePath = path.resolve(config.whitelistFile);

    try {
        fs.writeFileSync(filePath, JSON.stringify(whitelist, null, 2), 'utf8');
    } catch (error) {
        console.error('[Whitelist] Error saving whitelist:', error.message);
    }
}

/**
 * Adds a player to the whitelist
 * @param {string} playerId - The player's game ID (UID)
 * @param {string} discordId - The player's Discord ID
 * @returns {boolean} Success status
 */
function addToWhitelist(playerId, discordId, playerName) {
    if (!playerId) {
        console.error('[Whitelist] Invalid playerId');
        return false;
    }

    whitelist[playerId] = {
        discordId: discordId || null,
        playerName: playerName || null,
        addedAt: new Date().toISOString()
    };

    saveWhitelist();
    logger.log('role_sync_added', { playerId, discordId });
    console.log(`[Whitelist] Added player: ${playerId} (Discord: ${discordId})`);
    return true;
}

/**
 * Removes a player from the whitelist
 * @param {string} playerId - The player's game ID (UID)
 * @returns {boolean} Success status
 */
function removeFromWhitelist(playerId) {
    if (!playerId) {
        console.error('[Whitelist] Invalid playerId');
        return false;
    }

    if (whitelist[playerId]) {
        const discordId = whitelist[playerId].discordId;
        delete whitelist[playerId];
        saveWhitelist();
        logger.log('role_sync_removed', { playerId, discordId });
        console.log(`[Whitelist] Removed player: ${playerId}`);
        return true;
    }

    return false;
}

/**
 * Removes a player from whitelist by Discord ID
 * @param {string} discordId - The player's Discord ID
 * @returns {boolean} Success status
 */
function removeByDiscordId(discordId) {
    if (!discordId) {
        return false;
    }

    let removed = false;
    for (const [playerId, entry] of Object.entries(whitelist)) {
        if (entry.discordId === discordId) {
            delete whitelist[playerId];
            logger.log('role_sync_removed', { playerId, discordId });
            console.log(`[Whitelist] Removed player by Discord ID: ${playerId}`);
            removed = true;
        }
    }

    if (removed) {
        saveWhitelist();
    }

    return removed;
}

/**
 * Checks if a player is whitelisted
 * @param {string} playerId - The player's game ID (UID)
 * @returns {boolean} Whether the player is whitelisted
 */
function isWhitelisted(playerId) {
    return playerId && whitelist.hasOwnProperty(playerId);
}

/**
 * Gets the full whitelist
 * @returns {Object} The whitelist object
 */
function getWhitelist() {
    return { ...whitelist };
}

/**
 * Gets whitelist entry by Discord ID
 * @param {string} discordId - The Discord ID
 * @returns {Object|null} The whitelist entry or null
 */
function getByDiscordId(discordId) {
    for (const [playerId, entry] of Object.entries(whitelist)) {
        if (entry.discordId === discordId) {
            return { playerId, ...entry };
        }
    }
    return null;
}

/**
 * Gets whitelist count
 * @returns {number} Number of whitelisted players
 */
function getCount() {
    return Object.keys(whitelist).length;
}

/**
 * Gets all whitelist entries as an array
 * @returns {Array} Array of whitelist entries
 */
function getAll() {
    return Object.entries(whitelist).map(([playerId, entry]) => ({
        playerId,
        ...entry
    }));
}

module.exports = {
    loadWhitelist,
    addToWhitelist,
    removeFromWhitelist,
    removeByDiscordId,
    isWhitelisted,
    getWhitelist,
    getAll,
    getByDiscordId,
    getCount
};
