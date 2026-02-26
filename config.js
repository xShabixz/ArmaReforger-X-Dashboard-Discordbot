/**
 * Configuration file for Arma Reforger Whitelist System
 * 
 * For security, sensitive values can be set via environment variables.
 * Create a .env file based on .env.example and set your values there.
 */

require('dotenv').config();

module.exports = {
    // Discord Bot Configuration
    botToken: process.env.BOT_TOKEN || "",
    guildId: process.env.GUILD_ID || "1476335079453097984",
    requiredRoleId: process.env.REQUIRED_ROLE_ID || "1476302643247972352",

    // Bot Admin IDs (comma-separated Discord User IDs)
    // If empty, admin commands use Discord permission check (Administrator) as before
    botAdminIds: (process.env.BOT_ADMIN_IDS || "").split(',').map(function(id) { return id.trim(); }).filter(Boolean),

    // Discord Channel IDs
    logChannelId: process.env.LOG_CHANNEL_ID || "",
    chatChannelId: process.env.CHAT_CHANNEL_ID || "",
    killfeedChannelId: process.env.KILLFEED_CHANNEL_ID || "",
    statusChannelId: process.env.STATUS_CHANNEL_ID || "",

    // Whitelist Request Role ID (users with this role can /requestwhitelist without a code)
    whitelistRequestRoleId: process.env.WHITELIST_REQUEST_ROLE_ID || "",

    // Allowed command channels (comma-separated Channel IDs)
    // If empty, commands work in all channels
    allowedCommandChannels: (process.env.ALLOWED_COMMAND_CHANNELS || "").split(',').map(function(id) { return id.trim(); }).filter(Boolean),

    // RCON Configuration
    rconHost: process.env.RCON_HOST || "127.0.0.1",
    rconPort: parseInt(process.env.RCON_PORT) || 19999,
    rconPassword: process.env.RCON_PASSWORD || "",

    // Dashboard Configuration
    dashboardPort: parseInt(process.env.DASHBOARD_PORT) || 20000,
    ownerPassword: process.env.OWNER_PASSWORD || "",
    adminPassword: process.env.ADMIN_PASSWORD || "",
    sessionSecret: process.env.SESSION_SECRET || "change-this-secret-in-production",

    // Timing Configuration
    kickDelaySeconds: 120,           // Kick delay for non-whitelisted players (in seconds)
    rconReconnectDelay: 5000,

    // Server Log Directory (for kill feed monitoring)
    // Path to the Arma Reforger server saves/logs directory
    serverLogDir: process.env.SERVER_LOG_DIR || '',

    // Paths
    databasePath: './database',
    whitelistFile: './database/whitelist.json',
    logsFile: './database/logs.json',
    registrationsFile: './database/registrations.json',
    settingsFile: './database/settings.json'
};
