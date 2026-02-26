/**
 * Discord Bot Module
 * - /register & /unregister for linking Discord <-> Game UID
 * - /settings for toggling whitelist, chat bridge, etc.
 * - /broadcast for sending messages to all players
 * - Server log notifications, killfeed, chat bridge
 * - Bot activity status
 */

const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActivityType } = require('discord.js');
const config = require('../config');
const whitelist = require('../database/whitelist');
const logger = require('../database/logger');
const registrations = require('../database/registrations');
const settings = require('../database/settings');
const whitelistCodes = require('../database/whitelistCodes');
const rcon = require('../rcon');

var client = null;
var isReady = false;
var statusInterval = null;
var statusIndex = 0; // For rotating status messages
var statusEmbedMessageId = null; // For auto-updating server status embed
var statusEmbedInterval = null;
var statusEmbedChannelCleanedUp = false; // Track if we cleaned old status embeds on startup

// Verification code system: code -> { discordId, userName, expiry }
var pendingVerifications = new Map();

// --- Admin Authorization Check ---
function isAuthorizedAdmin(userId) {
    // If BOT_ADMIN_IDS is set, only those IDs can use admin commands
    if (config.botAdminIds && config.botAdminIds.length > 0) {
        return config.botAdminIds.indexOf(userId) !== -1;
    }
    // Fallback: allow if no admin IDs configured (uses Discord permission instead)
    return true;
}

// --- Slash Command Definitions ---
var commands = [
    // === USER COMMANDS ===
    new SlashCommandBuilder()
        .setName('register')
        .setDescription('Link your Discord account with your Game UID')
        .addStringOption(function(opt) {
            return opt.setName('game_uid').setDescription('Game UID (leave empty to use verification code)').setRequired(false);
        }),

    new SlashCommandBuilder()
        .setName('unregister')
        .setDescription('Unlink your Discord account from your Game UID'),

    new SlashCommandBuilder()
        .setName('mystatus')
        .setDescription('Check your registration and whitelist status'),

    new SlashCommandBuilder()
        .setName('requestwhitelist')
        .setDescription('Request whitelist access (requires role or invite code)')
        .addStringOption(function(opt) {
            return opt.setName('code').setDescription('Whitelist invite code (if you have one)').setRequired(false);
        }),

    // === ADMIN COMMANDS ===
    new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('Manage whitelist')
        .addSubcommand(function(sub) {
            return sub.setName('add')
                .setDescription('Add player to whitelist')
                .addStringOption(function(opt) { return opt.setName('player_id').setDescription('Game UID').setRequired(true); })
                .addStringOption(function(opt) { return opt.setName('name').setDescription('Player name (optional)').setRequired(false); });
        })
        .addSubcommand(function(sub) {
            return sub.setName('remove')
                .setDescription('Remove player from whitelist')
                .addStringOption(function(opt) { return opt.setName('player_id').setDescription('Game UID').setRequired(true); });
        })
        .addSubcommand(function(sub) {
            return sub.setName('check')
                .setDescription('Check if player is whitelisted')
                .addStringOption(function(opt) { return opt.setName('player_id').setDescription('Game UID').setRequired(true); });
        })
        .addSubcommand(function(sub) {
            return sub.setName('list')
                .setDescription('Show all whitelisted players');
        })
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Show system status')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('players')
        .setDescription('Show online players')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a player from the server')
        .addStringOption(function(opt) { return opt.setName('player_id').setDescription('Player ID').setRequired(true); })
        .addStringOption(function(opt) { return opt.setName('reason').setDescription('Reason').setRequired(false); })
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('rcon')
        .setDescription('Send RCON command')
        .addStringOption(function(opt) { return opt.setName('command').setDescription('RCON command').setRequired(true); })
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('sync')
        .setDescription('Sync whitelist with Discord roles')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('logs')
        .setDescription('Show recent logs')
        .addIntegerOption(function(opt) { return opt.setName('count').setDescription('Number of logs (default: 10)').setRequired(false); })
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('broadcast')
        .setDescription('Broadcast a message to all players in-game')
        .addStringOption(function(opt) { return opt.setName('message').setDescription('Message to broadcast').setRequired(true); })
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a player from the server')
        .addStringOption(function(opt) { return opt.setName('player_id').setDescription('Player UID or slot number').setRequired(true); })
        .addStringOption(function(opt) { return opt.setName('reason').setDescription('Ban reason').setRequired(false); })
        .addIntegerOption(function(opt) { return opt.setName('duration').setDescription('Duration in minutes (0 = permanent, default)').setRequired(false); })
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('unban')
        .setDescription('Unban a player')
        .addStringOption(function(opt) { return opt.setName('player_id').setDescription('Player UID to unban').setRequired(true); })
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Show server information (for everyone)'),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show all available commands'),

    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('View or toggle system settings')
        .addStringOption(function(opt) {
            return opt.setName('toggle').setDescription('Setting to toggle')
                .setRequired(false)
                .addChoices(
                    { name: 'Whitelist Enforcement', value: 'whitelistEnabled' },
                    { name: 'Auto-Kick', value: 'autoKickEnabled' },
                    { name: 'Chat Bridge', value: 'chatBridgeEnabled' },
                    { name: 'Killfeed', value: 'killfeedEnabled' },
                    { name: 'Join/Leave Notifications', value: 'joinLeaveNotifications' }
                );
        })
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// --- Register Slash Commands ---
async function registerCommands() {
    try {
        var rest = new REST({ version: '10' }).setToken(config.botToken);
        console.log('[Discord] Registering slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, config.guildId),
            { body: commands.map(function(c) { return c.toJSON(); }) }
        );
        console.log('[Discord] Registered ' + commands.length + ' slash commands');
    } catch (error) {
        console.error('[Discord] Failed to register commands:', error.message);
    }
}

// --- Bot Activity Status (Rotating Credit Messages + Player Count) ---
function updateBotStatus() {
    if (!client || !isReady) return;
    try {
        var messages = settings.get('statusMessages');
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            messages = ['Codex Team since 2015.', 'Contact DC\uD83D\uDCE7: alphabay911'];
        }

        // Add player count to rotation
        var playerCount = 0;
        try { playerCount = rcon.getConnectedPlayers().size; } catch (e) {}
        var rconConnected = false;
        try { rconConnected = rcon.getIsConnected(); } catch (e) {}

        var allMessages = messages.slice();
        if (rconConnected) {
            allMessages.push('\uD83C\uDFAE Online: ' + playerCount + ' players');
        } else {
            allMessages.push('\uD83D\uDD34 Server Offline');
        }

        var currentMsg = allMessages[statusIndex % allMessages.length];
        statusIndex++;

        client.user.setPresence({
            activities: [{ name: currentMsg, type: ActivityType.Custom, state: currentMsg }],
            status: 'online'
        });
    } catch (err) {
        console.error('[Discord] Error updating status:', err.message);
    }
}

// --- Send to Discord Channels ---
function sendToLogChannel(embed) {
    if (!config.logChannelId || !client || !isReady) return;
    try {
        var channel = client.channels.cache.get(config.logChannelId);
        if (channel) channel.send({ embeds: [embed] });
    } catch (err) { console.error('[Discord] Log channel error:', err.message); }
}

function sendToChatChannel(content) {
    if (!config.chatChannelId || !client || !isReady) return;
    if (!settings.get('chatBridgeEnabled')) return;
    try {
        var channel = client.channels.cache.get(config.chatChannelId);
        if (channel) channel.send(typeof content === 'string' ? content : content);
    } catch (err) { console.error('[Discord] Chat channel error:', err.message); }
}

function sendToKillfeedChannel(embed) {
    if (!config.killfeedChannelId || !client || !isReady) return;
    if (!settings.get('killfeedEnabled')) return;
    try {
        var channel = client.channels.cache.get(config.killfeedChannelId);
        if (channel) channel.send({ embeds: [embed] });
    } catch (err) { console.error('[Discord] Killfeed channel error:', err.message); }
}

