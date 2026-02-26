/**
 * RCON Module - BattlEye RCon Protocol (UDP)
 * Arma Reforger uses BattlEye RCON which communicates over UDP
 *
 * Events emitted:
 *   'connected'           - RCON connected & authenticated
 *   'disconnected'        - RCON disconnected
 *   'player_join'         - { playerId, playerName }
 *   'player_leave'        - { playerId, playerName }
 *   'chat'                - { playerName, message }
 *   'kill'                - { killer, victim, weapon }
 *   'warning_sent'        - { playerId, playerName }
 *   'player_kicked'       - { playerId, playerName, reason }
 *   'raw_message'         - raw string from RCON
 */

const dgram = require('dgram');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const whitelist = require('../database/whitelist');
const logger = require('../database/logger');
const settings = require('../database/settings');

// --- CRC32 Implementation ---
var crc32Table = (function() {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) {
            c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

class RconClient extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.isConnected = false;
        this.isAuthenticated = false;
        this.reconnectTimer = null;
        this.keepAliveTimer = null;
        this.timeoutTimer = null;
        this.connectedPlayers = new Map();
        this.pendingKicks = new Map();
        this.sequenceNumber = 0;
        this.lastPacketTime = 0;

        this.WARNING_MESSAGE =
            '[WARNING] You are NOT whitelisted! Register in Discord within 120 seconds or you will be kicked.';

        // Log file watcher state
        this.logWatcherTimer = null;
        this.currentLogDir = null;
        this.logFilePositions = {}; // { filepath: lastReadPosition }
    }

    // --- Build BattlEye packet ---
    buildPacket(payload) {
        // Packet: 'B' 'E' [4-byte CRC32 LE] [payload]
        var checksum = crc32(payload);
        var packet = Buffer.alloc(6 + payload.length);
        packet[0] = 0x42; // B
        packet[1] = 0x45; // E
        packet.writeUInt32LE(checksum, 2);
        if (typeof payload === 'string') {
            Buffer.from(payload, 'binary').copy(packet, 6);
        } else {
            payload.copy(packet, 6);
        }
        return packet;
    }

    // --- Build Login packet ---
    buildLoginPacket(password) {
        var payload = Buffer.alloc(2 + Buffer.byteLength(password, 'utf8'));
        payload[0] = 0xFF;
        payload[1] = 0x00; // Login type
        Buffer.from(password, 'utf8').copy(payload, 2);
        return this.buildPacket(payload);
    }

    // --- Build Command packet ---
    buildCommandPacket(command) {
        var seq = this.sequenceNumber;
        this.sequenceNumber = (this.sequenceNumber + 1) & 0xFF;
        var cmdBuf = Buffer.from(command, 'utf8');
        var payload = Buffer.alloc(3 + cmdBuf.length);
        payload[0] = 0xFF;
        payload[1] = 0x01; // Command type
        payload[2] = seq;
        cmdBuf.copy(payload, 3);
        return this.buildPacket(payload);
    }

    // --- Build Acknowledge packet ---
    buildAckPacket(seq) {
        var payload = Buffer.alloc(3);
        payload[0] = 0xFF;
        payload[1] = 0x02; // Server message type
        payload[2] = seq;
        return this.buildPacket(payload);
    }

    // --- Connection ---
    connect() {
        this.cleanup(false);

        console.log('[RCON] Connecting to ' + config.rconHost + ':' + config.rconPort + ' (UDP/BattlEye)...');

        this.socket = dgram.createSocket('udp4');

        this.socket.on('message', (msg) => this.handlePacket(msg));

        this.socket.on('error', (err) => {
            console.error('[RCON] Socket error: ' + err.message);
        });

        this.socket.on('close', () => {
            console.log('[RCON] Socket closed');
            var wasConnected = this.isAuthenticated;
            this.cleanup(false);
            if (wasConnected) {
                this.emit('disconnected');
            }
            this.scheduleReconnect();
        });

        // Send login packet
        var loginPacket = this.buildLoginPacket(config.rconPassword);
        this.socket.send(loginPacket, 0, loginPacket.length, config.rconPort, config.rconHost, (err) => {
            if (err) {
                console.error('[RCON] Error sending login:', err.message);
                this.scheduleReconnect();
            } else {
                console.log('[RCON] Login packet sent, waiting for response...');
                this.isConnected = true;
                this.lastPacketTime = Date.now();

                // Timeout if no response within 10 seconds
                this.timeoutTimer = setTimeout(() => {
                    if (!this.isAuthenticated) {
                        console.log('[RCON] Login timeout - no response from server');
                        this.cleanup(false);
                        this.scheduleReconnect();
                    }
                }, 10000);
            }
        });
    }

    // --- Handle incoming BattlEye packet ---
    handlePacket(buf) {
        try {
            if (buf.length < 7) return; // Minimum valid packet
            if (buf[0] !== 0x42 || buf[1] !== 0x45) return; // Not a BE packet

            // Verify checksum
            var receivedCrc = buf.readUInt32LE(2);
            var payloadBuf = buf.slice(6);
            var calculatedCrc = crc32(payloadBuf);
            if (receivedCrc !== calculatedCrc) {
                console.log('[RCON] CRC mismatch, ignoring packet');
                return;
            }

            if (payloadBuf[0] !== 0xFF) return;

            this.lastPacketTime = Date.now();
            var packetType = payloadBuf[1];

            switch (packetType) {
                case 0x00: // Login response
                    this.handleLoginResponse(payloadBuf);
                    break;
                case 0x01: // Command response
                    this.handleCommandResponse(payloadBuf);
                    break;
                case 0x02: // Server message
                    this.handleServerMessage(payloadBuf);
                    break;
                default:
                    console.log('[RCON] Unknown packet type: 0x' + packetType.toString(16));
            }
        } catch (err) {
            console.error('[RCON] Error handling packet:', err.message);
        }
    }

    handleLoginResponse(payload) {
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }

        var success = payload[2] === 0x01;
        if (success) {
            console.log('[RCON] Authentication successful');
            this.isAuthenticated = true;
            this.startKeepalive();
            this.startTimeoutCheck();
            this.startPlayerPolling();
            this.emit('connected');

            // Request players list
            setTimeout(() => {
                this.sendCommand('players');
            }, 1000);
        } else {
            console.error('[RCON] Authentication FAILED - check RCON_PASSWORD in .env');
            this.cleanup(false);
            // Wait longer before retry on auth failure
            setTimeout(() => this.scheduleReconnect(), 30000);
        }
    }

    handleCommandResponse(payload) {
        if (payload.length <= 3) return;
        var seq = payload[2];

        // BattlEye can split responses across multiple packets
        // Check if this is a multi-part response
        var isMultiPart = false;
        var totalParts = 0;
        var partIndex = 0;
        
        // Multi-part header: seq byte, then total count byte, then index byte
        // For single responses, just seq + data
        
        var response = payload.slice(3).toString('utf8').trim();
        if (response) {
            console.log('[RCON] < ' + response);
            this.emit('raw_message', response);
            this.parseResponse(response);
        }
    }

    handleServerMessage(payload) {
        if (payload.length < 3) return;
        var seq = payload[2];

        // Send acknowledgement
        var ackPacket = this.buildAckPacket(seq);
        if (this.socket) {
            this.socket.send(ackPacket, 0, ackPacket.length, config.rconPort, config.rconHost);
        }

        if (payload.length > 3) {
            var message = payload.slice(3).toString('utf8').trim();
            if (message) {
                console.log('[RCON] << ' + message);
                this.emit('raw_message', message);
                this.parseServerEvent(message);
            }
        }
    }

    // --- Keepalive & timeout ---
    startKeepalive() {
        this.stopKeepalive();
        this.keepAliveTimer = setInterval(() => {
            if (this.isConnected && this.isAuthenticated) {
                // Send empty command as keepalive
                var packet = this.buildCommandPacket('');
                if (this.socket) {
                    this.socket.send(packet, 0, packet.length, config.rconPort, config.rconHost);
                }
            }
        }, 25000);
    }

    stopKeepalive() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    // Poll players every 30 seconds to keep list accurate
    startPlayerPolling() {
        this.stopPlayerPolling();
        this._playerPollInterval = setInterval(() => {
            if (this.isConnected && this.isAuthenticated) {
                this.sendCommand('players');
            }
        }, 30000);
    }

    stopPlayerPolling() {
        if (this._playerPollInterval) {
            clearInterval(this._playerPollInterval);
            this._playerPollInterval = null;
        }
    }

    startTimeoutCheck() {
        // If no packet received for 45 seconds, consider disconnected
        this.stopTimeoutCheck();
        this._timeoutCheckInterval = setInterval(() => {
            if (this.isAuthenticated && Date.now() - this.lastPacketTime > 45000) {
                console.log('[RCON] No response for 45s, considering disconnected');
                var wasConnected = this.isAuthenticated;
                this.cleanup(false);
                if (wasConnected) this.emit('disconnected');
                this.scheduleReconnect();
            }
        }, 10000);
    }

    stopTimeoutCheck() {
        if (this._timeoutCheckInterval) {
            clearInterval(this._timeoutCheckInterval);
            this._timeoutCheckInterval = null;
        }
    }

    cleanup(clearKickTimers) {
        this.stopKeepalive();
        this.stopTimeoutCheck();
        this.stopPlayerPolling();
        this.isConnected = false;
        this.isAuthenticated = false;
        this.sequenceNumber = 0;

        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }

        if (this.socket) {
            try { this.socket.close(); } catch (_) {}
            this.socket = null;
        }

        if (clearKickTimers) {
            for (const [, pending] of this.pendingKicks) {
                clearTimeout(pending.timer);
            }
            this.pendingKicks.clear();
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            console.log('[RCON] Attempting reconnection...');
            this.connect();
        }, config.rconReconnectDelay);
    }

    // --- Parse command responses (from type 0x01 packets) ---
    parseResponse(message) {
        // Ignore BattlEye system/echo messages
        if (/^Processing Command:/i.test(message)) return;
        if (/^Logged In/i.test(message)) return;
        if (/^unknown command/i.test(message)) {
            console.log('[RCON] Server: ' + message);
            return;
        }

        // Parse player list response
        // Format: "Players on server:\n[Player#] ; [Player UID] ; [Player Name]\n0 ; uid123 ; Name"
        if (/Players on server/i.test(message)) {
            this.parsePlayerList(message);
            return;
        }

        // Parse individual player line from list: "0 ; uid123 ; PlayerName"
        var playerLine = message.match(/^(\d+)\s*;\s*(\S+)\s*;\s*(.+)$/m);
        if (playerLine) {
            this.parsePlayerListLine(playerLine[1], playerLine[2], playerLine[3].trim());
            return;
        }

        // Try game event parsing for responses
        this.parseGameEvent(message);
    }

    // --- Parse server events (from type 0x02 packets - real-time events) ---
    parseServerEvent(message) {
        // Ignore BattlEye system messages
        if (/^Processing Command:/i.test(message)) return;
        if (/^Logged In/i.test(message)) return;
        if (/^unknown command/i.test(message)) return;

        // Player list can arrive as type 0x02 server message too
        if (/Players on server/i.test(message)) {
            this.parsePlayerList(message);
            return;
        }

        // Parse individual player line from list
        var playerLine = message.match(/^(\d+)\s*;\s*(\S+)\s*;\s*(.+)$/m);
        if (playerLine) {
            this.parsePlayerListLine(playerLine[1], playerLine[2], playerLine[3].trim());
            return;
        }

        this.parseGameEvent(message);
    }

    // --- Parse player list response ---
    parsePlayerList(message) {
        var lines = message.split(/\n|\r/);
        var newPlayers = new Map();
        var playerCount = 0;
        var oldPlayers = this.connectedPlayers; // Save old map to detect new joins
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            // Match: "0 ; uid123456 ; PlayerName"
            var match = line.match(/^(\d+)\s*;\s*(\S+)\s*;\s*(.+)$/);
            if (match) {
                var slotIndex = parseInt(match[1]);
                var uid = match[2];
                var name = match[3].trim();
                if (!uid || uid === '[Player' || uid.startsWith('[')) continue;
                var existing = oldPlayers.get(uid);
                newPlayers.set(uid, { name: name, joinTime: existing ? existing.joinTime : Date.now(), slotIndex: slotIndex });
                playerCount++;
            }
        }
        // Replace entire player list with fresh data
        this.connectedPlayers = newPlayers;
        console.log('[RCON] Player list parsed: ' + playerCount + ' players online');
        this.emit('players_updated', playerCount);

        // Check newly detected players against whitelist (catches players that joined between polls)
        if (settings.get('whitelistEnabled') && settings.get('autoKickEnabled')) {
            for (var entry of newPlayers) {
                var uid = entry[0];
                var playerData = entry[1];
                if (!oldPlayers.has(uid)) {
                    // New player detected via polling
                    console.log('[RCON] New player detected via poll: ' + playerData.name + ' (UID: ' + uid + ')');
                    this.emit('player_join', { playerId: uid, playerName: playerData.name });
                    logger.log('player_joined', { playerId: uid, playerName: playerData.name });
                    if (!whitelist.isWhitelisted(uid)) {
                        console.log('[RCON] ' + playerData.name + ' is NOT whitelisted - enforcing');
                        this.handleUnwhitelistedPlayer(uid, playerData.name);
                    }
                }
            }
        } else if (oldPlayers.size > 0 || playerCount > 0) {
            // Even if whitelist is off, still emit join/leave events for new/departed players
            for (var entry of newPlayers) {
                if (!oldPlayers.has(entry[0])) {
                    this.emit('player_join', { playerId: entry[0], playerName: entry[1].name });
                    logger.log('player_joined', { playerId: entry[0], playerName: entry[1].name });
                }
            }
        }

        // Detect players who left (in old but not in new)
        for (var entry of oldPlayers) {
            if (!newPlayers.has(entry[0])) {
                var leftPlayer = entry[1];
                console.log('[RCON] Player left (detected via poll): ' + leftPlayer.name + ' (' + entry[0] + ')');
                this.cancelPendingKick(entry[0]);
                logger.log('player_left', { playerId: entry[0], playerName: leftPlayer.name });
                this.emit('player_leave', { playerId: entry[0], playerName: leftPlayer.name });
            }
        }
    }

    parsePlayerListLine(index, uid, name) {
        if (!uid || uid === '[Player' || uid.startsWith('[')) return; // Header line
        var slotIndex = parseInt(index);
        if (!this.connectedPlayers.has(uid)) {
            this.connectedPlayers.set(uid, { name: name, joinTime: Date.now(), slotIndex: slotIndex });
            console.log('[RCON] Player tracked: #' + index + ' ' + name + ' (UID: ' + uid + ')');
            
            // Check whitelist for newly detected player
            if (settings.get('whitelistEnabled') && settings.get('autoKickEnabled')) {
                if (!whitelist.isWhitelisted(uid)) {
                    console.log('[RCON] ' + name + ' (' + uid + ') is NOT whitelisted - enforcing');
                    this.handleUnwhitelistedPlayer(uid, name);
                }
            }
        } else {
            // Update name and slot index
            var existing = this.connectedPlayers.get(uid);
            if (existing) {
                existing.name = name;
                existing.slotIndex = slotIndex;
            }
        }
    }

    // --- Parse game events (connect/disconnect/chat/kill) ---
    parseGameEvent(message) {
        // BattlEye player connect format: "Player #0 PlayerName (uid) connected"
        if (/Player\s+#\d+/i.test(message) && /connected/i.test(message)) {
            this.handlePlayerJoin(message);
            return;
        }

        // BattlEye player disconnect format: "Player #0 PlayerName disconnected"
        if (/Player\s+#\d+/i.test(message) && /disconnected/i.test(message)) {
            this.handlePlayerLeave(message);
            return;
        }

        // Generic connect/disconnect
        if (/player\s+(connected|joined)/i.test(message)) {
            this.handlePlayerJoin(message);
            return;
        }
        if (/player\s+(disconnected|left)/i.test(message)) {
            this.handlePlayerLeave(message);
            return;
        }

        // Kill / death patterns
        var killMatch = message.match(/(.+?)\s+killed\s+(.+?)(?:\s+with\s+(.+))?$/i) ||
                        message.match(/(.+?)\s+killed\s+by\s+(.+)/i);
        if (killMatch) {
            this.handleKill(killMatch, message);
            return;
        }

        // Chat message patterns - but skip system messages
        if (/^(Processing Command|Logged In|unknown command|Players on server)/i.test(message)) return;
        // Match chat: "(Global) Name: msg" or "Name: msg" or "Chat: Name: msg"
        var chatMatch = message.match(/(?:\((?:Global|Side|Group|Vehicle|Direct)\)\s*)?(?:Chat[:\s]+)?([^:]+):\s+(.+)/i);
        if (chatMatch && !message.includes('connected') && !message.includes('disconnected')) {
            var playerName = chatMatch[1].trim();
            var chatMsg = chatMatch[2].trim();
            // Filter out BattlEye system patterns only (not player names)
            if (playerName && chatMsg && playerName.length < 40 && 
                !playerName.startsWith('[') && 
                !/^Player\s+#\d/i.test(playerName) &&
                !/^Player\s+'/i.test(playerName) &&
                !/^RCon\s+admin/i.test(playerName) &&
                !/^Processing/i.test(playerName) &&
                !/^Logged/i.test(playerName)) {
                this.handleChatMessage(playerName, chatMsg, message);
                return;
            }
        }
    }

    handlePlayerJoin(message) {
        try {
            // BattlEye format: "Player #0 PlayerName (uid123) connected"
            var match = message.match(/Player\s+#(\d+)\s+(.+?)\s+\(([^)]+)\)\s+connected/i);
            if (!match) {
                // Fallback: generic format
                match = message.match(/Player\s+(?:connected|joined):\s*(.+?)(?:\s*\((\S+)\))?$/i);
                if (match) {
                    var playerName = (match[1] || 'Unknown').trim();
                    var playerId = (match[2] || playerName).trim();
                } else {
                    console.log('[RCON] Could not parse player join:', message);
                    return;
                }
            } else {
                var playerName = match[2].trim();
                var playerId = match[3].trim();
            }

            var slotIndex = match ? parseInt(match[1]) : -1;
            console.log('[RCON] Player joined: ' + playerName + ' (ID: ' + playerId + ', slot #' + slotIndex + ')');
            this.connectedPlayers.set(playerId, { name: playerName, joinTime: Date.now(), slotIndex: slotIndex });
            logger.log('player_joined', { playerId: playerId, playerName: playerName });

            this.emit('player_join', { playerId: playerId, playerName: playerName });

            if (settings.get('whitelistEnabled') && !whitelist.isWhitelisted(playerId)) {
                if (settings.get('autoKickEnabled')) {
                    this.handleUnwhitelistedPlayer(playerId, playerName);
                } else {
                    console.log('[RCON] ' + playerName + ' is not whitelisted but auto-kick is disabled');
                    this.emit('warning_sent', { playerId: playerId, playerName: playerName });
                }
            }
        } catch (err) {
            console.error('[RCON] Error handling player join:', err.message);
        }
    }

    handlePlayerLeave(message) {
        try {
            // BattlEye format: "Player #0 PlayerName disconnected"
            var match = message.match(/Player\s+#(\d+)\s+(.+?)\s+\(([^)]+)\)\s+disconnected/i);
            if (!match) {
                // Without UID: "Player #0 PlayerName disconnected"
                match = message.match(/Player\s+#(\d+)\s+(.+?)\s+disconnected/i);
                if (match) {
                    var playerName = match[2].trim();
                    // Look up UID from connectedPlayers by name
                    var playerId = null;
                    for (var entry of this.connectedPlayers) {
                        if (entry[1].name === playerName) {
                            playerId = entry[0];
                            break;
                        }
                    }
                    if (!playerId) playerId = playerName;
                } else {
                    // Generic fallback
                    match = message.match(/Player\s+(?:disconnected|left):\s*(.+?)(?:\s*\((\S+)\))?$/i);
                    if (!match) return;
                    var playerName = (match[1] || 'Unknown').trim();
                    var playerId = (match[2] || playerName).trim();
                }
            } else {
                var playerName = match[2].trim();
                var playerId = match[3].trim();
            }

            var stored = this.connectedPlayers.get(playerId);
            var finalName = (stored && stored.name) ? stored.name : playerName;

            this.connectedPlayers.delete(playerId);
            this.cancelPendingKick(playerId);

            console.log('[RCON] Player left: ' + finalName + ' (' + playerId + ')');
            logger.log('player_left', { playerId: playerId, playerName: finalName });

            this.emit('player_leave', { playerId: playerId, playerName: finalName });
        } catch (err) {
            console.error('[RCON] Error handling player leave:', err.message);
        }
    }

    handleChatMessage(playerName, chatMsg, rawMessage) {
        console.log('[RCON] Chat ' + playerName + ': ' + chatMsg);

        var playerId = null;
        for (var entry of this.connectedPlayers) {
            if (entry[1].name === playerName) {
                playerId = entry[0];
                break;
            }
        }

        logger.log('chat', { playerName: playerName, playerId: playerId, message: chatMsg });
        this.emit('chat', { playerName: playerName, playerId: playerId, message: chatMsg, raw: rawMessage });
    }

    handleKill(match, rawMessage) {
        try {
            var killer, victim, weapon;

            if (rawMessage.toLowerCase().includes('killed by')) {
                victim = (match[1] || 'Unknown').trim();
                killer = (match[2] || 'Unknown').trim();
                weapon = 'Unknown';
            } else {
                killer = (match[1] || 'Unknown').trim();
                victim = (match[2] || 'Unknown').trim();
                weapon = (match[3] || 'Unknown').trim();
            }

            console.log('[RCON] Kill: ' + killer + ' killed ' + victim + ' (' + weapon + ')');
            logger.log('kill', { killer: killer, victim: victim, weapon: weapon });
            this.emit('kill', { killer: killer, victim: victim, weapon: weapon });
        } catch (err) {
            console.error('[RCON] Error handling kill:', err.message);
        }
    }

    // --- Whitelist enforcement ---

    handleUnwhitelistedPlayer(playerId, playerName) {
        if (this.pendingKicks.has(playerId)) {
            console.log('[RCON] Player ' + playerId + ' already has pending kick');
            return;
        }

        console.log('[RCON] ' + playerName + ' (' + playerId + ') is NOT whitelisted - starting ' + config.kickDelaySeconds + 's timer');
        this.sendMessage(playerId, this.WARNING_MESSAGE);
        logger.log('warning_sent', { playerId: playerId, playerName: playerName });
        this.emit('warning_sent', { playerId: playerId, playerName: playerName });

        var self = this;
        var timer = setTimeout(function() {
            if (!whitelist.isWhitelisted(playerId)) {
                self.kickPlayer(playerId, playerName, 'Not whitelisted');
            } else {
                console.log('[RCON] Player ' + playerId + ' became whitelisted, kick cancelled');
            }
            self.pendingKicks.delete(playerId);
        }, config.kickDelaySeconds * 1000);

        this.pendingKicks.set(playerId, { timer: timer, playerId: playerId, playerName: playerName, startTime: Date.now() });
    }

    cancelPendingKick(playerId) {
        var pending = this.pendingKicks.get(playerId);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingKicks.delete(playerId);
            console.log('[RCON] Cancelled pending kick for ' + playerId);
        }
    }

    kickPlayer(playerId, playerName, reason) {
        // BattlEye requires slot index for kick, not UID
        var playerData = this.connectedPlayers.get(playerId);
        var slotIndex = playerData ? playerData.slotIndex : -1;
        
        if (slotIndex >= 0) {
            console.log('[RCON] Kicking: ' + playerName + ' (slot #' + slotIndex + ', UID: ' + playerId + ') - ' + reason);
            this.sendCommand('kick ' + slotIndex + ' ' + reason);
        } else {
            // Fallback: try kicking by UID (may not work in all BattlEye versions)
            console.log('[RCON] Kicking (by UID, no slot#): ' + playerName + ' (' + playerId + ') - ' + reason);
            this.sendCommand('kick ' + playerId + ' ' + reason);
        }
        
        logger.log('player_kicked', { playerId: playerId, playerName: playerName, reason: reason });
        this.connectedPlayers.delete(playerId);
        this.emit('player_kicked', { playerId: playerId, playerName: playerName, reason: reason });
    }

    sendMessage(playerId, message) {
        // Use RCON Plus 'pmid' command to send private message to player
        console.log('[RCON] PM to ' + playerId + ': ' + message);
        this.sendCommand('pmid ' + playerId + ' ' + message);
    }

    // --- RCON Plus: Send message to player by name ---
    sendMessageByName(playerName, message) {
        console.log('[RCON] PM to ' + playerName + ': ' + message);
        this.sendCommand('pm ' + playerName + ' ' + message);
    }

    // --- RCON Plus: Broadcast message types ---
    broadcastMessage(message, type) {
        type = type || 'admin';
        switch (type) {
            case 'warning':
                this.sendCommand('saywarning ' + message);
                break;
            case 'positive':
                this.sendCommand('saypositive ' + message);
                break;
            case 'negative':
                this.sendCommand('saynegative ' + message);
                break;
            case 'admin':
            default:
                this.sendCommand('say ' + message);
                break;
        }
    }

    // --- Send command via BattlEye ---

    sendCommand(command) {
        if (!this.socket || !this.isConnected || !this.isAuthenticated) {
            console.log('[RCON] Cannot send - not connected');
            return false;
        }

        try {
            var logCmd = command.startsWith('login ') ? 'login [HIDDEN]' : (command || '(keepalive)');
            console.log('[RCON] > ' + logCmd);
            var packet = this.buildCommandPacket(command);
            this.socket.send(packet, 0, packet.length, config.rconPort, config.rconHost);
            return true;
        } catch (err) {
            console.error('[RCON] Error sending command:', err.message);
            return false;
        }
    }

    // --- Send chat from Discord to game ---

    sendChatToGame(senderName, message) {
        // Use RCON Plus 'say' command to send Discord chat to game
        console.log('[RCON] Chat to game: [Discord] ' + senderName + ': ' + message);
        this.sendCommand('say [Discord] ' + senderName + ': ' + message);
        return true;
    }

    // =============================================
    // Server Log File Watcher (Kill Feed)
    // =============================================

    startLogWatcher() {
        if (!config.serverLogDir) {
            console.log('[LogWatcher] SERVER_LOG_DIR not set - kill feed from server logs disabled');
            return;
        }

        if (!fs.existsSync(config.serverLogDir)) {
            console.log('[LogWatcher] Log directory not found: ' + config.serverLogDir);
            return;
        }

        console.log('[LogWatcher] Starting server log watcher: ' + config.serverLogDir);
        this.findLatestLogDir();

        // Poll every 3 seconds for new log lines
        this.logWatcherTimer = setInterval(() => {
            this.pollLogFiles();
        }, 3000);
    }

    stopLogWatcher() {
        if (this.logWatcherTimer) {
            clearInterval(this.logWatcherTimer);
            this.logWatcherTimer = null;
        }
    }

    findLatestLogDir() {
        try {
            var entries = fs.readdirSync(config.serverLogDir, { withFileTypes: true });
            var logDirs = entries
                .filter(function(e) { return e.isDirectory() && e.name.startsWith('logs_'); })
                .map(function(e) { return e.name; })
                .sort();

            if (logDirs.length === 0) {
                console.log('[LogWatcher] No log directories found');
                return;
            }

            var latestDir = path.join(config.serverLogDir, logDirs[logDirs.length - 1]);
            if (latestDir !== this.currentLogDir) {
                console.log('[LogWatcher] Watching log directory: ' + logDirs[logDirs.length - 1]);
                this.currentLogDir = latestDir;
                // Reset positions - start reading from current end (don't replay old logs)
                this.logFilePositions = {};
                var consolePath = path.join(latestDir, 'console.log');
                var scriptPath = path.join(latestDir, 'script.log');
                if (fs.existsSync(consolePath)) {
                    this.logFilePositions[consolePath] = fs.statSync(consolePath).size;
                }
                if (fs.existsSync(scriptPath)) {
                    this.logFilePositions[scriptPath] = fs.statSync(scriptPath).size;
                }
            }
        } catch (err) {
            console.error('[LogWatcher] Error finding log dir:', err.message);
        }
    }

    pollLogFiles() {
        // Check for newer log directory (server restart)
        this.findLatestLogDir();
        if (!this.currentLogDir) return;

        var files = [
            path.join(this.currentLogDir, 'console.log'),
            path.join(this.currentLogDir, 'script.log')
        ];

        for (var i = 0; i < files.length; i++) {
            this.readNewLines(files[i]);
        }
    }

    readNewLines(filePath) {
        try {
            if (!fs.existsSync(filePath)) return;

            var stat = fs.statSync(filePath);
            var lastPos = this.logFilePositions[filePath] || 0;

            // File was truncated/rotated (new server session)
            if (stat.size < lastPos) {
                lastPos = 0;
            }

            if (stat.size <= lastPos) return; // No new data

            var bytesToRead = stat.size - lastPos;
            // Limit read size to 64KB per poll to avoid memory issues
            if (bytesToRead > 65536) {
                lastPos = stat.size - 65536;
                bytesToRead = 65536;
            }

            var buf = Buffer.alloc(bytesToRead);
            var fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, buf, 0, bytesToRead, lastPos);
            fs.closeSync(fd);

            this.logFilePositions[filePath] = stat.size;

            var text = buf.toString('utf8');
            var lines = text.split(/\r?\n/);
            for (var j = 0; j < lines.length; j++) {
                var line = lines[j].trim();
                if (line) {
                    this.parseLogLine(line);
                }
            }
        } catch (err) {
            // File might be locked by server, skip this poll
        }
    }

    parseLogLine(line) {
        // Strip timestamp prefix (e.g., "09:08:08.481   SCRIPT       :")
        var stripped = line.replace(/^\d{2}:\d{2}:\d{2}\.\d+\s+\S+\s*(?:\([EW]\))?\s*:\s*/, '').trim();

        // --- Kill patterns from various mods and vanilla ---

        // Pattern: "PlayerA killed PlayerB" or "PlayerA killed PlayerB with WeaponName"
        var m = stripped.match(/^(.+?)\s+killed\s+(.+?)(?:\s+with\s+(.+))?$/i);
        if (m && !stripped.includes('duplicate notification') && !stripped.includes('PUNISHMENT')) {
            this.emitKillEvent(m[1].trim(), m[2].trim(), (m[3] || 'Unknown').trim());
            return;
        }

        // Pattern: "PlayerA was killed by PlayerB"
        m = stripped.match(/^(.+?)\s+was killed by\s+(.+?)(?:\s+with\s+(.+))?$/i);
        if (m) {
            this.emitKillEvent(m[2].trim(), m[1].trim(), (m[3] || 'Unknown').trim());
            return;
        }

        // Pattern: "[KillFeed] PlayerA > PlayerB (WeaponName)"
        m = stripped.match(/\[KillFeed\]\s*(.+?)\s*>\s*(.+?)(?:\s*\((.+?)\))?$/i);
        if (m) {
            this.emitKillEvent(m[1].trim(), m[2].trim(), (m[3] || 'Unknown').trim());
            return;
        }

        // Pattern: "Player 'Name' (id) killed by player 'Name2' (id2)" (TrustyAdminTools format)
        m = stripped.match(/Player\s+'(.+?)'\s*(?:\([^)]*\))?\s*killed\s+by\s+player\s+'(.+?)'/i);
        if (m) {
            this.emitKillEvent(m[2].trim(), m[1].trim(), 'Unknown');
            return;
        }

        // Pattern: "KILL: PlayerA -> PlayerB (weapon)" (ServerAdminTools format)
        m = stripped.match(/KILL:\s*(.+?)\s*->\s*(.+?)(?:\s*\((.+?)\))?$/i);
        if (m) {
            this.emitKillEvent(m[1].trim(), m[2].trim(), (m[3] || 'Unknown').trim());
            return;
        }

        // Pattern: "Player 'Name' died" or "Name died" (death without killer)
        m = stripped.match(/(?:Player\s+')?(.+?)(?:')?\s+died$/i);
        if (m && m[1].length < 40 && !m[1].includes('(') && !m[1].includes('script')) {
            this.emitKillEvent('Environment', m[1].trim(), 'Unknown');
            return;
        }
    }

    emitKillEvent(killer, victim, weapon) {
        // Filter out system/noise entries
        if (killer.length > 50 || victim.length > 50) return;
        if (/^(Processing|Logged|unknown|Players|Module|Compiling)/i.test(killer)) return;
        if (/^(Processing|Logged|unknown|Players|Module|Compiling)/i.test(victim)) return;

        console.log('[LogWatcher] Kill: ' + killer + ' killed ' + victim + ' (' + weapon + ')');
        logger.log('kill', { killer: killer, victim: victim, weapon: weapon });
        this.emit('kill', { killer: killer, victim: victim, weapon: weapon });
    }

    // --- Lifecycle ---

    start() {
        console.log('[RCON] Starting RCON handler (BattlEye UDP)...');
        this.connect();
        this.startLogWatcher();
    }

    stop() {
        console.log('[RCON] Stopping RCON handler...');
        this.stopLogWatcher();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.cleanup(true);
    }

    getIsConnected() {
        return this.isConnected && this.isAuthenticated;
    }

    getConnectedPlayers() {
        return new Map(this.connectedPlayers);
    }

    getPendingKicks() {
        var kicks = [];
        for (var entry of this.pendingKicks) {
            var data = entry[1];
            kicks.push({
                playerId: data.playerId,
                playerName: data.playerName,
                remainingSeconds: Math.max(0, Math.round(
                    (config.kickDelaySeconds * 1000 - (Date.now() - data.startTime)) / 1000
                ))
            });
        }
        return kicks;
    }

    checkPlayer(playerId) {
        if (whitelist.isWhitelisted(playerId)) {
            this.cancelPendingKick(playerId);
            return true;
        }
        return false;
    }
}

// Singleton instance
var rconClient = new RconClient();

module.exports = rconClient;
