/**
 * Arma Reforger Whitelist System
 * Main Entry Point
 * 
 * This file initializes all system components:
 * - Discord Bot (role-based whitelist sync)
 * - RCON Handler (player monitoring and kick management)
 * - Web Dashboard (admin interface)
 */

require('dotenv').config();

const config = require('./config');
const whitelist = require('./database/whitelist');
const logger = require('./database/logger');
const registrations = require('./database/registrations');
const settings = require('./database/settings');
const whitelistCodes = require('./database/whitelistCodes');
const discordBot = require('./bot');
const rconHandler = require('./rcon');
const dashboard = require('./dashboard');

// Application state
let isShuttingDown = false;

/**
 * Starts all system components
 */
async function start() {
    console.log('==========================================');
    console.log('  Arma Reforger Whitelist System');
    console.log('  Version 1.0.0');
    console.log('==========================================');
    console.log('');

    // Validate configuration
    if (!validateConfig()) {
        console.error('[Main] Configuration validation failed. Please check your config.js or .env file.');
        process.exit(1);
    }

    try {
        // Initialize database
        console.log('[Main] Initializing database...');
        whitelist.loadWhitelist();
        logger.loadLogs();
        registrations.load();
        settings.load();
        whitelistCodes.load();
        console.log('[Main] Loaded ' + registrations.getCount() + ' registrations, ' + whitelistCodes.getCount() + ' whitelist codes, settings: whitelist=' + (settings.get('whitelistEnabled') ? 'ON' : 'OFF'));

        // Start Discord bot
        console.log('[Main] Starting Discord bot...');
        await discordBot.start();

        // Start RCON handler
        console.log('[Main] Starting RCON handler...');
        rconHandler.start();

        // Start dashboard
        console.log('[Main] Starting web dashboard...');
        await dashboard.start();

        console.log('');
        console.log('==========================================');
        console.log('  System Started Successfully');
        console.log('==========================================');
        console.log(`  Dashboard: http://localhost:${config.dashboardPort}`);
        console.log('==========================================');
        console.log('');

    } catch (error) {
        console.error('[Main] Failed to start:', error.message);
        process.exit(1);
    }
}

/**
 * Validates the configuration
 * @returns {boolean} Whether config is valid
 */
function validateConfig() {
    const warnings = [];
    const errors = [];

    if (!config.botToken) {
        warnings.push('BOT_TOKEN not set - Discord bot will not start');
    }

    if (!config.adminPassword) {
        warnings.push('ADMIN_PASSWORD not set - Dashboard login disabled');
    }

    if (!config.rconPassword) {
        warnings.push('RCON_PASSWORD not set - RCON will not connect');
    }

    if (config.sessionSecret === 'change-this-secret-in-production') {
        warnings.push('SESSION_SECRET should be changed for production');
    }

    // Log warnings
    warnings.forEach(w => console.warn(`[Config] Warning: ${w}`));

    // Log errors
    errors.forEach(e => console.error(`[Config] Error: ${e}`));

    return errors.length === 0;
}

/**
 * Gracefully shuts down all components
 */
async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('');
    console.log(`[Main] ${signal} received, shutting down gracefully...`);

    try {
        // Stop RCON handler first (to clear timers)
        console.log('[Main] Stopping RCON handler...');
        rconHandler.stop();

        // Stop Discord bot
        console.log('[Main] Stopping Discord bot...');
        await discordBot.stop();

        // Stop dashboard
        console.log('[Main] Stopping web dashboard...');
        await dashboard.stop();

        console.log('[Main] Shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('[Main] Error during shutdown:', error.message);
        process.exit(1);
    }
}

// Global error handlers
process.on('uncaughtException', (error) => {
    console.error('[Main] Uncaught Exception:', error.message);
    console.error(error.stack);
    // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Main] Unhandled Rejection at:', promise);
    console.error('[Main] Reason:', reason);
    // Don't exit - try to keep running
});

// Graceful shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Windows-specific handlers
if (process.platform === 'win32') {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.on('SIGINT', () => {
        process.emit('SIGINT');
    });
}

// Start the application
start().catch((error) => {
    console.error('[Main] Fatal error:', error);
    process.exit(1);
});