// --- Auto-Updating Server Status Embed ---
async function updateServerStatusEmbed() {
    if (!config.statusChannelId || !client || !isReady) return;
    try {
        var channel = client.channels.cache.get(config.statusChannelId);
        if (!channel) return;

        var rconConnected = false;
        var playerCount = 0;
        var playerList = [];
        try {
            rconConnected = rcon.getIsConnected();
            var players = rcon.getConnectedPlayers();
            playerCount = players.size;
            for (var entry of players) {
                var id = entry[0];
                var info = entry[1];
                var isWL = whitelist.isWhitelisted(id);
                var mins = Math.floor((Date.now() - info.joinTime) / 60000);
                playerList.push((isWL ? '\u2705' : '\u274C') + ' **' + info.name + '** - ' + mins + ' min');
            }
        } catch (e) {}

        var whitelistCount = whitelist.getCount();
        var regCount = registrations.getCount();
        var uptimeSec = process.uptime();
        var hours = Math.floor(uptimeSec / 3600);
        var mins2 = Math.floor((uptimeSec % 3600) / 60);
        var allSettings = settings.getAll();

        var statusColor = rconConnected ? 0x57F287 : 0xED4245;
        var serverStatus = rconConnected ? '\uD83D\uDFE2 Online' : '\uD83D\uDD34 Offline';

        var embed = new EmbedBuilder()
            .setColor(statusColor)
            .setTitle('\uD83D\uDDA5\uFE0F Server Status')
            .setDescription('Real-time server information (auto-updates every 60s)')
            .addFields(
                { name: '\uD83C\uDF10 Server', value: serverStatus, inline: true },
                { name: '\uD83C\uDFAE Online Players', value: playerCount + ' player' + (playerCount !== 1 ? 's' : ''), inline: true },
                { name: '\uD83D\uDCCB Whitelisted', value: whitelistCount + '', inline: true },
                { name: '\uD83D\uDD17 Registered', value: regCount + '', inline: true },
                { name: '\u23F1\uFE0F Bot Uptime', value: hours + 'h ' + mins2 + 'm', inline: true },
                { name: '\uD83D\uDEE1\uFE0F RCON', value: rconConnected ? 'Connected' : 'Disconnected', inline: true }
            );

        // Settings status
        var settingsLine = (allSettings.whitelistEnabled ? '\u2705' : '\u274C') + ' Whitelist | ' +
            (allSettings.autoKickEnabled ? '\u2705' : '\u274C') + ' Auto-Kick | ' +
            (allSettings.chatBridgeEnabled ? '\u2705' : '\u274C') + ' Chat Bridge | ' +
            (allSettings.killfeedEnabled ? '\u2705' : '\u274C') + ' Killfeed | ' +
            (allSettings.joinLeaveNotifications ? '\u2705' : '\u274C') + ' Join/Leave';
        embed.addFields({ name: '\u2699\uFE0F Settings', value: settingsLine, inline: false });

        // Player list
        if (playerList.length > 0) {
            var listText = playerList.slice(0, 20).join('\n');
            if (playerList.length > 20) listText += '\n... and ' + (playerList.length - 20) + ' more';
            embed.addFields({ name: '\uD83D\uDC65 Player List', value: listText, inline: false });
        } else {
            embed.addFields({ name: '\uD83D\uDC65 Player List', value: rconConnected ? 'No players online' : 'Server offline', inline: false });
        }

        embed.setFooter({ text: 'Last updated' });
        embed.setTimestamp();

        // On first run, clean up old bot status embeds in this channel
        if (!statusEmbedChannelCleanedUp) {
            statusEmbedChannelCleanedUp = true;
            try {
                var oldMessages = await channel.messages.fetch({ limit: 20 });
                var botStatusMsgs = oldMessages.filter(function(m) {
                    return m.author.id === client.user.id && 
                           m.embeds.length > 0 && 
                           m.embeds[0].title && 
                           m.embeds[0].title.includes('Server Status');
                });
                for (var oldMsg of botStatusMsgs.values()) {
                    try { await oldMsg.delete(); } catch (e) {}
                }
                if (botStatusMsgs.size > 0) {
                    console.log('[Discord] Cleaned up ' + botStatusMsgs.size + ' old status embed(s)');
                }
            } catch (e) {
                console.error('[Discord] Error cleaning old status embeds:', e.message);
            }
        }

        // Edit existing message or send new one
        if (statusEmbedMessageId) {
            try {
                var msg = await channel.messages.fetch(statusEmbedMessageId);
                if (msg) {
                    await msg.edit({ embeds: [embed] });
                    return;
                }
            } catch (e) {
                // Message not found, send new
                statusEmbedMessageId = null;
            }
        }

        // Send new status message
        var sent = await channel.send({ embeds: [embed] });
        statusEmbedMessageId = sent.id;
        console.log('[Discord] Server status embed sent to channel ' + config.statusChannelId);
    } catch (err) {
        console.error('[Discord] Error updating server status embed:', err.message);
    }
}

// --- Setup RCON Event Listeners ---
function setupRconListeners() {
    rcon.on('connected', function() {
        updateBotStatus();
        updateServerStatusEmbed();
        sendToLogChannel(new EmbedBuilder().setColor(0x57F287).setTitle('Server Online').setDescription('RCON connection established').setTimestamp());
    });

    rcon.on('disconnected', function() {
        updateBotStatus();
        updateServerStatusEmbed();
        sendToLogChannel(new EmbedBuilder().setColor(0xED4245).setTitle('Server Offline').setDescription('RCON connection lost').setTimestamp());
    });

    rcon.on('players_updated', function(count) {
        updateBotStatus();
        updateServerStatusEmbed();
    });

    rcon.on('player_join', function(data) {
        updateBotStatus();
        updateServerStatusEmbed();
        if (!settings.get('joinLeaveNotifications')) return;
        var isWL = whitelist.isWhitelisted(data.playerId);
        var embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setAuthor({ name: 'Player Joined' })
            .setDescription('**' + data.playerName + '** joined the server')
            .addFields(
                { name: 'Game UID', value: '`' + data.playerId + '`', inline: true },
                { name: 'Whitelist', value: isWL ? 'Yes' : 'No', inline: true },
                { name: 'Online', value: rcon.getConnectedPlayers().size + ' players', inline: true }
            )
            .setTimestamp();
        sendToLogChannel(embed);
    });

    rcon.on('player_leave', function(data) {
        updateBotStatus();
        updateServerStatusEmbed();
        if (!settings.get('joinLeaveNotifications')) return;
        var embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setAuthor({ name: 'Player Left' })
            .setDescription('**' + data.playerName + '** left the server')
            .addFields(
                { name: 'Game UID', value: '`' + data.playerId + '`', inline: true },
                { name: 'Online', value: rcon.getConnectedPlayers().size + ' players', inline: true }
            )
            .setTimestamp();
        sendToLogChannel(embed);
    });

    rcon.on('player_kicked', function(data) {
        sendToLogChannel(new EmbedBuilder()
            .setColor(0xFEE75C)
            .setAuthor({ name: 'Player Kicked' })
            .setDescription('**' + data.playerName + '** was kicked')
            .addFields(
                { name: 'Game UID', value: '`' + data.playerId + '`', inline: true },
                { name: 'Reason', value: data.reason || 'N/A', inline: true }
            )
            .setTimestamp()
        );
    });

    rcon.on('warning_sent', function(data) {
        sendToLogChannel(new EmbedBuilder()
            .setColor(0xFEE75C)
            .setAuthor({ name: 'Whitelist Warning' })
            .setDescription('**' + data.playerName + '** is not whitelisted')
            .addFields({ name: 'Game UID', value: '`' + data.playerId + '`', inline: true })
            .setTimestamp()
        );
    });

    rcon.on('chat', function(data) {
        // Check for verification codes
        var msg = data.message.trim();
        if (/^\d{6}$/.test(msg) && data.playerId) {
            var pending = pendingVerifications.get(msg);
            if (pending && pending.expiry > Date.now()) {
                handleVerificationMatch(pending.discordId, pending.userName, data.playerId, data.playerName, msg);
                return; // Don't relay verification codes to chat channel
            }
        }

        sendToChatChannel('**' + data.playerName + ':** ' + data.message);
    });

    rcon.on('kill', function(data) {
        var embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setDescription('**' + data.killer + '** killed **' + data.victim + '**' + (data.weapon !== 'Unknown' ? ' with **' + data.weapon + '**' : ''))
            .setTimestamp();
        sendToKillfeedChannel(embed);
    });
}

