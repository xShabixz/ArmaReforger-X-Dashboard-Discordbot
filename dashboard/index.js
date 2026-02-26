/**
 * Dashboard Module
 * Express.js web dashboard for whitelist management
 * HTTPS secured with self-signed certificate
 * Role-based access: owner (full access) and admin (limited)
 */

const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const whitelist = require('../database/whitelist');
const logger = require('../database/logger');
const registrations = require('../database/registrations');
const settings = require('../database/settings');
const whitelistCodes = require('../database/whitelistCodes');

const app = express();
var server = null;

function setupApp() {
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use(session({
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: false,
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000
        }
    }));

    var loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 5,
        message: { error: 'Too many login attempts, please try again later' },
        standardHeaders: true,
        legacyHeaders: false
    });

    app.use(express.static(path.join(__dirname, '../public')));
    setupRoutes(loginLimiter);
    return app;
}

function setupRoutes(loginLimiter) {
    var requireAuth = function(req, res, next) {
        if (req.session && req.session.authenticated) {
            next();
        } else {
            if (req.path.startsWith('/api/')) {
                res.status(401).json({ error: 'Not authenticated' });
            } else {
                res.redirect('/login.html');
            }
        }
    };

    // Owner-only middleware
    var requireOwner = function(req, res, next) {
        if (req.session && req.session.authenticated && req.session.role === 'owner') {
            next();
        } else {
            res.status(403).json({ error: 'Owner access required' });
        }
    };

    // Root redirect
    app.get('/', function(req, res) {
        if (req.session && req.session.authenticated) {
            res.redirect('/dashboard.html');
        } else {
            res.redirect('/login.html');
        }
    });

    // Login - supports owner and admin passwords
    app.post('/login', loginLimiter, function(req, res) {
        var password = req.body.password;
        if (!config.adminPassword) {
            return res.status(500).json({ error: 'Password not configured' });
        }

        // Check owner password first
        if (config.ownerPassword && password === config.ownerPassword) {
            req.session.authenticated = true;
            req.session.role = 'owner';
            logger.log('dashboard_login', { role: 'owner', ip: req.ip });
            return res.json({ success: true, role: 'owner' });
        }

        // Then admin password
        if (password === config.adminPassword) {
            req.session.authenticated = true;
            req.session.role = 'admin';
            logger.log('dashboard_login', { role: 'admin', ip: req.ip });
            return res.json({ success: true, role: 'admin' });
        }

        logger.log('dashboard_login_failed', { ip: req.ip });
        res.status(401).json({ error: 'Invalid password' });
    });

    // Logout
    app.get('/logout', function(req, res) {
        req.session.destroy(function() {
            res.redirect('/login.html');
        });
    });

    // Auth status
    app.get('/api/auth/status', function(req, res) {
        res.json({
            authenticated: !!(req.session && req.session.authenticated),
            role: (req.session && req.session.role) || null
        });
    });

    // --- Status API (enhanced) ---
    app.get('/api/status', requireAuth, function(req, res) {
        try {
            var bot = require('../bot');
            var rcon = require('../rcon');

            var players = rcon.getConnectedPlayers();
            var playerList = [];
            for (var entry of players) {
                var id = entry[0];
                var info = entry[1];
                playerList.push({
                    playerId: id,
                    playerName: info.name,
                    joinTime: info.joinTime,
                    slotIndex: info.slotIndex,
                    isWhitelisted: whitelist.isWhitelisted(id),
                    onlineMinutes: Math.floor((Date.now() - info.joinTime) / 60000)
                });
            }

            res.json({
                discord: {
                    connected: bot.getIsReady()
                },
                rcon: {
                    connected: rcon.getIsConnected()
                },
                whitelist: {
                    count: whitelist.getCount()
                },
                registrations: {
                    count: registrations.getCount()
                },
                settings: settings.getAll(),
                players: {
                    count: players.size,
                    list: playerList
                },
                pendingKicks: rcon.getPendingKicks(),
                uptime: process.uptime(),
                role: req.session.role
            });
        } catch (error) {
            console.error('[Dashboard] Error getting status:', error.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // --- Whitelist API (enhanced with playerName) ---
    app.get('/api/whitelist', requireAuth, function(req, res) {
        try {
            var list = whitelist.getWhitelist();
            var entries = Object.entries(list).map(function(pair) {
                return {
                    playerId: pair[0],
                    discordId: pair[1].discordId,
                    playerName: pair[1].playerName || null,
                    addedAt: pair[1].addedAt
                };
            });

            res.json({
                count: entries.length,
                entries: entries
            });
        } catch (error) {
            console.error('[Dashboard] Error getting whitelist:', error.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Add to whitelist (enhanced with playerName)
    app.post('/api/whitelist', requireAuth, function(req, res) {
        try {
            var playerId = req.body.playerId;
            var discordId = req.body.discordId;
            var playerName = req.body.playerName;

            if (!playerId) {
                return res.status(400).json({ error: 'Player ID is required' });
            }

            if (whitelist.isWhitelisted(playerId)) {
                return res.status(409).json({ error: 'Player already whitelisted' });
            }

            var success = whitelist.addToWhitelist(playerId, discordId || 'manual', playerName || null);

            if (success) {
                logger.log('dashboard_add', { playerId: playerId, playerName: playerName || 'N/A' });

                // Cancel pending kick if applicable
                var rcon = require('../rcon');
                rcon.cancelPendingKick(playerId);

                res.json({ success: true });
            } else {
                res.status(500).json({ error: 'Failed to add to whitelist' });
            }
        } catch (error) {
            console.error('[Dashboard] Error adding to whitelist:', error.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Remove from whitelist
    app.delete('/api/whitelist/:playerId', requireAuth, function(req, res) {
        try {
            var playerId = req.params.playerId;
            var success = whitelist.removeFromWhitelist(playerId);
            logger.log('dashboard_remove', { playerId: playerId });
            res.json({ success: success });
        } catch (error) {
            console.error('[Dashboard] Error removing from whitelist:', error.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // --- Logs API ---
    app.get('/api/logs', requireAuth, function(req, res) {
        try {
            var count = parseInt(req.query.count) || 100;
            var type = req.query.type || null;

            var logs;
            if (type) {
                logs = logger.getLogsByType(type).slice(-count).reverse();
            } else {
                logs = logger.getRecentLogs(count);
            }

            res.json({
                count: logs.length,
                logs: logs
            });
        } catch (error) {
            console.error('[Dashboard] Error getting logs:', error.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // --- RCON Command API (owner only) ---
    app.post('/api/rcon', requireOwner, function(req, res) {
        try {
            var rcon = require('../rcon');
            var command = req.body.command;

            if (!command) {
                return res.status(400).json({ error: 'Command is required' });
            }

            if (!rcon.getIsConnected()) {
                return res.status(503).json({ error: 'RCON not connected' });
            }

            var success = rcon.sendCommand(command);
            logger.log('dashboard_rcon', { command: command });

            res.json({ success: success, message: 'Command sent: ' + command });
        } catch (error) {
            console.error('[Dashboard] Error sending RCON command:', error.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // --- Kick Player API ---
    app.post('/api/kick', requireAuth, function(req, res) {
        try {
            var rcon = require('../rcon');
            var playerId = req.body.playerId;
            var reason = req.body.reason || 'Kicked by admin (dashboard)';

            if (!playerId) {
                return res.status(400).json({ error: 'Player ID is required' });
            }

            if (!rcon.getIsConnected()) {
                return res.status(503).json({ error: 'RCON not connected' });
            }

            rcon.sendCommand('kick ' + playerId + ' ' + reason);
            logger.log('dashboard_kick', { playerId: playerId, reason: reason });

            res.json({ success: true });
        } catch (error) {
            console.error('[Dashboard] Error kicking player:', error.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // --- Settings API ---
    app.get('/api/settings', requireAuth, function(req, res) {
        try {
            res.json(settings.getAll());
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.post('/api/settings', requireOwner, function(req, res) {
        try {
            var key = req.body.key;
            if (!key) return res.status(400).json({ error: 'Key is required' });

            if (req.body.value !== undefined) {
                settings.set(key, req.body.value);
            } else {
                settings.toggle(key);
            }

            logger.log('dashboard_settings', { key: key, value: settings.get(key) });
            res.json({ success: true, settings: settings.getAll() });
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // --- Registrations API ---
    app.get('/api/registrations', requireAuth, function(req, res) {
        try {
            var all = registrations.getAll();
            res.json({ count: all.length, entries: all });
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.delete('/api/registrations/:discordId', requireOwner, function(req, res) {
        try {
            var discordId = req.params.discordId;
            var reg = registrations.getByDiscordId(discordId);
            if (reg && whitelist.isWhitelisted(reg.gameUID)) {
                whitelist.removeFromWhitelist(reg.gameUID);
            }
            registrations.unregister(discordId);
            logger.log('dashboard_unregister', { discordId: discordId });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // --- Credit/Status Messages API (owner only) ---
    app.get('/api/credit', requireOwner, function(req, res) {
        try {
            res.json({
                statusMessages: settings.get('statusMessages') || [],
                statusInterval: settings.get('statusInterval') || 40
            });
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.post('/api/credit', requireOwner, function(req, res) {
        try {
            var unlockCode = req.body.unlockCode;
            var correctCode = settings.get('creditEditCode') || 'codex2015';

            if (unlockCode !== correctCode) {
                return res.status(403).json({ error: 'Invalid unlock code' });
            }

            if (req.body.statusMessages !== undefined) {
                var msgs = req.body.statusMessages;
                if (!Array.isArray(msgs) || msgs.length === 0) {
                    return res.status(400).json({ error: 'At least one status message is required' });
                }
                settings.set('statusMessages', msgs);
            }

            if (req.body.statusInterval !== undefined) {
                var interval = parseInt(req.body.statusInterval);
                if (interval < 10 || interval > 300) {
                    return res.status(400).json({ error: 'Interval must be 10-300 seconds' });
                }
                settings.set('statusInterval', interval);
            }

            if (req.body.creditEditCode !== undefined && req.body.creditEditCode.length >= 4) {
                settings.set('creditEditCode', req.body.creditEditCode);
            }

            logger.log('credit_updated', { by: 'dashboard' });
            res.json({ success: true, statusMessages: settings.get('statusMessages'), statusInterval: settings.get('statusInterval') });
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // --- Whitelist Codes API (owner only) ---
    app.get('/api/whitelistcodes', requireOwner, function(req, res) {
        try {
            var all = whitelistCodes.getAll();
            res.json({ count: all.length, codes: all });
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.post('/api/whitelistcodes', requireOwner, function(req, res) {
        try {
            var maxUses = parseInt(req.body.maxUses) || 0;
            var expiresInHours = parseInt(req.body.expiresInHours) || 0;
            var note = req.body.note || '';

            var result = whitelistCodes.generate(maxUses, expiresInHours, note);
            logger.log('whitelist_code_created', { code: result.code, maxUses: maxUses, expiresInHours: expiresInHours, note: note });
            res.json({ success: true, code: result.code });
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.delete('/api/whitelistcodes/:code', requireOwner, function(req, res) {
        try {
            var code = req.params.code;
            var success = whitelistCodes.remove(code);
            if (success) {
                logger.log('whitelist_code_deleted', { code: code });
            }
            res.json({ success: success });
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Protect dashboard page
    app.get('/dashboard.html', requireAuth, function(req, res, next) {
        next();
    });

    // 404
    app.use(function(req, res) {
        res.status(404).json({ error: 'Not found' });
    });

    // Error handler
    app.use(function(err, req, res, next) {
        console.error('[Dashboard] Error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    });
}

function start() {
    setupApp();

    return new Promise(function(resolve, reject) {
        try {
            var sslKeyPath = path.join(__dirname, '../ssl/key.pem');
            var sslCertPath = path.join(__dirname, '../ssl/cert.pem');
            var hasSSL = fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath);

            if (hasSSL) {
                // HTTPS on port 443 (standard)
                var sslOptions = {
                    key: fs.readFileSync(sslKeyPath),
                    cert: fs.readFileSync(sslCertPath)
                };

                server = https.createServer(sslOptions, app);
                server.listen(443, function() {
                    console.log('[Dashboard] HTTPS Server running on port 443');
                    console.log('[Dashboard] Access at: https://gunrun-tactical.duckdns.org');
                    resolve(server);
                });

                server.on('error', function(error) {
                    console.error('[Dashboard] HTTPS Server error:', error.message);
                    reject(error);
                });

                // HTTP on port 80 -> redirect to HTTPS
                var httpRedirect = http.createServer(function(req, res) {
                    var host = (req.headers.host || 'gunrun-tactical.duckdns.org').split(':')[0];
                    res.writeHead(301, { Location: 'https://' + host + req.url });
                    res.end();
                });
                httpRedirect.listen(80, function() {
                    console.log('[Dashboard] HTTP redirect on port 80 -> HTTPS 443');
                });
                httpRedirect.on('error', function(error) {
                    console.log('[Dashboard] Port 80 redirect unavailable: ' + error.code);
                });
            } else {
                // No SSL - HTTP only
                server = http.createServer(app);
                server.listen(config.dashboardPort, function() {
                    console.log('[Dashboard] HTTP Server running on port ' + config.dashboardPort);
                    console.log('[Dashboard] Access at: http://103.22.183.209:' + config.dashboardPort);
                    resolve(server);
                });

                server.on('error', function(error) {
                    console.error('[Dashboard] Server error:', error.message);
                    reject(error);
                });
            }
        } catch (error) {
            console.error('[Dashboard] Failed to start:', error.message);
            reject(error);
        }
    });
}

function stop() {
    return new Promise(function(resolve) {
        if (server) {
            server.close(function() {
                console.log('[Dashboard] Server stopped');
                resolve();
            });
        } else {
            resolve();
        }
    });
}

function getApp() {
    return app;
}

module.exports = {
    start: start,
    stop: stop,
    getApp: getApp
};
