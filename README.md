# ArmaBot - Arma Reforger Whitelist & Server Management

A Discord bot integrated with Arma Reforger's BattlEye RCON (UDP) for whitelist management, player monitoring, and server administration — with a web dashboard secured by Let's Encrypt SSL.

---

## Features

### Discord Bot — 17 Slash Commands

#### Player Commands (Everyone)
| Command | Description |
|---------|-------------|
| `/register` | Link Discord ↔ Game UID (verify by 6-digit code in-game or direct UID) |
| `/unregister` | Unlink your account and remove whitelist |
| `/mystatus` | Check registration, whitelist, and credit status |
| `/requestwhitelist` | Request whitelist via Discord Role or Invite Code |
| `/serverinfo` | View server info, status, player count |
| `/help` | Show command guide (Thai) — separate views for players vs admins |

#### Admin Commands (BOT_ADMIN_IDS only)
| Command | Description |
|---------|-------------|
| `/whitelist add/remove/check/list` | Manage whitelist entries |
| `/players` | Show online players with details |
| `/kick <player>` | Kick by UID, name, or slot number |
| `/ban <player> [duration] [reason]` | Ban with optional duration |
| `/unban <player_id>` | Unban a player |
| `/broadcast <message>` | Broadcast message to all in-game players |
| `/rcon <command>` | Send raw RCON command |
| `/status` | Full system status (Bot, RCON, players, whitelist) |
| `/settings [toggle]` | Toggle whitelist, auto-kick, chat bridge, killfeed, etc. |
| `/sync` | Sync whitelist with Discord roles |
| `/logs [limit]` | View recent activity logs |

### Web Dashboard (Role-Based)
| Feature | Owner | Admin |
|---------|:-----:|:-----:|
| Online Players & Kick | ✅ | ✅ |
| Whitelist Management | ✅ | ✅ |
| Activity Logs | ✅ | ✅ |
| Registrations | ✅ | ✅ |
| RCON Console | ✅ | ❌ |
| Server Settings | ✅ | ❌ |
| Whitelist Invite Codes | ✅ | ❌ |
| Credit / Status Editor | ✅ | ❌ |

### Other Features
- **BattlEye UDP RCON** with CRC32 checksums, auto-reconnect, keepalive
- **Whitelist Enforcement** via 30-second player polling (detects joins/leaves)
- **Auto-kick** non-whitelisted players with configurable delay (default 120s)
- **Whitelist Invite Codes** — generate codes with max uses & expiry
- **Discord Notifications** — log, chat, killfeed, join/leave, status embed
- **Auto-updating Status Embed** — live player list in a Discord channel
- **Role-based Whitelist Sync** — add/remove Discord role = add/remove whitelist
- **Let's Encrypt SSL** — free trusted HTTPS certificate (auto-generated)
- **PM2 Process Management** — auto-restart, log rotation

---

## Requirements

- **Node.js** >= 18.0.0
- **npm** (comes with Node.js)
- **PM2** (recommended for production)
- **Discord Bot** with Privileged Gateway Intents:
  - ✅ Server Members Intent
  - ✅ Presence Intent
  - ✅ Message Content Intent