// --- Creates Discord client ---
function createClient() {
    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildPresences,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    client.once(Events.ClientReady, function() {
        isReady = true;
        console.log('[Discord] Bot logged in as ' + client.user.tag);
        registerCommands();
        syncAllMembers();
        updateBotStatus();
        var intervalSec = settings.get('statusInterval') || 40;
        statusInterval = setInterval(updateBotStatus, intervalSec * 1000);
        setupRconListeners();

        // Auto-updating server status embed (every 60 seconds)
        setTimeout(function() { updateServerStatusEmbed(); }, 5000);
        statusEmbedInterval = setInterval(updateServerStatusEmbed, 60000);
    });

    // --- Slash Command Handler ---
    client.on(Events.InteractionCreate, async function(interaction) {
        if (!interaction.isChatInputCommand()) return;

        // Check allowed command channels
        if (config.allowedCommandChannels && config.allowedCommandChannels.length > 0) {
            if (config.allowedCommandChannels.indexOf(interaction.channelId) === -1) {
                return interaction.reply({ content: '\u274C คำสั่งนี้ใช้ได้เฉพาะใน Channel ที่กำหนดเท่านั้น', ephemeral: true });
            }
        }

        // Admin commands list
        var adminCommands = ['whitelist', 'status', 'players', 'kick', 'rcon', 'sync', 'logs', 'broadcast', 'settings', 'ban', 'unban'];

        // Check admin permission for admin commands
        if (adminCommands.indexOf(interaction.commandName) !== -1) {
            if (!isAuthorizedAdmin(interaction.user.id)) {
                return interaction.reply({ content: '\u274C You are not authorized to use this command.', ephemeral: true });
            }
        }

        try {
            switch (interaction.commandName) {
                case 'register': await handleRegisterCommand(interaction); break;
                case 'unregister': await handleUnregisterCommand(interaction); break;
                case 'mystatus': await handleMyStatusCommand(interaction); break;
                case 'requestwhitelist': await handleRequestWhitelistCommand(interaction); break;
                case 'whitelist': await handleWhitelistCommand(interaction); break;
                case 'status': await handleStatusCommand(interaction); break;
                case 'players': await handlePlayersCommand(interaction); break;
                case 'kick': await handleKickCommand(interaction); break;
                case 'rcon': await handleRconCommand(interaction); break;
                case 'sync': await handleSyncCommand(interaction); break;
                case 'logs': await handleLogsCommand(interaction); break;
                case 'broadcast': await handleBroadcastCommand(interaction); break;
                case 'settings': await handleSettingsCommand(interaction); break;
                case 'ban': await handleBanCommand(interaction); break;
                case 'unban': await handleUnbanCommand(interaction); break;
                case 'serverinfo': await handleServerInfoCommand(interaction); break;
                case 'help': await handleHelpCommand(interaction); break;
            }
        } catch (error) {
            console.error('[Discord] Command error:', error.message);
            var reply = { content: 'Error: ' + error.message, ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    });

    // --- Chat Bridge: Discord -> Game ---
    client.on(Events.MessageCreate, function(message) {
        try {
            if (message.author.bot) return;
            if (!config.chatChannelId) return;
            if (message.channel.id !== config.chatChannelId) return;
            if (!settings.get('chatBridgeEnabled')) return;

            if (rcon.getIsConnected()) {
                var senderName = message.member ? message.member.displayName : message.author.username;
                rcon.sendChatToGame(senderName, message.content);
                message.react('\u2705').catch(function() {});
            } else {
                message.react('\u274C').catch(function() {});
            }
        } catch (err) {
            console.error('[Discord] Chat bridge error:', err.message);
        }
    });

    // Member joins guild
    client.on(Events.GuildMemberAdd, function(member) {
        try {
            if (member.guild.id !== config.guildId) return;
            handleMemberUpdate(member);
        } catch (error) {
            console.error('[Discord] guildMemberAdd error:', error.message);
        }
    });

    // Member role changes
    client.on(Events.GuildMemberUpdate, function(oldMember, newMember) {
        try {
            if (newMember.guild.id !== config.guildId) return;
            var hadRole = oldMember.roles.cache.has(config.requiredRoleId);
            var hasRole = newMember.roles.cache.has(config.requiredRoleId);

            if (hadRole !== hasRole) {
                handleMemberUpdate(newMember);

                if (hasRole) {
                    sendToLogChannel(new EmbedBuilder().setColor(0x5865F2).setAuthor({ name: 'Whitelist Role Added' })
                        .setDescription('**' + newMember.user.tag + '** received the whitelist role').setTimestamp());
                } else {
                    sendToLogChannel(new EmbedBuilder().setColor(0xEB459E).setAuthor({ name: 'Whitelist Role Removed' })
                        .setDescription('**' + newMember.user.tag + '** lost the whitelist role').setTimestamp());
                }
            }
        } catch (error) {
            console.error('[Discord] guildMemberUpdate error:', error.message);
        }
    });

    // Member leaves guild
    client.on(Events.GuildMemberRemove, function(member) {
        try {
            if (member.guild.id !== config.guildId) return;

            // Remove whitelist entry by Discord ID
            var gameUID = registrations.getGameUID(member.id);
            if (gameUID && whitelist.isWhitelisted(gameUID)) {
                whitelist.removeFromWhitelist(gameUID);
                console.log('[Discord] Member left, removed from whitelist: ' + member.user.tag + ' (UID: ' + gameUID + ')');
            }
            // Also check old-style discord ID entries
            var entry = whitelist.getByDiscordId(member.id);
            if (entry) {
                whitelist.removeFromWhitelist(entry.playerId);
            }

            sendToLogChannel(new EmbedBuilder().setColor(0xEB459E).setAuthor({ name: 'Member Left' })
                .setDescription('**' + member.user.tag + '** left Discord').setTimestamp());
        } catch (error) {
            console.error('[Discord] guildMemberRemove error:', error.message);
        }
    });

    client.on(Events.Error, function(error) {
        console.error('[Discord] Client error:', error.message);
    });

    return client;
}

// --- Handle member update (role change) ---
function handleMemberUpdate(member) {
    var hasRole = member.roles.cache.has(config.requiredRoleId);
    var discordId = member.id;

    // Use registered Game UID if available, otherwise fall back to Discord ID
    var gameUID = registrations.getGameUID(discordId);
    var playerId = gameUID || discordId;

    if (hasRole) {
        if (!whitelist.isWhitelisted(playerId)) {
            var reg = registrations.getByDiscordId(discordId);
            var playerName = (reg && reg.playerName) ? reg.playerName : member.user.username;
            whitelist.addToWhitelist(playerId, discordId, playerName);
            console.log('[Discord] Added to whitelist: ' + member.user.tag + ' -> ' + playerId);

            // Cancel any pending kick in RCON
            rcon.cancelPendingKick(playerId);
        }
    } else {
        if (whitelist.isWhitelisted(playerId)) {
            whitelist.removeFromWhitelist(playerId);
            console.log('[Discord] Removed from whitelist: ' + member.user.tag + ' -> ' + playerId);
        }
    }
}

// --- Sync all members ---
async function syncAllMembers() {
    try {
        var guild = client.guilds.cache.get(config.guildId);
        if (!guild) {
            console.error('[Discord] Guild not found:', config.guildId);
            return;
        }

        console.log('[Discord] Starting member sync...');
        var members = await guild.members.fetch();
        var addedCount = 0;
        var removedCount = 0;

        for (var entry of members) {
            var member = entry[1];
            var hasRole = member.roles.cache.has(config.requiredRoleId);
            var discordId = member.id;

            var gameUID = registrations.getGameUID(discordId);
            var playerId = gameUID || discordId;

            if (hasRole && !whitelist.isWhitelisted(playerId)) {
                var reg = registrations.getByDiscordId(discordId);
                var playerName = (reg && reg.playerName) ? reg.playerName : member.user.username;
                whitelist.addToWhitelist(playerId, discordId, playerName);
                addedCount++;
            } else if (!hasRole && whitelist.isWhitelisted(playerId)) {
                whitelist.removeFromWhitelist(playerId);
                removedCount++;
            }
        }

        console.log('[Discord] Sync complete - Added: ' + addedCount + ', Removed: ' + removedCount);
    } catch (error) {
        console.error('[Discord] Error syncing members:', error.message);
    }
}

// =======================================================
// COMMAND HANDLERS
// =======================================================

// --- Generate 6-digit verification code ---
function generateVerifyCode() {
    var code;
    do {
        code = String(Math.floor(100000 + Math.random() * 900000));
    } while (pendingVerifications.has(code));
    return code;
}

// --- Cleanup expired verification codes ---
function cleanupVerifications() {
    var now = Date.now();
    for (var entry of pendingVerifications) {
        if (entry[1].expiry < now) pendingVerifications.delete(entry[0]);
    }
}

// --- Handle verification match (called when player types code in game chat) ---
async function handleVerificationMatch(discordId, userName, gameUID, gameName, code) {
    try {
        pendingVerifications.delete(code);

        var playerName = gameName || userName;
        var result = registrations.register(discordId, gameUID, playerName);

        if (!result.success) {
            console.log('[Verify] Registration failed for ' + discordId + ': ' + result.error);
            return;
        }

        logger.log('player_registered', { discordId: discordId, gameUID: gameUID, playerName: playerName, method: 'verification' });
        console.log('[Verify] Verified! ' + userName + ' -> ' + gameUID + ' (' + gameName + ')');

        // Auto-add to whitelist if user has the required role
        var hasRole = false;
        try {
            var guild = client.guilds.cache.get(config.guildId);
            if (guild) {
                var member = await guild.members.fetch(discordId).catch(function() { return null; });
                if (member) {
                    hasRole = member.roles.cache.has(config.requiredRoleId);
                }
            }
        } catch (e) {}

        if (hasRole) {
            whitelist.addToWhitelist(gameUID, discordId, playerName);
            rcon.cancelPendingKick(gameUID);
        }

        // Send confirmation to game chat
        rcon.sendChatToGame('BOT', 'Verified! ' + gameName + ' is now linked to Discord.');

        // Notify log channel
        sendToLogChannel(new EmbedBuilder().setColor(0x57F287).setAuthor({ name: 'Player Verified' })
            .setDescription('**' + userName + '** verified via in-game code\nGame UID: `' + gameUID + '` | In-game: **' + gameName + '**' + (hasRole ? ' (auto-whitelisted)' : ''))
            .setTimestamp());

        // DM the user
        try {
            var user = await client.users.fetch(discordId);
            if (user) {
                var dmEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('\u2705 Verification Successful!')
                    .setDescription('Your Discord account has been linked to your game account.')
                    .addFields(
                        { name: 'Game UID', value: '`' + gameUID + '`', inline: true },
                        { name: 'In-game Name', value: gameName, inline: true },
                        { name: 'Whitelist', value: hasRole ? 'Auto-added \u2705' : 'Need whitelist role', inline: true }
                    )
                    .setTimestamp();
                user.send({ embeds: [dmEmbed] }).catch(function() {});
            }
        } catch (e) {}

    } catch (err) {
        console.error('[Verify] Error:', err.message);
    }
}

// --- /register ---
async function handleRegisterCommand(interaction) {
    var gameUIDInput = interaction.options.getString('game_uid');
    var discordId = interaction.user.id;

    // Check if already registered
    var existing = registrations.getByDiscordId(discordId);
    if (existing) {
        return interaction.reply({
            content: 'You are already registered with Game UID: `' + existing.gameUID + '`\nUse `/unregister` first to change your UID.',
            ephemeral: true
        });
    }

    // ========== MODE 1: Direct UID registration ==========
    if (gameUIDInput) {
        var gameUID = gameUIDInput.trim();
        if (gameUID.length < 5) {
            return interaction.reply({ content: 'Game UID is too short. Please enter a valid UID.', ephemeral: true });
        }

        var playerName = interaction.member ? interaction.member.displayName : interaction.user.username;
        var result = registrations.register(discordId, gameUID, playerName);

        if (!result.success) {
            return interaction.reply({ content: 'Registration failed: ' + result.error, ephemeral: true });
        }

        logger.log('player_registered', { discordId: discordId, gameUID: gameUID, playerName: playerName, method: 'direct' });

        // Auto-add to whitelist if user has the required role
        var hasRole = false;
        try {
            var guild = client.guilds.cache.get(config.guildId);
            if (guild) {
                var member = await guild.members.fetch(discordId).catch(function() { return null; });
                if (member) {
                    hasRole = member.roles.cache.has(config.requiredRoleId);
                }
            }
        } catch (e) {}

        var autoWhitelisted = false;
        if (hasRole) {
            whitelist.addToWhitelist(gameUID, discordId, playerName);
            rcon.cancelPendingKick(gameUID);
            autoWhitelisted = true;
        }

        var embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('\u2705 Registration Successful')
            .setDescription('Your Discord account has been linked to your Game UID')
            .addFields(
                { name: 'Game UID', value: '`' + gameUID + '`', inline: true },
                { name: 'Discord', value: interaction.user.tag, inline: true },
                { name: 'Whitelist', value: autoWhitelisted ? 'Auto-added (you have the role)' : 'Not yet - need whitelist role', inline: false }
            )
            .setTimestamp();

        sendToLogChannel(new EmbedBuilder().setColor(0x5865F2).setAuthor({ name: 'Player Registered' })
            .setDescription('**' + interaction.user.tag + '** registered Game UID: `' + gameUID + '`' + (autoWhitelisted ? ' (auto-whitelisted)' : ''))
            .setTimestamp());

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ========== MODE 2: Verification Code ==========
    if (!rcon.getIsConnected()) {
        return interaction.reply({
            content: '\u274C Server is offline. Please use `/register game_uid:YOUR_UID` instead.\n\n**How to find your Game UID:**\n1. Go to https://steamid.io\n2. Enter your Steam profile URL\n3. Copy the **steamID64** number',
            ephemeral: true
        });
    }

    cleanupVerifications();

    // Check if user already has a pending code
    for (var entry of pendingVerifications) {
        if (entry[1].discordId === discordId && entry[1].expiry > Date.now()) {
            var remainSec = Math.floor((entry[1].expiry - Date.now()) / 1000);
            return interaction.reply({
                content: '\u23F3 You already have a pending verification code: **' + entry[0] + '**\nType this code in the **game chat** within ' + remainSec + 's.',
                ephemeral: true
            });
        }
    }

    // Generate new code
    var code = generateVerifyCode();
    var userName = interaction.member ? interaction.member.displayName : interaction.user.username;
    pendingVerifications.set(code, {
        discordId: discordId,
        userName: userName,
        expiry: Date.now() + 180000 // 3 minutes
    });

    console.log('[Verify] Code ' + code + ' generated for ' + userName + ' (' + discordId + ')');

    var embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('\uD83D\uDD10 Verification Code')
        .setDescription('To link your account, type this code in the **game chat**:')
        .addFields(
            { name: 'Your Code', value: '```\n' + code + '\n```', inline: false },
            { name: 'How to verify', value: '1\uFE0F\u20E3 Make sure you are **in the game server**\n2\uFE0F\u20E3 Open the **game chat** (press Enter)\n3\uFE0F\u20E3 Type **' + code + '** and send it\n4\uFE0F\u20E3 The bot will automatically link your accounts!', inline: false },
            { name: 'Expires', value: '3 minutes', inline: true }
        )
        .setFooter({ text: 'Or use /register game_uid:YOUR_UID if you know your Game UID' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
}

// --- /unregister ---
async function handleUnregisterCommand(interaction) {
    var discordId = interaction.user.id;
    var existing = registrations.getByDiscordId(discordId);

    if (!existing) {
        return interaction.reply({ content: 'You are not registered. Use `/register` to link your Game UID.', ephemeral: true });
    }

    var gameUID = existing.gameUID;

    // Remove from whitelist if present
    if (whitelist.isWhitelisted(gameUID)) {
        whitelist.removeFromWhitelist(gameUID);
    }

    registrations.unregister(discordId);
    logger.log('player_unregistered', { discordId: discordId, gameUID: gameUID });

    sendToLogChannel(new EmbedBuilder().setColor(0xEB459E).setAuthor({ name: 'Player Unregistered' })
        .setDescription('**' + interaction.user.tag + '** unregistered Game UID: `' + gameUID + '`')
        .setTimestamp());

    return interaction.reply({
        content: 'Successfully unregistered. Your Game UID `' + gameUID + '` has been unlinked and removed from whitelist.',
        ephemeral: true
    });
}

// --- /mystatus ---
async function handleMyStatusCommand(interaction) {
    var discordId = interaction.user.id;
    var reg = registrations.getByDiscordId(discordId);
    var hasRole = false;

    try {
        var guild = client.guilds.cache.get(config.guildId);
        if (guild) {
            var member = await guild.members.fetch(discordId).catch(function() { return null; });
            if (member) hasRole = member.roles.cache.has(config.requiredRoleId);
        }
    } catch (e) {}

    var isWL = false;
    var gameUID = 'Not registered';
    if (reg) {
        gameUID = reg.gameUID;
        isWL = whitelist.isWhitelisted(reg.gameUID);
    }

    var embed = new EmbedBuilder()
        .setColor(isWL ? 0x57F287 : 0xFFAA00)
        .setTitle('Your Status')
        .addFields(
            { name: 'Discord', value: interaction.user.tag, inline: true },
            { name: 'Game UID', value: reg ? '`' + gameUID + '`' : 'Not registered', inline: true },
            { name: 'Whitelist Role', value: hasRole ? 'Yes' : 'No', inline: true },
            { name: 'Whitelisted', value: isWL ? 'Yes' : 'No', inline: true },
            { name: 'Registered', value: reg ? new Date(reg.registeredAt).toLocaleDateString() : 'No', inline: true }
        )
        .setTimestamp();

    if (!reg) {
        embed.setFooter({ text: 'Use /register <game_uid> to link your account' });
    } else if (!hasRole) {
        embed.setFooter({ text: 'You need the whitelist role to play on the server' });
    }

    return interaction.reply({ embeds: [embed], ephemeral: true });
}

// --- /requestwhitelist ---
async function handleRequestWhitelistCommand(interaction) {
    var discordId = interaction.user.id;
    var codeInput = interaction.options.getString('code');

    // Must be registered first
    var reg = registrations.getByDiscordId(discordId);
    if (!reg) {
        return interaction.reply({
            content: '\u274C คุณยังไม่ได้ลงทะเบียน กรุณาใช้ `/register` เพื่อเชื่อมต่อ Game UID ก่อน',
            ephemeral: true
        });
    }

    var gameUID = reg.gameUID;
    var playerName = reg.playerName || interaction.user.username;

    // Already whitelisted?
    if (whitelist.isWhitelisted(gameUID)) {
        return interaction.reply({
            content: '\u2705 คุณอยู่ในไวท์ลิสต์แล้ว! (Game UID: `' + gameUID + '`)',
            ephemeral: true
        });
    }

    // --- PATH 1: Using invite code ---
    if (codeInput) {
        var result = whitelistCodes.redeem(codeInput.trim(), discordId, playerName);
        if (!result.success) {
            return interaction.reply({ content: '\u274C ' + result.error, ephemeral: true });
        }

        whitelist.addToWhitelist(gameUID, discordId, playerName);
        rcon.cancelPendingKick(gameUID);
        logger.log('whitelist_code_redeemed', { discordId: discordId, gameUID: gameUID, playerName: playerName, code: codeInput.trim().toUpperCase() });

        sendToLogChannel(new EmbedBuilder().setColor(0x57F287).setAuthor({ name: 'Whitelist Code Redeemed' })
            .setDescription('**' + interaction.user.tag + '** ใช้โค้ด `' + codeInput.trim().toUpperCase() + '` เข้าไวท์ลิสต์\nGame UID: `' + gameUID + '`')
            .setTimestamp());

        var embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('\u2705 เข้าไวท์ลิสต์สำเร็จ!')
            .setDescription('คุณได้ใช้โค้ดเพื่อเข้าไวท์ลิสต์แล้ว')
            .addFields(
                { name: 'Game UID', value: '`' + gameUID + '`', inline: true },
                { name: 'วิธี', value: 'โค้ดเชิญ', inline: true }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // --- PATH 2: Using role ---
    if (!config.whitelistRequestRoleId) {
        return interaction.reply({
            content: '\u274C ระบบขอไวท์ลิสต์ยังไม่ได้ตั้งค่า Role กรุณาใช้โค้ดเชิญแทน\n`/requestwhitelist code:YOUR_CODE`',
            ephemeral: true
        });
    }

    var hasRole = false;
    try {
        var guild = client.guilds.cache.get(config.guildId);
        if (guild) {
            var member = await guild.members.fetch(discordId).catch(function() { return null; });
            if (member) {
                hasRole = member.roles.cache.has(config.whitelistRequestRoleId);
            }
        }
    } catch (e) {}

    if (!hasRole) {
        return interaction.reply({
            content: '\u274C คุณไม่มียศที่กำหนด ไม่สามารถขอไวท์ลิสต์ได้\nหากมีโค้ดเชิญ ให้ใช้: `/requestwhitelist code:YOUR_CODE`',
            ephemeral: true
        });
    }

    // Has the role -> add to whitelist
    whitelist.addToWhitelist(gameUID, discordId, playerName);
    rcon.cancelPendingKick(gameUID);
    logger.log('whitelist_role_request', { discordId: discordId, gameUID: gameUID, playerName: playerName });

    sendToLogChannel(new EmbedBuilder().setColor(0x57F287).setAuthor({ name: 'Whitelist Requested' })
        .setDescription('**' + interaction.user.tag + '** ขอไวท์ลิสต์ด้วยยศ\nGame UID: `' + gameUID + '`')
        .setTimestamp());

    var embed2 = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('\u2705 เข้าไวท์ลิสต์สำเร็จ!')
        .setDescription('คุณได้รับสิทธิ์เข้าไวท์ลิสต์แล้ว')
        .addFields(
            { name: 'Game UID', value: '`' + gameUID + '`', inline: true },
            { name: 'วิธี', value: 'ยศ Discord', inline: true }
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed2], ephemeral: true });
}

// --- /settings ---
async function handleSettingsCommand(interaction) {
    var toggleKey = interaction.options.getString('toggle');

    // If toggle key provided, toggle it
    if (toggleKey) {
        var result = settings.toggle(toggleKey);
        if (!result.success) {
            return interaction.reply({ content: 'Unknown setting: ' + toggleKey, ephemeral: true });
        }

        logger.log('settings_changed', { key: toggleKey, value: result.value, by: interaction.user.tag });

        sendToLogChannel(new EmbedBuilder().setColor(0xFFAA00).setAuthor({ name: 'Settings Changed' })
            .setDescription('**' + interaction.user.tag + '** toggled **' + toggleKey + '** -> ' + (result.value ? 'ON' : 'OFF'))
            .setTimestamp());

        // Fall through to show current settings
    }

    var all = settings.getAll();

    var embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('System Settings')
        .addFields(
            { name: 'Whitelist Enforcement', value: all.whitelistEnabled ? 'ON' : 'OFF', inline: true },
            { name: 'Auto-Kick', value: all.autoKickEnabled ? 'ON' : 'OFF', inline: true },
            { name: 'Chat Bridge', value: all.chatBridgeEnabled ? 'ON' : 'OFF', inline: true },
            { name: 'Killfeed', value: all.killfeedEnabled ? 'ON' : 'OFF', inline: true },
            { name: 'Join/Leave Notify', value: all.joinLeaveNotifications ? 'ON' : 'OFF', inline: true },
            { name: 'Kick Delay', value: all.kickDelaySeconds + 's', inline: true }
        )
        .setFooter({ text: 'Use /settings toggle:<setting> to toggle ON/OFF' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
}

// --- /broadcast ---
async function handleBroadcastCommand(interaction) {
    if (!rcon.getIsConnected()) {
        return interaction.reply({ content: 'RCON not connected', ephemeral: true });
    }

    var message = interaction.options.getString('message');
    rcon.sendCommand('say -1 [BROADCAST] ' + message);
    logger.log('admin_broadcast', { message: message, by: interaction.user.tag });

    sendToLogChannel(new EmbedBuilder().setColor(0xFEE75C).setAuthor({ name: 'Broadcast' })
        .setDescription('**' + interaction.user.tag + '** broadcasted: ' + message)
        .setTimestamp());

    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('Broadcast Sent').setDescription(message)
            .setFooter({ text: 'By ' + interaction.user.tag }).setTimestamp()],
        ephemeral: true
    });
}

// --- /whitelist ---
async function handleWhitelistCommand(interaction) {
    var sub = interaction.options.getSubcommand();

    if (sub === 'add') {
        var playerId = interaction.options.getString('player_id');
        var name = interaction.options.getString('name') || 'Unknown';

        if (whitelist.isWhitelisted(playerId)) {
            return interaction.reply({ content: 'Player `' + playerId + '` is already whitelisted', ephemeral: true });
        }

        whitelist.addToWhitelist(playerId, null, name);
        logger.log('manual_add', { playerId: playerId, playerName: name, addedBy: interaction.user.tag });
        rcon.cancelPendingKick(playerId);

        sendToLogChannel(new EmbedBuilder().setColor(0x5865F2).setAuthor({ name: 'Admin Action' })
            .setDescription('**' + interaction.user.tag + '** added `' + playerId + '` (' + name + ') to whitelist').setTimestamp());

        return interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('Added to Whitelist')
                .addFields(
                    { name: 'Game UID', value: '`' + playerId + '`', inline: true },
                    { name: 'Name', value: name, inline: true },
                    { name: 'Added by', value: interaction.user.tag, inline: true }
                ).setTimestamp()]
        });
    }

    if (sub === 'remove') {
        var playerId2 = interaction.options.getString('player_id');
        if (!whitelist.isWhitelisted(playerId2)) {
            return interaction.reply({ content: 'Player `' + playerId2 + '` is not in whitelist', ephemeral: true });
        }

        whitelist.removeFromWhitelist(playerId2);
        logger.log('manual_remove', { playerId: playerId2, removedBy: interaction.user.tag });

        sendToLogChannel(new EmbedBuilder().setColor(0xED4245).setAuthor({ name: 'Admin Action' })
            .setDescription('**' + interaction.user.tag + '** removed `' + playerId2 + '` from whitelist').setTimestamp());

        return interaction.reply({
            embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('Removed from Whitelist')
                .addFields(
                    { name: 'Game UID', value: '`' + playerId2 + '`', inline: true },
                    { name: 'Removed by', value: interaction.user.tag, inline: true }
                ).setTimestamp()]
        });
    }

    if (sub === 'check') {
        var playerId3 = interaction.options.getString('player_id');
        var isWL = whitelist.isWhitelisted(playerId3);
        return interaction.reply({
            embeds: [new EmbedBuilder().setColor(isWL ? 0x00FF00 : 0xFF0000).setTitle('Whitelist Check')
                .addFields(
                    { name: 'Game UID', value: '`' + playerId3 + '`', inline: true },
                    { name: 'Status', value: isWL ? 'Whitelisted' : 'Not Whitelisted', inline: true }
                ).setTimestamp()],
            ephemeral: true
        });
    }

    if (sub === 'list') {
        var all = whitelist.getAll();
        if (all.length === 0) {
            return interaction.reply({ content: 'Whitelist is empty', ephemeral: true });
        }

        var pageSize = 20;
        var page = all.slice(0, pageSize);
        var list = page.map(function(entry, i) {
            var name2 = entry.playerName || entry.discordId || 'N/A';
            return '`' + (i + 1) + '.` ' + entry.playerId + ' - ' + name2;
        }).join('\n');

        return interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x0099FF).setTitle('Whitelist (' + all.length + ' players)')
                .setDescription(list)
                .setFooter({ text: all.length > pageSize ? 'Showing first ' + pageSize + ' of ' + all.length : 'Total: ' + all.length })
                .setTimestamp()],
            ephemeral: true
        });
    }
}

