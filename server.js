#!/usr/bin/env node
// server.js - Router Dashboard HTTP server (zero dependencies)
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const { spawn } = require('child_process');

const cfg         = require('./config');
const ucfg        = require('./user-config');

const PORT        = cfg.PORT;
const ROOT        = __dirname;
const DATA_DIR    = path.join(ROOT, 'data');
const COLLECT_SH  = path.join(ROOT, 'collect.sh');

// Collect state — prevent concurrent SSH runs
let collectBusy    = false;
let collectClients = [];

function runCollect() {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [COLLECT_SH], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME:         process.env.HOME || '/Users/bot',
        ROUTER_HOST:  cfg.ROUTER_HOST,
        ROUTER_USER:  cfg.ROUTER_USER,
        ROUTER_PASS:  cfg.ROUTER_PASS,
        ROUTER_PORT:  String(cfg.ROUTER_PORT),
      },
      timeout: 90_000
    });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    child.on('error', reject);
  });
}

function triggerCollect(res) {
  collectClients.push(res);
  if (collectBusy) return;
  collectBusy = true;
  runCollect()
    .then(() => {
      const body = JSON.stringify({ ok: true, ts: new Date().toISOString() });
      collectClients.forEach(r => send(r, 200, MIME['.json'], body));
    })
    .catch(err => {
      console.error('[collect]', err.message);
      const body = JSON.stringify({ ok: false, error: err.message });
      collectClients.forEach(r => send(r, 500, MIME['.json'], body));
    })
    .finally(() => { collectBusy = false; collectClients = []; });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css'
};

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function dataFiles() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('bad json')); }
    });
  });
}

// ── Auto-backup on startup (once per day) ─────────────────────────────────
setTimeout(() => {
  const backup = require('./backup');
  backup.autoBackupIfNeeded().then(r => {
    if (r) console.log('[backup] Auto-backup created:', r.filename);
  }).catch(e => console.error('[backup] Auto-backup failed:', e.message));
}, 10_000);

