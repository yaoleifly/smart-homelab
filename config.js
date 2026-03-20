'use strict';
// config.js - Runtime configuration
// Priority: env vars > user-config.json > defaults
// Credentials are NEVER hardcoded here — they live in data/user-config.json
const fs      = require('fs');
const path    = require('path');
const ucfg    = require('./user-config');

const uc = ucfg.read();

// ── AI endpoint resolution ─────────────────────────────────────────────────
function resolveAi() {
  // 1. Env var (CI / Docker)
  if (process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, host: 'api.anthropic.com', path: '/v1/messages' };
  }
  // 2. User-configured key from Settings page
  if (uc.ai_key) {
    return { key: uc.ai_key, host: uc.ai_host || 'api.anthropic.com', path: uc.ai_path || '/v1/messages' };
  }
  // 3. ~/.anthropic_key file (dev convenience)
  try {
    const k = fs.readFileSync(path.join(process.env.HOME || '~', '.anthropic_key'), 'utf8').trim();
    if (k && k.startsWith('sk-ant-api')) return { key: k, host: 'api.anthropic.com', path: '/v1/messages' };
  } catch {}
  // 4. Openclaw MiniMax Portal OAuth token
  try {
    const profiles = JSON.parse(fs.readFileSync(
      path.join(process.env.HOME || '~', '.openclaw/agents/main/agent/auth-profiles.json'), 'utf8'
    ));
    const mm = profiles.profiles?.['minimax-portal:default'];
    if (mm?.access && mm.expires > Date.now()) {
      return { key: mm.access, host: 'api.minimaxi.com', path: '/anthropic/v1/messages' };
    }
  } catch {}
  return { key: null, host: 'api.anthropic.com', path: '/v1/messages' };
}

// ── Telegram token resolution ──────────────────────────────────────────────
function resolveTelegram() {
  if (uc.telegram_token) return { token: uc.telegram_token, chat_id: uc.telegram_chat_id };
  try {
    const toml = fs.readFileSync(path.join(process.env.HOME || '~', '.cc-connect/config.toml'), 'utf8');
    const m = toml.match(/token\s*=\s*["']([^"']+)['"]/);
    if (m) return { token: m[1], chat_id: uc.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || '215430160' };
  } catch {}
  return { token: null, chat_id: null };
}

const _ai  = resolveAi();
const _tg  = resolveTelegram();

module.exports = Object.freeze({
  PORT:    parseInt(process.env.PORT || '7070', 10),
  DB_PATH: path.join(__dirname, 'data', 'monitor.db'),

  // Router SSH — read live from user-config so changes take effect on next collect
  get ROUTER_HOST() { return ucfg.read().router_host || process.env.ROUTER_HOST || ''; },
  get ROUTER_USER() { return ucfg.read().router_user || process.env.ROUTER_USER || 'root'; },
  get ROUTER_PASS() { return ucfg.read().router_pass || process.env.ROUTER_PASS || ''; },
  get ROUTER_PORT() { return ucfg.read().router_port || 22; },

  ANTHROPIC_KEY:   _ai.key,
  ANTHROPIC_HOST:  _ai.host,
  ANTHROPIC_PATH:  _ai.path,
  ANTHROPIC_MODEL: uc.ai_model || 'claude-sonnet-4-6',

  TELEGRAM_TOKEN:   _tg.token,
  TELEGRAM_CHAT_ID: _tg.chat_id,

  get MONTHLY_BUDGET_GB() { return ucfg.read().monthly_budget_gb || 0; },
  get REMEDIATION_MODE()  { return ucfg.read().remediation_mode  || 'observe'; },

  ANOMALY_SIGMA:  parseFloat(process.env.ANOMALY_SIGMA || '2.5'),
  BASELINE_DAYS:  parseInt(process.env.BASELINE_DAYS   || '7', 10),
  HEALTH_WEIGHTS: { wan: 0.30, ping: 0.25, mem: 0.20, load: 0.15, errors: 0.10 },
  WAN_IFACE:      process.env.WAN_IFACE || 'eth0',

  BACKUP_DIR: path.join(process.env.HOME || '/tmp', 'router-backups'),
});