async function handleStatusCommand(interaction) {
    var rconStatus = rcon.getIsConnected();
    var playerCount = rcon.getConnectedPlayers().size;
    var whitelistCount = whitelist.getAll().length;
    var regCount = registrations.getCount();
    var pendingKicks = rcon.getPendingKicks().length;
    var uptimeSec = process.uptime();
    var hours = Math.floor(uptimeSec / 3600);
    var mins = Math.floor((uptimeSec % 3600) / 60);
    var allSettings = settings.getAll();

    var embed = new EmbedBuilder()
        .setColor(rconStatus ? 0x00FF00 : 0xFFAA00)
        .setTitle('System Status')
        .addFields(
            { name: 'Discord Bot', value: 'Online', inline: true },
            { name: 'RCON', value: rconStatus ? 'Connected' : 'Disconnected', inline: true },
            { name: 'Online Players', value: playerCount + '', inline: true },
            { name: 'Whitelisted', value: whitelistCount + '', inline: true },
            { name: 'Registered', value: regCount + '', inline: true },
            { name: 'Pending Kicks', value: pendingKicks + '', inline: true },
            { name: 'Whitelist', value: allSettings.whitelistEnabled ? 'ON' : 'OFF', inline: true },
            { name: 'Auto-Kick', value: allSettings.autoKickEnabled ? 'ON' : 'OFF', inline: true },
            { name: 'Uptime', value: hours + 'h ' + mins + 'm', inline: true }
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handlePlayersCommand(interaction) {
    var players = rcon.getConnectedPlayers();
    if (players.size === 0) {
        return interaction.reply({ content: 'No players online (or RCON not connected)', ephemeral: true });
    }

    var list = '';
    for (var entry of players) {
        var id = entry[0];
        var info = entry[1];
        var wlStatus = whitelist.isWhitelisted(id) ? 'WL' : 'NO';
        var mins = Math.floor((Date.now() - info.joinTime) / 60000);
        list += '[' + wlStatus + '] `' + id + '` - ' + info.name + ' (' + mins + 'min)\n';
    }

    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x0099FF).setTitle('Online Players (' + players.size + ')')
            .setDescription(list).setFooter({ text: 'WL = Whitelisted, NO = Not Whitelisted' }).setTimestamp()],
        ephemeral: true
    });
}

