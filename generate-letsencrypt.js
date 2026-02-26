/**
 * Let's Encrypt SSL Certificate Generator
 * Uses ACME HTTP-01 challenge to get a trusted certificate
 * 
 * Usage: node generate-letsencrypt.js
 * Note: Port 80 must be free (stop PM2 first: pm2 stop arma-whitelist)
 */

const acme = require('acme-client');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOMAIN = 'gunrun-tactical.duckdns.org';
const SSL_DIR = path.join(__dirname, 'ssl');
const KEY_PATH = path.join(SSL_DIR, 'key.pem');
const CERT_PATH = path.join(SSL_DIR, 'cert.pem');
const ACCOUNT_KEY_PATH = path.join(SSL_DIR, 'account-key.pem');

// Store for ACME challenge tokens
var challengeStore = {};

async function main() {
    console.log('=== Let\'s Encrypt Certificate Generator ===');
    console.log('Domain: ' + DOMAIN);
    console.log('');

    // Create SSL directory
    if (!fs.existsSync(SSL_DIR)) {
        fs.mkdirSync(SSL_DIR, { recursive: true });
    }

    // Start temporary HTTP server for ACME challenge on port 80
    console.log('[1/5] Starting HTTP challenge server on port 80...');
    var challengeServer = http.createServer(function(req, res) {
        var prefix = '/.well-known/acme-challenge/';
        if (req.url.startsWith(prefix)) {
            var token = req.url.slice(prefix.length);
            console.log('  -> Challenge request for token: ' + token);
            if (challengeStore[token]) {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(challengeStore[token]);
                console.log('  -> Responded with key authorization');
            } else {
                res.writeHead(404);
                res.end('Not found');
                console.log('  -> Token not found!');
            }
        } else {
            res.writeHead(200);
            res.end('ACME challenge server');
        }
    });

    await new Promise(function(resolve, reject) {
        challengeServer.listen(80, function() {
            console.log('  Challenge server listening on port 80');
            resolve();
        });
        challengeServer.on('error', function(err) {
            console.error('  ERROR: Cannot bind port 80 - ' + err.message);
            console.error('  Make sure to stop PM2 first: pm2 stop arma-whitelist');
            reject(err);
        });
    });

    try {
        // Create or load account key
        console.log('[2/5] Creating account key...');
        var accountKey;
        if (fs.existsSync(ACCOUNT_KEY_PATH)) {
            accountKey = fs.readFileSync(ACCOUNT_KEY_PATH);
            console.log('  Using existing account key');
        } else {
            accountKey = await acme.crypto.createPrivateKey();
            fs.writeFileSync(ACCOUNT_KEY_PATH, accountKey);
            console.log('  Generated new account key');
        }

        // Create ACME client (production)
        console.log('[3/5] Connecting to Let\'s Encrypt...');
        var client = new acme.Client({
            directoryUrl: acme.directory.letsencrypt.production,
            accountKey: accountKey
        });

        // Create CSR and private key for the domain
        console.log('[4/5] Creating certificate request for ' + DOMAIN + '...');
        var [domainKey, csr] = await acme.crypto.createCsr({
            commonName: DOMAIN
        });

        // Request certificate with HTTP-01 challenge
        console.log('[5/5] Requesting certificate (HTTP-01 challenge)...');
        var cert = await client.auto({
            csr: csr,
            email: 'admin@' + DOMAIN,
            termsOfServiceAgreed: true,
            challengeCreateFn: async function(authz, challenge, keyAuthorization) {
                console.log('  Setting up challenge: ' + challenge.token);
                challengeStore[challenge.token] = keyAuthorization;
            },
            challengeRemoveFn: async function(authz, challenge) {
                console.log('  Cleaning up challenge: ' + challenge.token);
                delete challengeStore[challenge.token];
            }
        });

        // Save certificate and key
        fs.writeFileSync(KEY_PATH, domainKey);
        fs.writeFileSync(CERT_PATH, cert);

        console.log('');
        console.log('=== SUCCESS ===');
        console.log('Certificate saved to: ' + CERT_PATH);
        console.log('Private key saved to: ' + KEY_PATH);
        console.log('');
        console.log('Certificate is valid for 90 days.');
        console.log('Now start the bot: pm2 restart arma-whitelist');

    } catch (err) {
        console.error('');
        console.error('=== ERROR ===');
        console.error(err.message || err);
    } finally {
        challengeServer.close();
        console.log('Challenge server stopped.');
    }
}

main().catch(function(err) {
    console.error('Fatal error:', err);
    process.exit(1);
});
