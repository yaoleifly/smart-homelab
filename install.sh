#!/usr/bin/env bash
# Smart Homelab — one-liner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/YOUR_USER/smart-homelab/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/yaoleifly/smart-homelab"
INSTALL_DIR="${INSTALL_DIR:-$HOME/smart-homelab}"
NODE_MIN=18

# ── Helpers ────────────────────────────────────────────────────────────────
red()  { echo -e "\033[0;31m$*\033[0m"; }
green(){ echo -e "\033[0;32m$*\033[0m"; }
info() { echo -e "\033[0;36m▶ $*\033[0m"; }

need() {
  command -v "$1" &>/dev/null || { red "Missing: $1. Please install it and retry."; exit 1; }
}

# ── Prereqs ────────────────────────────────────────────────────────────────
info "Checking prerequisites…"
need git
need node
need npm
need sshpass

NODE_VER=$(node -e "process.exit(parseInt(process.versions.node)<${NODE_MIN}?1:0)" 2>/dev/null && echo ok || echo old)
if [ "$NODE_VER" = "old" ]; then
  red "Node.js >= ${NODE_MIN} required (found: $(node -v))"; exit 1
fi

# ── Clone / update ──────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation at $INSTALL_DIR …"
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning into $INSTALL_DIR …"
  git clone "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── Dependencies ────────────────────────────────────────────────────────────
info "Installing Node.js dependencies…"
npm install --omit=dev

# ── Data directory ──────────────────────────────────────────────────────────
mkdir -p data logs

# ── Start / restart ─────────────────────────────────────────────────────────
if command -v pm2 &>/dev/null; then
  info "Starting with pm2…"
  pm2 describe smart-homelab &>/dev/null && pm2 restart smart-homelab || \
    pm2 start server.js --name smart-homelab
  pm2 save
else
  info "pm2 not found — starting in background with nohup…"
  nohup node server.js >> logs/server.log 2>&1 &
  echo $! > .server.pid
fi

green "
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Smart Homelab installed at: $INSTALL_DIR
  Open: http://localhost:7070
  Configure SSH / API key in: Settings page
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"