async function handleKickCommand(interaction) {
    if (!rcon.getIsConnected()) {
        return interaction.reply({ content: 'RCON not connected', ephemeral: true });
    }
    var playerInput = interaction.options.getString('player_id');
    var reason = interaction.options.getString('reason') || 'Kicked by admin';

    // Try to find player by UID or name to get BattlEye slot#
    var slotIndex = -1;
    var playerName = playerInput;
    var playerId = playerInput;
    var players = rcon.getConnectedPlayers();

    // Check if input is a slot number directly
    if (/^\d+$/.test(playerInput) && parseInt(playerInput) < 100) {
        slotIndex = parseInt(playerInput);
        // Find player info by slot
        for (var entry of players) {
            if (entry[1].slotIndex === slotIndex) {
                playerId = entry[0];
                playerName = entry[1].name;
                break;
            }
        }
    } else {
        // Search by UID
        var data = players.get(playerInput);
        if (data) {
            slotIndex = data.slotIndex >= 0 ? data.slotIndex : -1;
            playerName = data.name;
        } else {
            // Search by name (partial match)
            for (var entry2 of players) {
                if (entry2[1].name.toLowerCase().includes(playerInput.toLowerCase())) {
                    playerId = entry2[0];
                    playerName = entry2[1].name;
                    slotIndex = entry2[1].slotIndex >= 0 ? entry2[1].slotIndex : -1;
                    break;
                }
            }
        }
    }

    if (slotIndex >= 0) {
        rcon.sendCommand('kick ' + slotIndex + ' ' + reason);
    } else {
        // Fallback: try raw command
        rcon.sendCommand('kick ' + playerInput + ' ' + reason);
    }

    logger.log('admin_kick', { playerId: playerId, playerName: playerName, reason: reason, kickedBy: interaction.user.tag });

    sendToLogChannel(new EmbedBuilder().setColor(0xFEE75C).setAuthor({ name: 'Admin Kick' })
        .setDescription('**' + interaction.user.tag + '** kicked **' + playerName + '** (`' + playerId + '`) - ' + reason).setTimestamp());

    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('Player Kicked')
            .addFields(
                { name: 'Player', value: playerName + ' (`' + playerId + '`)', inline: true },
                { name: 'Slot #', value: slotIndex >= 0 ? '#' + slotIndex : 'N/A', inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'By', value: interaction.user.tag, inline: true }
            ).setTimestamp()]
    });
}

