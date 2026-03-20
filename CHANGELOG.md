# Changelog

All notable changes to Smart Homelab are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.1.0] - 2026-03-20

### Added
- **Setup Wizard** — step-by-step first-run guide (SSH → AI → Done)
- **Demo Mode** — simulated data renders the full UI before a router is connected
- **Connection status chip** — topbar shows real-time status: 未配置 / 连接中 / 已连接 / 连接失败
- **Settings page** — in-browser configuration panel for all credentials and parameters
- **`/api/config` GET/POST** — read and write user settings without restarting the server
- **`/api/setup/test-connection` POST** — live SSH connectivity test from the browser
- **`install.sh`** — one-liner installer with pm2 and nohup fallback
- **`.gitignore`** — excludes `data/`, `logs/`, `node_modules/`, credentials
- **`CONTRIBUTING.md`** — developer setup, PR workflow, coding conventions
- **`CHANGELOG.md`** — this file
- **GitHub Issue templates** — Bug Report and Feature Request
- **GitHub Actions CI** — syntax check on every push/PR

### Changed
- `collect.sh` now reads credentials from environment variables (passed by server.js) — no hardcoded values
- `config.js` rewritten: priority chain env vars → `data/user-config.json` → `~/.anthropic_key` → openclaw OAuth
- `package.json` renamed to `smart-homelab`, license MIT, engines `node>=18`

### Security
- Credentials never hardcoded in any source file
- `data/user-config.json` excluded from git

---

## [1.0.0] - 2026-03-15

### Added
- Real-time router monitoring via SSH (WAN, ping, memory, load, storage)
- Health scoring algorithm (0–100) with smooth curves and noise filtering
- Traffic delta tracking with 7×24 heatmap visualization
- WiFi client monitoring via `hostapd_cli` + `iw station dump`
- DHCP device tracking with MAC OUI auto-classification (250+ vendor prefixes)
- Security audit: SSH brute-force detection, firewall drop stats, IP block/unblock
- AI Q&A assistant powered by Claude API
- Statistical anomaly detection (σ = 2.5 baseline)
- Auto-remediation: restart WAN/DNS/WiFi, drop caches, reboot (observe/auto mode)
- Extended alert rules: ping spike, sustained load, memory pressure, health decline, night activity
- Telegram push notifications for critical events
- SSE real-time event stream with toast notifications
- OpenWrt package manager (browse, install, upgrade, remove via opkg)
- Config backup and restore
- WAN speed test with history chart
- Mobile responsive layout with bottom navigation bar
- SQLite database with WAL mode (better-sqlite3)
- Zero external HTTP dependencies — pure Node.js stdlib server
