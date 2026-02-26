/**
 * Whitelist Codes Module
 * Generate and manage whitelist invite codes from the dashboard.
 * Users can redeem codes via /requestwhitelist <code> in Discord.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

var codesFile = path.resolve(config.databasePath, 'whitelistCodes.json');
var codes = {};

function ensureDir() {
    var dbPath = path.resolve(config.databasePath);
    if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
    }
}

function load() {
    ensureDir();
    try {
        if (fs.existsSync(codesFile)) {
            var data = fs.readFileSync(codesFile, 'utf8');
            codes = JSON.parse(data);
            console.log('[WhitelistCodes] Loaded ' + Object.keys(codes).length + ' codes');
        } else {
            codes = {};
            save();
            console.log('[WhitelistCodes] Created new codes file');
        }
    } catch (error) {
        console.error('[WhitelistCodes] Error loading:', error.message);
        codes = {};
        save();
    }
    return codes;
}

function save() {
    ensureDir();
    try {
        fs.writeFileSync(codesFile, JSON.stringify(codes, null, 2), 'utf8');
    } catch (error) {
        console.error('[WhitelistCodes] Error saving:', error.message);
    }
}

/**
 * Generate a new whitelist code
 * @param {number} maxUses - Maximum number of times the code can be used (0 = unlimited)
 * @param {number} expiresInHours - Hours until expiry (0 = never)
 * @param {string} note - Optional note/label for this code
 * @returns {{ code: string }}
 */
function generate(maxUses, expiresInHours, note) {
    var code = generateCode();
    codes[code] = {
        createdAt: new Date().toISOString(),
        maxUses: maxUses || 0,
        uses: 0,
        usedBy: [],
        expiresAt: expiresInHours > 0 ? new Date(Date.now() + expiresInHours * 3600000).toISOString() : null,
        note: note || ''
    };
    save();
    console.log('[WhitelistCodes] Generated code: ' + code + ' (maxUses: ' + (maxUses || 'unlimited') + ', expires: ' + (expiresInHours > 0 ? expiresInHours + 'h' : 'never') + ')');
    return { code: code };
}

/**
 * Redeem a whitelist code
 * @param {string} code
 * @param {string} discordId
 * @param {string} playerName
 * @returns {{ success: boolean, error?: string }}
 */
function redeem(code, discordId, playerName) {
    var upper = code.toUpperCase();
    var entry = codes[upper];
    if (!entry) {
        return { success: false, error: 'โค้ดไม่ถูกต้อง (Invalid code)' };
    }

    // Check expiry
    if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
        return { success: false, error: 'โค้ดหมดอายุแล้ว (Code expired)' };
    }

    // Check max uses
    if (entry.maxUses > 0 && entry.uses >= entry.maxUses) {
        return { success: false, error: 'โค้ดถูกใช้ครบจำนวนแล้ว (Code fully used)' };
    }

    // Check if this discord user already used this code
    for (var i = 0; i < entry.usedBy.length; i++) {
        if (entry.usedBy[i].discordId === discordId) {
            return { success: false, error: 'คุณใช้โค้ดนี้ไปแล้ว (Already used this code)' };
        }
    }

    entry.uses++;
    entry.usedBy.push({
        discordId: discordId,
        playerName: playerName || null,
        usedAt: new Date().toISOString()
    });
    save();
    return { success: true };
}

/**
 * Remove a code
 * @param {string} code
 * @returns {boolean}
 */
function remove(code) {
    var upper = code.toUpperCase();
    if (codes[upper]) {
        delete codes[upper];
        save();
        return true;
    }
    return false;
}

/**
 * Get all codes as array
 * @returns {Array}
 */
function getAll() {
    return Object.entries(codes).map(function(pair) {
        var c = pair[0];
        var data = pair[1];
        var isExpired = data.expiresAt && new Date(data.expiresAt) < new Date();
        var isFullyUsed = data.maxUses > 0 && data.uses >= data.maxUses;
        return {
            code: c,
            createdAt: data.createdAt,
            maxUses: data.maxUses,
            uses: data.uses,
            usedBy: data.usedBy,
            expiresAt: data.expiresAt,
            note: data.note || '',
            status: isExpired ? 'expired' : (isFullyUsed ? 'used' : 'active')
        };
    });
}

/**
 * Get count
 * @returns {number}
 */
function getCount() {
    return Object.keys(codes).length;
}

/**
 * Generate a random 8-char code (uppercase letters + digits)
 * @returns {string}
 */
function generateCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I,O,0,1 to avoid confusion
    var code;
    do {
        code = '';
        for (var i = 0; i < 8; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (codes[code]);
    return code;
}

module.exports = {
    load: load,
    generate: generate,
    redeem: redeem,
    remove: remove,
    getAll: getAll,
    getCount: getCount
};