async function handleRconCommand(interaction) {
    if (!rcon.getIsConnected()) {
        return interaction.reply({ content: 'RCON not connected', ephemeral: true });
    }
    var command = interaction.options.getString('command');
    rcon.sendCommand(command);
    logger.log('admin_rcon', { command: command, by: interaction.user.tag });

    sendToLogChannel(new EmbedBuilder().setColor(0xFFAA00).setAuthor({ name: 'Admin RCON' })
        .setDescription('**' + interaction.user.tag + '** sent RCON: `' + command + '`').setTimestamp());

    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFFAA00).setTitle('RCON Command Sent').setDescription('`' + command + '`')
            .setFooter({ text: 'By ' + interaction.user.tag }).setTimestamp()],
        ephemeral: true
    });
}

async function handleSyncCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });
    await syncAllMembers();
    return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('Sync Complete')
            .setDescription('Whitelist synced with Discord roles\nTotal: ' + whitelist.getAll().length + ' players').setTimestamp()]
    });
}

async function handleLogsCommand(interaction) {
    var count = interaction.options.getInteger('count') || 10;
    var allLogs = logger.getLogs ? logger.getLogs() : [];
    var recent = allLogs.slice(-count).reverse();

    if (recent.length === 0) {
        return interaction.reply({ content: 'No logs', ephemeral: true });
    }

    var list = recent.map(function(log) {
        var time = new Date(log.timestamp).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
        var type = log.type || 'unknown';
        var detail = '';
        if (log.data) {
            if (log.data.playerName) detail = log.data.playerName;
            else if (log.data.playerId) detail = log.data.playerId;
            else if (log.data.killer) detail = log.data.killer + ' > ' + log.data.victim;
            else if (log.data.gameUID) detail = log.data.gameUID;
        }
        return '`' + time + '` **' + type + '** ' + detail;
    }).join('\n');

    if (list.length > 4000) list = list.substring(0, 4000) + '\n...';

    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x0099FF).setTitle('Recent Logs (' + recent.length + ')').setDescription(list).setTimestamp()],
        ephemeral: true
    });
}