http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  // ── Static pages ───────────────────────────────────────────────────────

  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'));
    return send(res, 200, MIME['.html'], html);
  }

  if (pathname === '/health') {
    return send(res, 200, MIME['.json'], JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // ── Collection ─────────────────────────────────────────────────────────

  if (pathname === '/api/collect' && req.method === 'POST') return triggerCollect(res);
  if (pathname === '/api/status') return send(res, 200, MIME['.json'], JSON.stringify({ busy: collectBusy }));

  // ── Legacy JSON files ──────────────────────────────────────────────────

  if (pathname === '/data/latest') {
    const files = dataFiles();
    if (!files.length) return send(res, 404, MIME['.json'], '{"error":"no data yet"}');
    return send(res, 200, MIME['.json'], fs.readFileSync(path.join(DATA_DIR, files[0])));
  }

  if (pathname === '/data/history') {
    const days = Math.min(parseInt(query.days) || 7, 30);
    const history = dataFiles().slice(0, days).map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f))); } catch { return null; }
    }).filter(Boolean);
    return send(res, 200, MIME['.json'], JSON.stringify(history));
  }

  const dm = pathname.match(/^\/data\/(\d{4}-\d{2}-\d{2}\.json)$/);
  if (dm) {
    const fp = path.join(DATA_DIR, dm[1]);
    if (!fs.existsSync(fp)) return send(res, 404, MIME['.json'], '{"error":"not found"}');
    return send(res, 200, MIME['.json'], fs.readFileSync(fp));
  }

  // ── Intelligence API ───────────────────────────────────────────────────

  if (pathname === '/api/snapshots') {
    const store = require('./store');
    const hours = Math.min(parseInt(query.hours) || 24, 168);
    return send(res, 200, MIME['.json'], JSON.stringify(store.getSnapshots(hours)));
  }

  if (pathname === '/api/score/latest') {
    const store = require('./store');
    const row = store.getSnapshots(1)[0] || null;
    return send(res, 200, MIME['.json'], JSON.stringify(row
      ? { score: row.health, ping_rtt: row.ping_rtt, mem_pct: row.mem_pct, wan_up: row.wan_up, at: row.collected_at }
      : { score: null }
    ));
  }

  if (pathname === '/api/score/history') {
    const store = require('./store');
    const days = Math.min(parseInt(query.days) || 7, 30);
    return send(res, 200, MIME['.json'], JSON.stringify(store.getScoreHistory(days)));
  }

  if (pathname === '/api/events' && req.method !== 'POST') {
    const store = require('./store');
    const limit  = Math.min(parseInt(query.limit) || 50, 200);
    const offset = parseInt(query.offset) || 0;
    return send(res, 200, MIME['.json'],
      JSON.stringify(store.getEvents(limit, query.kind || null, query.severity || null, offset)));
  }

  if (pathname === '/api/events' && req.method === 'POST') {
    const store = require('./store');
    try {
      const { kind = 'manual', severity = 'info', title, detail } = await readBody(req);
      store.insertEvent(kind, severity, title || '手动标注', detail);
      return send(res, 200, MIME['.json'], '{"ok":true}');
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
  }

  if (pathname === '/api/devices') {
    const store = require('./store');
    const oui   = require('./oui');
    const devices = store.getDevices().map(d => ({
      ...d,
      vendor: oui.lookup(d.mac)?.vendor || null,
    }));
    return send(res, 200, MIME['.json'], JSON.stringify(devices));
  }

  if (pathname === '/api/oui' && query.mac) {
    const oui = require('./oui');
    return send(res, 200, MIME['.json'], JSON.stringify(oui.lookup(query.mac) || {}));
  }

  if (pathname === '/api/devices' && req.method === 'PUT') {
    const store = require('./store');
    try {
      const { mac, type, notes } = await readBody(req);
      if (type)  store.db().prepare('UPDATE devices SET type=? WHERE mac=?').run(type, mac);
      if (notes !== undefined) store.db().prepare('UPDATE devices SET notes=? WHERE mac=?').run(notes, mac);
      return send(res, 200, MIME['.json'], '{"ok":true}');
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
  }

  const macMatch = pathname.match(/^\/api\/devices\/([^/]+)\/hours$/);
  if (macMatch) {
    const store = require('./store');
    return send(res, 200, MIME['.json'], JSON.stringify(store.getDeviceHours(decodeURIComponent(macMatch[1]))));
  }

  if (pathname === '/api/budget' && req.method !== 'PUT') {
    const store = require('./store');
    return send(res, 200, MIME['.json'], JSON.stringify(store.getBudget(query.month)));
  }

  if (pathname === '/api/budget' && req.method === 'PUT') {
    const store = require('./store');
    try {
      const { budget_gb } = await readBody(req);
      const month = store.getMonth();
      store.db().prepare('INSERT OR IGNORE INTO monthly_traffic (month,rx_bytes,tx_bytes,budget_gb) VALUES (?,0,0,?)').run(month, 0);
      store.db().prepare('UPDATE monthly_traffic SET budget_gb=? WHERE month=?').run(budget_gb, month);
      return send(res, 200, MIME['.json'], '{"ok":true}');
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
  }

  if (pathname === '/api/summary/latest') {
    const store = require('./store');
    return send(res, 200, MIME['.json'], JSON.stringify(store.getLatestSummary() || {}));
  }

  if (pathname === '/api/summary/generate' && req.method === 'POST') {
    const ai = require('./ai');
    const date = new Date().toISOString().slice(0, 10);
    ai.generateDailySummary(date)
      .then(md => send(res, 200, MIME['.json'], JSON.stringify({ ok: true, md })))
      .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    return;
  }

  if (pathname === '/api/anomalies') {
    const store = require('./store');
    const hours = Math.min(parseInt(query.hours) || 24, 168);
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const rows  = store.getEvents(100, 'anomaly', null, 0).filter(e => e.occurred_at > since);
    return send(res, 200, MIME['.json'], JSON.stringify(rows));
  }

  if (pathname === '/api/diagnose' && req.method === 'POST') {
    const diagnose = require('./diagnose');
    diagnose.runDiagnosis()
      .then(result => send(res, 200, MIME['.json'], JSON.stringify(result || { error: 'no data' })))
      .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ error: e.message })));
    return;
  }

  if (pathname === '/api/analyze-logs' && req.method === 'POST') {
    const ai = require('./ai');
    try {
      const { lines } = await readBody(req);
      ai.analyzeLogs(lines || [])
        .then(md => send(res, 200, MIME['.json'], JSON.stringify({ ok: true, md })))
        .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
    return;
  }

  if (pathname === '/api/baselines/update' && req.method === 'POST') {
    const ai = require('./ai');
    ai.updateBaselines();
    return send(res, 200, MIME['.json'], '{"ok":true}');
  }

  // ── WiFi API ───────────────────────────────────────────────────────────

  if (pathname === '/api/wifi/clients') {
    const store = require('./store');
    const hours = Math.min(parseInt(query.hours) || 1, 24);
    return send(res, 200, MIME['.json'], JSON.stringify(store.getWifiClients(hours)));
  }

  if (pathname === '/api/wifi/history') {
    const store = require('./store');
    const days = Math.min(parseInt(query.days) || 7, 30);
    return send(res, 200, MIME['.json'], JSON.stringify(store.getWifiHistory(days)));
  }

  // Latest wifi from snapshot JSON
  if (pathname === '/api/wifi/latest') {
    const files = dataFiles();
    if (!files.length) return send(res, 200, MIME['.json'], JSON.stringify({ clients: [], by_band: {} }));
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[0])));
      return send(res, 200, MIME['.json'], JSON.stringify(snap.wifi || { clients: [], by_band: {} }));
    } catch { return send(res, 200, MIME['.json'], JSON.stringify({ clients: [], by_band: {} })); }
  }

  // ── Security API ───────────────────────────────────────────────────────

  if (pathname === '/api/security/events') {
    const store = require('./store');
    const hours = Math.min(parseInt(query.hours) || 24, 168);
    const type  = query.type || null;
    return send(res, 200, MIME['.json'], JSON.stringify(store.getSecurityEvents(100, type, hours)));
  }

  if (pathname === '/api/security/summary') {
    const store = require('./store');
    const hours = Math.min(parseInt(query.hours) || 24, 168);
    return send(res, 200, MIME['.json'], JSON.stringify(store.getSecuritySummary(hours)));
  }

  if (pathname === '/api/security/blocked') {
    const store = require('./store');
    return send(res, 200, MIME['.json'], JSON.stringify(store.getBlockedIps()));
  }

  if (pathname === '/api/security/block' && req.method === 'POST') {
    const store = require('./store');
    const remediate = require('./remediate');
    try {
      const { ip, reason } = await readBody(req);
      store.blockIp(ip, reason || '手动封锁', false);
      // Also apply iptables rule on router
      remediate.remoteExec(`iptables -I INPUT -s ${ip} -j DROP`).catch(() => {});
      store.insertEvent('security', 'warn', `🛡️ 手动封锁 IP: ${ip}`, reason);
      return send(res, 200, MIME['.json'], '{"ok":true}');
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
  }

  if (pathname === '/api/security/unblock' && req.method === 'POST') {
    const store = require('./store');
    const remediate = require('./remediate');
    try {
      const { ip } = await readBody(req);
      store.unblockIp(ip);
      remediate.remoteExec(`iptables -D INPUT -s ${ip} -j DROP`).catch(() => {});
      store.insertEvent('security', 'info', `✅ 已解封 IP: ${ip}`, '');
      return send(res, 200, MIME['.json'], '{"ok":true}');
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
  }

  // ── Speed test API ─────────────────────────────────────────────────────

  if (pathname === '/api/speedtest/run' && req.method === 'POST') {
    const speedtest = require('./speedtest');
    speedtest.runSpeedtest('manual')
      .then(r => send(res, 200, MIME['.json'], JSON.stringify({ ok: true, ...r })))
      .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    return;
  }

  if (pathname === '/api/speedtest/history') {
    const store = require('./store');
    const days = Math.min(parseInt(query.days) || 7, 30);
    return send(res, 200, MIME['.json'], JSON.stringify(store.getSpeedHistory(days)));
  }

  if (pathname === '/api/speedtest/latest') {
    const store = require('./store');
    return send(res, 200, MIME['.json'], JSON.stringify(store.getLatestSpeed() || {}));
  }

  // ── Packages API ───────────────────────────────────────────────────────

  if (pathname === '/api/packages') {
    const store = require('./store');
    const upgradeable = query.upgradeable === '1';
    return send(res, 200, MIME['.json'], JSON.stringify(store.getPackages(upgradeable)));
  }

  if (pathname === '/api/packages/install' && req.method === 'POST') {
    const remediate = require('./remediate');
    const store = require('./store');
    try {
      const { name } = await readBody(req);
      if (!name || !/^[\w\-\.]+$/.test(name)) return send(res, 400, MIME['.json'], '{"error":"invalid package name"}');
      remediate.remoteExec(`opkg update 2>&1 | tail -3; opkg install ${name} 2>&1`)
        .then(result => {
          store.insertEvent('packages', 'info', `📦 安装软件包: ${name}`, result.slice(0, 300));
          send(res, 200, MIME['.json'], JSON.stringify({ ok: true, result }));
        })
        .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
    return;
  }

  if (pathname === '/api/packages/remove' && req.method === 'POST') {
    const remediate = require('./remediate');
    const store = require('./store');
    try {
      const { name } = await readBody(req);
      if (!name || !/^[\w\-\.]+$/.test(name)) return send(res, 400, MIME['.json'], '{"error":"invalid package name"}');
      remediate.remoteExec(`opkg remove ${name} 2>&1`)
        .then(result => {
          store.insertEvent('packages', 'warn', `🗑️ 移除软件包: ${name}`, result.slice(0, 300));
          send(res, 200, MIME['.json'], JSON.stringify({ ok: true, result }));
        })
        .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
    return;
  }

  if (pathname === '/api/packages/upgrade' && req.method === 'POST') {
    const remediate = require('./remediate');
    const store = require('./store');
    try {
      const { name } = await readBody(req);
      if (!name || !/^[\w\-\.]+$/.test(name)) return send(res, 400, MIME['.json'], '{"error":"invalid package name"}');
      remediate.remoteExec(`opkg update 2>&1 | tail -2; opkg upgrade ${name} 2>&1`)
        .then(result => {
          store.insertEvent('packages', 'info', `⬆️ 升级软件包: ${name}`, result.slice(0, 300));
          send(res, 200, MIME['.json'], JSON.stringify({ ok: true, result }));
        })
        .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
    return;
  }

  // ── Backup API ─────────────────────────────────────────────────────────

  if (pathname === '/api/backups') {
    const backup = require('./backup');
    return send(res, 200, MIME['.json'], JSON.stringify(backup.listBackups()));
  }

  if (pathname === '/api/backups/create' && req.method === 'POST') {
    const backup = require('./backup');
    let note = '手动备份';
    try { const b = await readBody(req); note = b.note || note; } catch {}
    backup.createBackup(note)
      .then(r => send(res, 200, MIME['.json'], JSON.stringify({ ok: true, ...r })))
      .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    return;
  }

  if (pathname === '/api/backups/restore' && req.method === 'POST') {
    const backup = require('./backup');
    try {
      const { id } = await readBody(req);
      backup.restoreBackup(id)
        .then(r => send(res, 200, MIME['.json'], JSON.stringify({ ok: true, ...r })))
        .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
    return;
  }

  const backupDel = pathname.match(/^\/api\/backups\/(\d+)$/);
  if (backupDel && req.method === 'DELETE') {
    const backup = require('./backup');
    try {
      backup.deleteBackup(parseInt(backupDel[1]));
      return send(res, 200, MIME['.json'], '{"ok":true}');
    } catch (e) { return send(res, 404, MIME['.json'], JSON.stringify({ error: e.message })); }
  }

  // ── Remediation API ────────────────────────────────────────────────────

  if (pathname === '/api/remediation/log') {
    const store = require('./store');
    return send(res, 200, MIME['.json'], JSON.stringify(store.getRemediationLog()));
  }

  if (pathname === '/api/remediation/run' && req.method === 'POST') {
    const remediate = require('./remediate');
    try {
      const { action } = await readBody(req);
      remediate.manualFix(action)
        .then(r => send(res, 200, MIME['.json'], JSON.stringify({ ok: true, ...r })))
        .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
    return;
  }

  if (pathname === '/api/remediation/mode' && req.method === 'GET') {
    return send(res, 200, MIME['.json'], JSON.stringify({ mode: cfg.REMEDIATION_MODE }));
  }

  // ── AI Q&A ─────────────────────────────────────────────────────────────
  if (pathname === '/api/ai/ask' && req.method === 'POST') {
    const ai    = require('./ai');
    const store = require('./store');
    try {
      const { question } = await readBody(req);
      if (!question) return send(res, 400, MIME['.json'], '{"error":"missing question"}');
      // Build context from latest snapshot + recent events
      const files    = dataFiles();
      const latest   = files.length ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[0]))) : null;
      const events   = store.getEvents(10);
      const budget   = store.getBudget();
      const score    = store.getSnapshots(1)[0];
      const ctx = [
        latest ? `当前状态: WAN ${latest.wan.up ? '在线' : '断线'}, 外网IP ${latest.wan.ipv4_address || '无'}, ping ${latest.ping.rtt_avg_ms?.toFixed(0) || '—'}ms, 内存 ${latest.memory.total_kb ? Math.round(latest.memory.used_kb/latest.memory.total_kb*100) : '—'}%, CPU load_1 ${latest.system.load_1}, 在线设备 ${latest.dhcp_leases.length} 台` : '',
        score ? `健康评分: ${score.health}/100` : '',
        budget ? `本月流量: 下行 ${(budget.rx_bytes/1e9).toFixed(2)}GB 上行 ${(budget.tx_bytes/1e9).toFixed(2)}GB` : '',
        `最近事件:\n${events.slice(0,6).map(e=>`  [${e.severity}] ${e.title}`).join('\n')}`,
      ].filter(Boolean).join('\n');

      ai.callClaude(
        '你是一个专业的家庭网络运维助手，负责管理一台 GL-BE6500 路由器（OpenWrt）。请根据以下实时网络状态数据，用中文简洁专业地回答用户的问题。如果数据不足以回答，请明确说明。',
        `网络状态:\n${ctx}\n\n用户问题: ${question}`,
        800
      ).then(answer => send(res, 200, MIME['.json'], JSON.stringify({ ok: true, answer })))
        .catch(e => send(res, 500, MIME['.json'], JSON.stringify({ ok: false, error: e.message })));
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
    return;
  }

  // ── SSE Event Stream ────────────────────────────────────────────────────
  if (pathname === '/api/events/stream') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    // Send current latest snapshot immediately
    const store = require('./store');
    const snap  = store.getSnapshots(1)[0];
    if (snap) res.write(`data: ${JSON.stringify({ type: 'snapshot', ...snap })}\n\n`);

    // Poll for new events every 8 seconds and push to client
    let lastEventId = store.getEvents(1)[0]?.id || 0;
    const timer = setInterval(() => {
      try {
        const newSnap = store.getSnapshots(1)[0];
        if (newSnap) res.write(`data: ${JSON.stringify({ type: 'snapshot', health: newSnap.health, wan_up: newSnap.wan_up, ping_rtt: newSnap.ping_rtt, mem_pct: newSnap.mem_pct, dev_count: newSnap.dev_count })}\n\n`);
        const newEvents = store.getEvents(5).filter(e => e.id > lastEventId);
        for (const e of newEvents) {
          res.write(`data: ${JSON.stringify({ type: 'event', ...e })}\n\n`);
          lastEventId = Math.max(lastEventId, e.id);
        }
      } catch { clearInterval(timer); }
    }, 8_000);

    req.on('close', () => clearInterval(timer));
    return;
  }

  // ── Traffic Heatmap ─────────────────────────────────────────────────────
  if (pathname === '/api/traffic/heatmap') {
    const store = require('./store');
    // Returns 7×24 matrix: [day0..day6][hour0..hour23] = avg bytes/5min
    const rows = store.db().prepare(`
      SELECT
        CAST(julianday('now') - julianday(date(collected_at)) AS INTEGER) as days_ago,
        CAST(strftime('%H', collected_at) AS INTEGER) as hour,
        AVG(COALESCE(delta_rx,0) + COALESCE(delta_tx,0)) as avg_bytes
      FROM snapshots
      WHERE collected_at > datetime('now', '-7 days')
        AND (delta_rx IS NOT NULL OR delta_tx IS NOT NULL)
      GROUP BY days_ago, hour
      ORDER BY days_ago, hour
    `).all();
    // Build 7×24 matrix
    const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of rows) {
      const d = Math.min(6, Math.max(0, r.days_ago));
      const h = Math.min(23, Math.max(0, r.hour));
      matrix[d][h] = Math.round(r.avg_bytes || 0);
    }
    return send(res, 200, MIME['.json'], JSON.stringify(matrix));
  }

  // ── Config API ─────────────────────────────────────────────────────────
  if (pathname === '/api/config' && req.method === 'GET') {
    return send(res, 200, MIME['.json'], JSON.stringify(ucfg.readSafe()));
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    try {
      const updates = await readBody(req);
      // Sanitize: only allow known keys
      const allowed = ['router_host','router_user','router_pass','router_port',
                       'ai_key','ai_host','ai_path','ai_model',
                       'telegram_token','telegram_chat_id',
                       'monthly_budget_gb','remediation_mode','collect_interval_s','setup_done'];
      const safe = {};
      for (const k of allowed) if (updates[k] !== undefined) safe[k] = updates[k];
      ucfg.write(safe);
      return send(res, 200, MIME['.json'], '{"ok":true}');
    } catch { return send(res, 400, MIME['.json'], '{"error":"bad json"}'); }
  }

  if (pathname === '/api/setup/test-connection' && req.method === 'POST') {
    const { execSync } = require('child_process');
    try {
      const { host, user = 'root', pass, port = 22 } = await readBody(req);
      if (!host || !pass) return send(res, 400, MIME['.json'], '{"ok":false,"error":"host and pass required"}');
      // Quick SSH test: echo ok
      const result = execSync(
        `sshpass -p ${JSON.stringify(pass)} ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=no -p ${port} ${user}@${host} "echo ok"`,
        { timeout: 12_000, encoding: 'utf8' }
      ).trim();
      if (result === 'ok') return send(res, 200, MIME['.json'], '{"ok":true}');
      return send(res, 200, MIME['.json'], JSON.stringify({ ok: false, error: `Unexpected output: ${result}` }));
    } catch (e) {
      return send(res, 200, MIME['.json'], JSON.stringify({ ok: false, error: e.message.slice(0, 200) }));
    }
  }

  // ── WireGuard API ──────────────────────────────────────────────────────
  if (pathname === '/api/wireguard') {
    const files = dataFiles();
    if (!files.length) return send(res, 200, MIME['.json'], JSON.stringify({ enabled: false }));
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[0])));
      return send(res, 200, MIME['.json'], JSON.stringify(snap.wireguard || { enabled: false }));
    } catch { return send(res, 200, MIME['.json'], JSON.stringify({ enabled: false })); }
  }

  send(res, 404, MIME['.json'], '{"error":"not found"}');

}).listen(PORT, '0.0.0.0', () => {
  console.log(`Router Dashboard running at http://127.0.0.1:${PORT}`);
});