- **Arma Reforger Server** with BattlEye RCON enabled (UDP)
- **Domain** (optional, for SSL — e.g. free from [DuckDNS](https://www.duckdns.org))

---

## Setup — Windows Server

### Step 1: Install Node.js

Download and install from https://nodejs.org (LTS version recommended).

```powershell
# Verify installation
node -v    # Should show v18+ 
npm -v
```

### Step 2: Download & Install ArmaBot

```powershell
# Copy project to your desired location
cd C:\Users\Administrator\Desktop
git clone <repository-url> ArmaBot
cd ArmaBot

# Install dependencies
npm install

# Install PM2 globally
npm install -g pm2
```

### Step 3: Configure Environment

```powershell
# Copy example config
copy .env.example .env

# Edit with notepad (or any text editor)
notepad .env
```

Fill in all values (see [Configuration](#configuration) section below).

### Step 4: Open Firewall Ports

```powershell
# Dashboard HTTP (for SSL certificate generation + redirect)
netsh advfirewall firewall add rule name="ArmaBot HTTP" dir=in action=allow protocol=TCP localport=80

# Dashboard HTTPS
netsh advfirewall firewall add rule name="ArmaBot HTTPS" dir=in action=allow protocol=TCP localport=443
```

### Step 5: Setup Domain & SSL (Optional but Recommended)

#### 5a. Get a Free Domain (DuckDNS)

1. Go to https://www.duckdns.org and sign in
2. Create a subdomain (e.g. `your-server-name`)
3. Set the IP to your server's public IP
4. You now have `your-server-name.duckdns.org`

#### 5b. Generate SSL Certificate

```powershell
cd C:\Users\Administrator\Desktop\ArmaBot

# Generate Let's Encrypt SSL certificate (port 80 must be free)
node generate-letsencrypt.js
```

> **Note:** The certificate is valid for 90 days. Re-run the script to renew.
> PM2 must be stopped first: `pm2 stop arma-whitelist`

### Step 6: Start with PM2

```powershell
# Start
pm2 start ecosystem.config.js

# Save process list (auto-restart after reboot)
pm2 save

# Setup PM2 to start on Windows boot
# Option 1: Use pm2-windows-startup
npm install -g pm2-windows-startup
pm2-startup install

# Option 2: Create a scheduled task manually
# Action: Start a program
# Program: C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd
# Arguments: resurrect
# Trigger: At startup
```

### Step 7: Verify

```powershell
# Check status
pm2 status

# View logs
pm2 logs arma-whitelist

# Test dashboard
# With SSL: https://your-server-name.duckdns.org
# Without SSL: http://YOUR_IP:20000
```

---

## Setup — Linux (Ubuntu / Debian)

### Step 1: Install Node.js

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+ (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v    # Should show v18+
npm -v
```

### Step 2: Download & Install ArmaBot

```bash
cd ~
git clone <repository-url> ArmaBot
cd ArmaBot

# Install dependencies
npm install

# Install PM2 globally
sudo npm install -g pm2
```

### Step 3: Configure Environment

```bash
cp .env.example .env
nano .env
# Fill in all values (see Configuration section below)
# Press Ctrl+O to save, Ctrl+X to exit
```

### Step 4: Open Firewall Ports

```bash
# If using UFW (Ubuntu default)
sudo ufw allow 80/tcp     # HTTP (for SSL cert generation + redirect)
sudo ufw allow 443/tcp    # HTTPS dashboard
sudo ufw status

# If using firewalld (CentOS/Rocky)
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --reload
```

### Step 5: Setup Domain & SSL (Optional but Recommended)

#### 5a. Get a Free Domain (DuckDNS)

1. Go to https://www.duckdns.org and sign in
2. Create a subdomain → set IP to your server's public IP

#### 5b. Auto-Update DuckDNS IP (Optional)

```bash
# Create cron job to keep DNS updated
mkdir -p ~/duckdns
echo "url=\"https://www.duckdns.org/update?domains=YOUR_SUBDOMAIN&token=YOUR_TOKEN&ip=\"" > ~/duckdns/duck.sh
chmod +x ~/duckdns/duck.sh

# Add to crontab (runs every 5 minutes)
(crontab -l 2>/dev/null; echo "*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1") | crontab -
```

#### 5c. Generate SSL Certificate

```bash
cd ~/ArmaBot

# Stop PM2 first (port 80 must be free)
pm2 stop arma-whitelist 2>/dev/null

# Generate Let's Encrypt certificate
# May need sudo if port 80 requires root
sudo node generate-letsencrypt.js

# Fix permissions if generated with sudo
sudo chown $USER:$USER ssl/key.pem ssl/cert.pem
```

> Certificate is valid for 90 days. Renew by running the script again.

### Step 6: Start with PM2

```bash
# Start
pm2 start ecosystem.config.js

# Auto-start on boot
pm2 startup    # Follow the instructions it prints
pm2 save

# View logs
pm2 logs arma-whitelist
```

### Step 7: Verify

```bash
pm2 status
pm2 logs arma-whitelist --lines 30

# Test dashboard
curl -I https://your-server-name.duckdns.org
```

---

## Setup — Linux (CentOS / RHEL / Rocky)

```bash
# Install Node.js 18+
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Rest of the steps are the same as Ubuntu above
```

---

## Configuration

### .env File

```ini
# ===== Discord Bot =====
BOT_TOKEN=your_bot_token_here
GUILD_ID=your_discord_server_id
REQUIRED_ROLE_ID=your_whitelist_role_id

# Bot Admin IDs (comma-separated)
# Only these users can use admin commands
BOT_ADMIN_IDS=123456789012345678,987654321098765432

# ===== RCON (BattlEye UDP) =====
RCON_HOST=127.0.0.1
RCON_PORT=19999
RCON_PASSWORD=your_rcon_password

# ===== Discord Channels =====
LOG_CHANNEL_ID=your_log_channel_id
CHAT_CHANNEL_ID=your_chat_channel_id
KILLFEED_CHANNEL_ID=your_killfeed_channel_id
STATUS_CHANNEL_ID=your_status_channel_id

# ===== Whitelist Request =====
# Role that can use /requestwhitelist without invite code
WHITELIST_REQUEST_ROLE_ID=your_role_id

# Restrict bot commands to specific channels (comma-separated, empty = all)
ALLOWED_COMMAND_CHANNELS=

# ===== Dashboard =====
DASHBOARD_PORT=20000
OWNER_PASSWORD=your_owner_password       # Full access (RCON, settings, codes, credit)
ADMIN_PASSWORD=your_admin_password       # Limited access (players, whitelist, kick, logs)
SESSION_SECRET=your_random_secret_string
```

### How to Get Discord IDs

| What | How |
|------|-----|
| **BOT_TOKEN** | [Discord Developer Portal](https://discord.com/developers/applications) → Your App → Bot → Token |
| **GUILD_ID** | Enable Developer Mode → Right-click server icon → Copy Server ID |
| **ROLE_ID** | Right-click the role → Copy Role ID |
| **CHANNEL_ID** | Right-click the channel → Copy Channel ID |
| **USER_ID** | Right-click username → Copy User ID |

### Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. **New Application** → name it → go to **Bot** → **Add Bot** → Copy Token
3. Enable **Privileged Gateway Intents**:
   - ✅ Server Members Intent
   - ✅ Presence Intent
   - ✅ Message Content Intent
4. **OAuth2** → **URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Administrator`
5. Open the generated URL → invite bot to your Discord server

### Arma Reforger RCON Setup

Enable BattlEye RCON in your server config:

```json
{
  "game": {
    "battlEye": true
  },
  "rcon": {
    "address": "0.0.0.0",
    "port": 19999,
    "password": "your_rcon_password"
  }
}
```

> Make sure the RCON port (UDP) is open in your firewall.

---

## PM2 Commands

```bash
pm2 start ecosystem.config.js       # Start
pm2 stop arma-whitelist              # Stop
pm2 restart arma-whitelist           # Restart
pm2 logs arma-whitelist              # Live log stream
pm2 logs arma-whitelist --lines 50   # Last 50 lines
pm2 status                           # Process status
pm2 monit                            # Real-time monitoring
pm2 delete arma-whitelist            # Remove from PM2
pm2 save                             # Save process list
pm2 startup                          # Enable auto-start on boot
```

---

## SSL Certificate Renewal

The Let's Encrypt certificate expires every **90 days**. To renew:

### Windows
```powershell
cd C:\Users\Administrator\Desktop\ArmaBot
pm2 stop arma-whitelist
node generate-letsencrypt.js
pm2 restart arma-whitelist
```

### Linux
```bash
cd ~/ArmaBot
pm2 stop arma-whitelist
sudo node generate-letsencrypt.js
sudo chown $USER:$USER ssl/key.pem ssl/cert.pem
pm2 restart arma-whitelist
```

---

## Project Structure

```
ArmaBot/
├── index.js                    # Main entry point
├── config.js                   # Configuration loader (.env)
├── ecosystem.config.js         # PM2 process config
├── package.json                # Dependencies
├── generate-letsencrypt.js     # Let's Encrypt SSL generator
├── .env                        # Environment variables (DO NOT SHARE)
│
├── bot/
│   └── index.js                # Discord bot (17 commands, events, chat bridge)
├── rcon/
│   └── index.js                # BattlEye RCON client (UDP, CRC32)
├── dashboard/
│   └── index.js                # Express.js web server (HTTPS, role-based auth)
├── database/
│   ├── whitelist.js / .json    # Whitelist data
│   ├── registrations.js / .json # Discord ↔ Game UID links
│   ├── settings.js / .json     # Runtime settings
│   ├── whitelistCodes.js / .json # Invite codes
│   └── logger.js / logs.json   # Event logging
├── public/
│   ├── dashboard.html          # Admin dashboard UI
│   └── login.html              # Login page
├── ssl/
│   ├── key.pem                 # SSL private key (auto-generated)
│   └── cert.pem                # SSL certificate (auto-generated)
└── logs/                       # PM2 log files
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| RCON not connecting | Check `RCON_HOST`, `RCON_PORT`, `RCON_PASSWORD`. Ensure BattlEye RCON is enabled and UDP port is open |
| Bot not responding | Check `BOT_TOKEN`. Verify bot is in the correct server. Check `pm2 logs` for errors |
| Slash commands not showing | Restart bot, wait ~1 minute for Discord to register. Check `GUILD_ID` is correct |
| Dashboard not accessible | Check firewall rules for port 80/443. Run `pm2 logs` to check for startup errors |
| SSL certificate error | Run `node generate-letsencrypt.js` (stop PM2 first). Make sure domain points to server IP |
| "Not secure" warning | Self-signed cert — use `generate-letsencrypt.js` for a trusted Let's Encrypt cert instead |
| Players not being kicked | Ensure whitelist is ON in `/settings`. Check `pm2 logs` for "NOT whitelisted" messages |
| Permission denied (Linux) | Use `sudo` for global npm installs. Check file ownership with `ls -la` |
| Port already in use | Check with `netstat -tlnp` (Linux) or `netstat -an` (Windows). Kill the conflicting process |

---

## License

ISC