async function handleSayCommand(interaction) {
    // Legacy handler - redirect to broadcast
    return handleBroadcastCommand(interaction);
}

// --- /ban ---
async function handleBanCommand(interaction) {
    if (!rcon.getIsConnected()) {
        return interaction.reply({ content: 'RCON not connected', ephemeral: true });
    }
    var playerInput = interaction.options.getString('player_id');
    var reason = interaction.options.getString('reason') || 'Banned by admin';
    var duration = interaction.options.getInteger('duration') || 0;

    var slotIndex = -1;
    var playerName = playerInput;
    var playerId = playerInput;
    var players = rcon.getConnectedPlayers();

    // Find player slot
    if (/^\d+$/.test(playerInput) && parseInt(playerInput) < 100) {
        slotIndex = parseInt(playerInput);
        for (var entry of players) {
            if (entry[1].slotIndex === slotIndex) {
                playerId = entry[0];
                playerName = entry[1].name;
                break;
            }
        }
    } else {
        var data = players.get(playerInput);
        if (data) {
            slotIndex = data.slotIndex >= 0 ? data.slotIndex : -1;
            playerName = data.name;
        } else {
            for (var entry2 of players) {
                if (entry2[1].name.toLowerCase().includes(playerInput.toLowerCase())) {
                    playerId = entry2[0];
                    playerName = entry2[1].name;
                    slotIndex = entry2[1].slotIndex >= 0 ? entry2[1].slotIndex : -1;
                    break;
                }
            }
        }
    }

    if (slotIndex >= 0) {
        if (duration > 0) {
            rcon.sendCommand('ban ' + slotIndex + ' ' + duration + ' ' + reason);
        } else {
            rcon.sendCommand('ban ' + slotIndex + ' 0 ' + reason);
        }
    } else {
        // Try addBan by UID
        if (duration > 0) {
            rcon.sendCommand('addBan ' + playerInput + ' ' + duration + ' ' + reason);
        } else {
            rcon.sendCommand('addBan ' + playerInput + ' 0 ' + reason);
        }
    }

    logger.log('admin_ban', { playerId: playerId, playerName: playerName, reason: reason, duration: duration, bannedBy: interaction.user.tag });

    sendToLogChannel(new EmbedBuilder().setColor(0xED4245).setAuthor({ name: 'Player Banned' })
        .setDescription('**' + interaction.user.tag + '** banned **' + playerName + '** (`' + playerId + '`)')
        .addFields(
            { name: 'Reason', value: reason, inline: true },
            { name: 'Duration', value: duration > 0 ? duration + ' minutes' : 'Permanent', inline: true }
        ).setTimestamp());

    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('Player Banned')
            .addFields(
                { name: 'Player', value: playerName + ' (`' + playerId + '`)', inline: true },
                { name: 'Duration', value: duration > 0 ? duration + ' min' : 'Permanent', inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'By', value: interaction.user.tag, inline: true }
            ).setTimestamp()]
    });
}

