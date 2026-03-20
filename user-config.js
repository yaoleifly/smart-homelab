'use strict';
// user-config.js - Persistent user configuration (stored in data/user-config.json)
// This is the single source of truth for all user-supplied settings.
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'data', 'user-config.json');

const DEFAULTS = {
  // Router SSH
  router_host: '',
  router_user: 'root',
  router_pass: '',
  router_port: 22,

  // AI
  ai_key:   '',
  ai_host:  'api.anthropic.com',
  ai_path:  '/v1/messages',
  ai_model: 'claude-sonnet-4-6',

  // Telegram (optional)
  telegram_token:   '',
  telegram_chat_id: '',

  // Operational
  monthly_budget_gb:  0,
  remediation_mode:   'observe',   // 'observe' | 'auto'
  collect_interval_s: 300,

  // Setup state
  setup_done: false,
};

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(updates) {
  const current = read();
  const next    = { ...current, ...updates };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

function isConfigured() {
  const c = read();
  return !!(c.router_host && c.router_pass && c.setup_done);
}

// Returns a safe version for the frontend (no passwords)
function readSafe() {
  const c = read();
  return {
    router_host:        c.router_host,
    router_user:        c.router_user,
    router_pass:        c.router_pass ? '••••••••' : '',
    router_port:        c.router_port,
    ai_key:             c.ai_key ? '••••••••' : '',
    ai_host:            c.ai_host,
    ai_model:           c.ai_model,
    telegram_token:     c.telegram_token ? '••••••••' : '',
    telegram_chat_id:   c.telegram_chat_id,
    monthly_budget_gb:  c.monthly_budget_gb,
    remediation_mode:   c.remediation_mode,
    collect_interval_s: c.collect_interval_s,
    setup_done:         c.setup_done,
    has_ai_key:         !!c.ai_key,
    has_telegram:       !!(c.telegram_token && c.telegram_chat_id),
  };
}

module.exports = { read, write, readSafe, isConfigured, DEFAULTS, CONFIG_PATH };
