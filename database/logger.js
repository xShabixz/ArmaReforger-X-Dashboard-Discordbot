/**
 * Logger Module
 * Handles logging of events to JSON file
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// In-memory cache of logs
let logs = [];

// Maximum number of logs to keep in memory/file
const MAX_LOGS = 1000;

/**
 * Ensures the database directory exists
 */
function ensureDatabaseDir() {
    const dbPath = path.resolve(config.databasePath);
    if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
    }
}

/**
 * Loads logs from JSON file
 * @returns {Array} The logs array
 */
function loadLogs() {
    ensureDatabaseDir();
    const filePath = path.resolve(config.logsFile);

    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            logs = JSON.parse(data);
            console.log(`[Logger] Loaded ${logs.length} log entries`);
        } else {
            logs = [];
            saveLogs();
            console.log('[Logger] Created new logs file');
        }
    } catch (error) {
        console.error('[Logger] Error loading logs:', error.message);
        logs = [];
        saveLogs();
    }

    return logs;
}

/**
 * Saves logs to JSON file
 */
function saveLogs() {
    ensureDatabaseDir();
    const filePath = path.resolve(config.logsFile);

    try {
        // Keep only the most recent logs
        if (logs.length > MAX_LOGS) {
            logs = logs.slice(-MAX_LOGS);
        }
        fs.writeFileSync(filePath, JSON.stringify(logs, null, 2), 'utf8');
    } catch (error) {
        console.error('[Logger] Error saving logs:', error.message);
    }
}

/**
 * Logs an event
 * @param {string} type - Event type (player_joined, warning_sent, player_kicked, role_sync_added, role_sync_removed)
 * @param {Object} data - Event data
 */
function log(type, data = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        type: type,
        data: data
    };

    logs.push(entry);
    saveLogs();

    // Console output for visibility
    const dataStr = Object.keys(data).length > 0 ? ` - ${JSON.stringify(data)}` : '';
    console.log(`[Log] ${type}${dataStr}`);
}

/**
 * Gets all logs
 * @returns {Array} The logs array
 */
function getLogs() {
    return [...logs];
}

/**
 * Gets recent logs
 * @param {number} count - Number of recent logs to return
 * @returns {Array} Recent logs
 */
function getRecentLogs(count = 100) {
    return logs.slice(-count).reverse();
}

/**
 * Gets logs by type
 * @param {string} type - Event type to filter by
 * @returns {Array} Filtered logs
 */
function getLogsByType(type) {
    return logs.filter(entry => entry.type === type);
}

/**
 * Clears all logs
 */
function clearLogs() {
    logs = [];
    saveLogs();
    console.log('[Logger] Logs cleared');
}

module.exports = {
    loadLogs,
    log,
    getLogs,
    getRecentLogs,
    getLogsByType,
    clearLogs
};