// --- /unban ---
async function handleUnbanCommand(interaction) {
    if (!rcon.getIsConnected()) {
        return interaction.reply({ content: 'RCON not connected', ephemeral: true });
    }
    var playerId = interaction.options.getString('player_id');

    rcon.sendCommand('removeBan ' + playerId);
    rcon.sendCommand('writeBans');
    logger.log('admin_unban', { playerId: playerId, unbannedBy: interaction.user.tag });

    sendToLogChannel(new EmbedBuilder().setColor(0x57F287).setAuthor({ name: 'Player Unbanned' })
        .setDescription('**' + interaction.user.tag + '** unbanned `' + playerId + '`').setTimestamp());

    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('Player Unbanned')
            .addFields(
                { name: 'Player', value: '`' + playerId + '`', inline: true },
                { name: 'By', value: interaction.user.tag, inline: true }
            ).setTimestamp()],
        ephemeral: true
    });
}

// --- /serverinfo ---
async function handleServerInfoCommand(interaction) {
    var rconConnected = rcon.getIsConnected();
    var playerCount = 0;
    try { playerCount = rcon.getConnectedPlayers().size; } catch (e) {}
    var whitelistCount = whitelist.getCount();
    var allSettings = settings.getAll();

    var statusColor = rconConnected ? 0x57F287 : 0xED4245;
    var serverStatus = rconConnected ? '\uD83D\uDFE2 Online' : '\uD83D\uDD34 Offline';

    var embed = new EmbedBuilder()
        .setColor(statusColor)
        .setTitle('\uD83C\uDFAE Server Information')
        .addFields(
            { name: 'Status', value: serverStatus, inline: true },
            { name: 'Online Players', value: playerCount + '', inline: true },
            { name: 'Whitelisted', value: whitelistCount + '', inline: true },
            { name: 'Whitelist', value: allSettings.whitelistEnabled ? 'Required' : 'Not Required', inline: true },
            { name: 'Registration', value: 'Use `/register` to link your account', inline: false }
        )
        .setFooter({ text: 'Use /mystatus to check your own status' })
        .setTimestamp();

    // Show player names if any are online
    if (rconConnected && playerCount > 0) {
        var players = rcon.getConnectedPlayers();
        var names = [];
        for (var entry of players) {
            names.push(entry[1].name);
        }
        var nameText = names.slice(0, 25).join(', ');
        if (names.length > 25) nameText += ' ... +' + (names.length - 25) + ' more';
        embed.addFields({ name: 'Players', value: nameText, inline: false });
    }

    return interaction.reply({ embeds: [embed] });
}

// --- /help ---
async function handleHelpCommand(interaction) {
    var isAdmin = isAuthorizedAdmin(interaction.user.id);

    var userCmds = [
        '### 📋 คำสั่งสำหรับผู้เล่น\n',
        '`/register`',
        '> ลงทะเบียนเชื่อมบัญชี Discord กับ Game UID ของคุณ',
        '> ระบบจะส่งรหัส 6 หลักให้พิมพ์ในเกมเพื่อยืนยันตัวตน\n',
        '`/unregister`',
        '> ยกเลิกการเชื่อมบัญชี Discord ออกจากระบบ\n',
        '`/mystatus`',
        '> ตรวจสอบสถานะการลงทะเบียนและไวท์ลิสต์ของคุณ',
        '> แสดง Game UID, สถานะไวท์ลิสต์, เครดิต\n',
        '`/requestwhitelist`',
        '> ขอไวท์ลิสต์เข้าเซิร์ฟเวอร์',
        '> สามารถขอผ่าน Role ที่กำหนด หรือใช้ Invite Code\n',
        '`/serverinfo`',
        '> ดูข้อมูลเซิร์ฟเวอร์ สถานะออนไลน์ จำนวนผู้เล่น\n',
        '`/help`',
        '> แสดงคู่มือการใช้งานนี้'
    ];

    var adminCmds = [
        '### 🛡️ คำสั่งสำหรับแอดมิน\n',
        '**จัดการไวท์ลิสต์**',
        '`/whitelist add <uid> [name]` — เพิ่มผู้เล่นเข้าไวท์ลิสต์',
        '`/whitelist remove <uid>` — ลบผู้เล่นออกจากไวท์ลิสต์',
        '`/whitelist check <uid>` — ตรวจสอบสถานะไวท์ลิสต์',
        '`/whitelist list` — แสดงรายชื่อไวท์ลิสต์ทั้งหมด\n',
        '**จัดการผู้เล่นในเกม**',
        '`/players` — ดูรายชื่อผู้เล่นออนไลน์พร้อมรายละเอียด',
        '`/kick <player>` — เตะผู้เล่น (ใส่ UID, ชื่อ, หรือ slot#)',
        '`/ban <player> [duration] [reason]` — แบนผู้เล่น (กำหนดระยะเวลาได้)',
        '`/unban <player_id>` — ปลดแบนผู้เล่น',
        '`/broadcast <message>` — ส่งข้อความประกาศถึงผู้เล่นทุกคนในเกม\n',
        '**จัดการระบบ**',
        '`/rcon <command>` — ส่งคำสั่ง RCON ไปยังเซิร์ฟเวอร์โดยตรง',
        '`/status` — ดูสถานะระบบทั้งหมด (Bot, RCON, ผู้เล่น, ไวท์ลิสต์)',
        '`/settings` — ดู/เปิดปิดการตั้งค่าระบบ (whitelist, auto-kick, chat bridge ฯลฯ)',
        '`/sync` — ซิงค์ไวท์ลิสต์กับ Discord Role',
        '`/logs [limit]` — ดูบันทึกกิจกรรมล่าสุด'
    ];

    var embeds = [];

    // Player commands embed
    var playerEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📖 คู่มือการใช้งาน ArmaBot')
        .setDescription(userCmds.join('\n'))
        .setTimestamp();

    embeds.push(playerEmbed);

    if (isAdmin) {
        var adminEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setDescription(adminCmds.join('\n'))
            .setFooter({ text: '🔐 คุณมีสิทธิ์แอดมิน — คำสั่งเหล่านี้มองเห็นเฉพาะแอดมิน' })
            .setTimestamp();
        embeds.push(adminEmbed);
    } else {
        playerEmbed.setFooter({ text: 'หากต้องการสิทธิ์เพิ่มเติม กรุณาติดต่อแอดมิน' });
    }

    return interaction.reply({ embeds: embeds, ephemeral: true });
}

// --- Lifecycle ---

async function start() {
    if (!config.botToken) {
        console.error('[Discord] Bot token not configured!');
        return null;
    }
    createClient();
    try {
        await client.login(config.botToken);
        return client;
    } catch (error) {
        console.error('[Discord] Failed to login:', error.message);
        return null;
    }
}

async function stop() {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
    if (statusEmbedInterval) { clearInterval(statusEmbedInterval); statusEmbedInterval = null; }
    if (client) {
        try { await client.destroy(); isReady = false; console.log('[Discord] Bot disconnected'); }
        catch (error) { console.error('[Discord] Error stopping bot:', error.message); }
    }
}

function getIsReady() { return isReady; }
function getClient() { return client; }

async function hasRequiredRole(discordId) {
    try {
        if (!client || !isReady) return false;
        var guild = client.guilds.cache.get(config.guildId);
        if (!guild) return false;
        var member = await guild.members.fetch(discordId).catch(function() { return null; });
        if (!member) return false;
        return member.roles.cache.has(config.requiredRoleId);
    } catch (error) {
        console.error('[Discord] Error checking role:', error.message);
        return false;
    }
}

module.exports = {
    start: start,
    stop: stop,
    getIsReady: getIsReady,
    getClient: getClient,
    hasRequiredRole: hasRequiredRole
};
