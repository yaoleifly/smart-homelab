'use strict';
const Database = require('better-sqlite3');
const cfg      = require('./config');

let _db = null;
function db() {
  if (_db) return _db;
  _db = new Database(cfg.DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  initSchema();
  return _db;
}

function initSchema() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      collected_at TEXT NOT NULL,
      date         TEXT NOT NULL,
      wan_up       INTEGER NOT NULL DEFAULT 1,
      wan_uptime_s INTEGER,
      ping_loss    INTEGER,
      ping_rtt     REAL,
      load_1       REAL,
      load_5       REAL,
      load_15      REAL,
      mem_pct      REAL,
      wan_rx       INTEGER,
      wan_tx       INTEGER,
      delta_rx     INTEGER,
      delta_tx     INTEGER,
      dev_count    INTEGER,
      health       INTEGER,
      raw          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_snap_at   ON snapshots(collected_at);
    CREATE INDEX IF NOT EXISTS idx_snap_date ON snapshots(date);

    CREATE TABLE IF NOT EXISTS devices (
      mac        TEXT PRIMARY KEY,
      hostname   TEXT,
      ip         TEXT,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      seen_count INTEGER DEFAULT 1,
      alerted    INTEGER DEFAULT 0,
      notes      TEXT,
      type       TEXT DEFAULT 'unknown'
    );

    CREATE TABLE IF NOT EXISTS device_presence (
      mac         TEXT NOT NULL,
      snapshot_id INTEGER NOT NULL,
      hour        INTEGER NOT NULL,
      PRIMARY KEY (mac, snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pres_mac ON device_presence(mac);

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      kind        TEXT NOT NULL,
      severity    TEXT NOT NULL,
      title       TEXT NOT NULL,
      detail      TEXT,
      mac         TEXT,
      snapshot_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_evt_at   ON events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_evt_kind ON events(kind);

    CREATE TABLE IF NOT EXISTS baselines (
      metric     TEXT PRIMARY KEY,
      mean       REAL NOT NULL,
      stddev     REAL NOT NULL,
      n          INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monthly_traffic (
      month     TEXT PRIMARY KEY,
      rx_bytes  INTEGER DEFAULT 0,
      tx_bytes  INTEGER DEFAULT 0,
      budget_gb INTEGER DEFAULT 0,
      warn_50   INTEGER DEFAULT 0,
      warn_80   INTEGER DEFAULT 0,
      warn_100  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS daily_summaries (
      date         TEXT PRIMARY KEY,
      generated_at TEXT NOT NULL,
      model        TEXT NOT NULL,
      score_avg    REAL,
      score_min    INTEGER,
      score_max    INTEGER,
      summary_md   TEXT NOT NULL
    );

    -- WiFi clients per snapshot
    CREATE TABLE IF NOT EXISTS wifi_clients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER,
      mac         TEXT NOT NULL,
      ip          TEXT,
      hostname    TEXT,
      signal      INTEGER,
      noise       INTEGER,
      tx_rate     INTEGER,
      rx_rate     INTEGER,
      band        TEXT,
      ssid        TEXT,
      seen_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wifi_snap ON wifi_clients(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_wifi_mac  ON wifi_clients(mac);
    CREATE INDEX IF NOT EXISTS idx_wifi_at   ON wifi_clients(seen_at);

    -- Security events
    CREATE TABLE IF NOT EXISTS security_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at TEXT NOT NULL,
      type        TEXT NOT NULL,
      src_ip      TEXT,
      count       INTEGER DEFAULT 1,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sec_at   ON security_events(detected_at);
    CREATE INDEX IF NOT EXISTS idx_sec_type ON security_events(type);

    -- Speed test results
    CREATE TABLE IF NOT EXISTS speedtest_results (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tested_at     TEXT NOT NULL,
      download_mbps REAL,
      upload_mbps   REAL,
      latency_ms    REAL,
      jitter_ms     REAL,
      server        TEXT,
      source        TEXT DEFAULT 'auto'
    );
    CREATE INDEX IF NOT EXISTS idx_speed_at ON speedtest_results(tested_at);

    -- Installed packages
    CREATE TABLE IF NOT EXISTS packages (
      name         TEXT PRIMARY KEY,
      version      TEXT,
      size_kb      INTEGER,
      description  TEXT,
      upgradeable  INTEGER DEFAULT 0,
      new_version  TEXT,
      updated_at   TEXT NOT NULL
    );

    -- Backup history
    CREATE TABLE IF NOT EXISTS backups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      filename   TEXT NOT NULL,
      size_bytes INTEGER,
      note       TEXT,
      status     TEXT DEFAULT 'ok'
    );

    -- Remediation log
    CREATE TABLE IF NOT EXISTS remediation_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      triggered_at TEXT NOT NULL,
      issue        TEXT NOT NULL,
      action       TEXT NOT NULL,
      result       TEXT,
      auto         INTEGER DEFAULT 0,
      success      INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_remed_at ON remediation_log(triggered_at);

    -- DNS stats over time
    CREATE TABLE IF NOT EXISTS dns_stats (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      collected_at TEXT NOT NULL,
      queries      INTEGER,
      cache_hits   INTEGER,
      cache_misses INTEGER,
      cache_size   INTEGER,
      blocked      INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dns_at ON dns_stats(collected_at);

    -- Firewall blocked IPs
    CREATE TABLE IF NOT EXISTS blocked_ips (
      ip         TEXT PRIMARY KEY,
      reason     TEXT,
      blocked_at TEXT NOT NULL,
      auto       INTEGER DEFAULT 0
    );
  `);
}

// ── Snapshots ─────────────────────────────────────────────────────────────
function insertSnapshot(s, health, deltaRx, deltaTx) {
  return db().prepare(`
    INSERT INTO snapshots
      (collected_at,date,wan_up,wan_uptime_s,ping_loss,ping_rtt,
       load_1,load_5,load_15,mem_pct,wan_rx,wan_tx,delta_rx,delta_tx,dev_count,health,raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    s.collected_at, s.date,
    s.wan.up ? 1 : 0, s.wan.uptime_seconds || 0,
    s.ping.packet_loss_pct, s.ping.rtt_avg_ms,
    s.system.load_1, s.system.load_5, s.system.load_15,
    s.memory.total_kb > 0 ? Math.round(s.memory.used_kb / s.memory.total_kb * 100) : null,
    wanBytes(s, 'rx'), wanBytes(s, 'tx'),
    deltaRx, deltaTx,
    s.dhcp_leases.length, health,
    JSON.stringify(s)
  );
}

function wanBytes(s, dir) {
  const iface = s.interfaces.find(i => i.name === s.wan.device || i.name === 'eth0');
  return iface ? iface[dir === 'rx' ? 'rx_bytes' : 'tx_bytes'] : null;
}

function getLastSnapshot() {
  return db().prepare('SELECT * FROM snapshots ORDER BY collected_at DESC LIMIT 1').get();
}

function getSnapshots(hoursBack = 24) {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  return db().prepare(
    'SELECT id,collected_at,health,ping_rtt,ping_loss,wan_up,delta_rx,delta_tx,mem_pct,dev_count,load_1 FROM snapshots WHERE collected_at > ? ORDER BY collected_at ASC'
  ).all(since);
}

function getScoreHistory(days = 7) {
  return db().prepare(`
    SELECT date,
      ROUND(AVG(health),1) as avg,
      MIN(health) as min,
      MAX(health) as max,
      COUNT(*) as n
    FROM snapshots WHERE health IS NOT NULL
    GROUP BY date ORDER BY date DESC LIMIT ?
  `).all(days);
}

function getSnapshotsForBaseline(days) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  return db().prepare(
    'SELECT ping_rtt,ping_loss,mem_pct,load_1,delta_rx,delta_tx FROM snapshots WHERE collected_at > ? AND health IS NOT NULL'
  ).all(since);
}

// ── Devices ───────────────────────────────────────────────────────────────
function upsertDevice(mac, hostname, ip, ts) {
  const existing = db().prepare('SELECT mac FROM devices WHERE mac = ?').get(mac);
  if (existing) {
    db().prepare('UPDATE devices SET hostname=?, ip=?, last_seen=?, seen_count=seen_count+1 WHERE mac=?')
        .run(hostname, ip, ts, mac);
    return false;
  } else {
    db().prepare('INSERT INTO devices (mac,hostname,ip,first_seen,last_seen) VALUES (?,?,?,?,?)')
        .run(mac, hostname, ip, ts, ts);
    return true;
  }
}

function getDevices() {
  return db().prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
}

function getDeviceHours(mac) {
  const rows = db().prepare(
    'SELECT hour, COUNT(*) as cnt FROM device_presence WHERE mac=? GROUP BY hour'
  ).all(mac);
  const arr = new Array(24).fill(0);
  rows.forEach(r => { arr[r.hour] = r.cnt; });
  return arr;
}

function insertDevicePresence(mac, snapshotId, hour) {
  try {
    db().prepare('INSERT OR IGNORE INTO device_presence (mac,snapshot_id,hour) VALUES (?,?,?)').run(mac, snapshotId, hour);
  } catch {}
}

function getNewUnalertedDevices() {
  return db().prepare('SELECT * FROM devices WHERE alerted = 0').all();
}

function markDeviceAlerted(mac) {
  db().prepare('UPDATE devices SET alerted=1 WHERE mac=?').run(mac);
}

function updateDeviceType(mac, type) {
  db().prepare('UPDATE devices SET type=? WHERE mac=?').run(type, mac);
}

// ── Events ────────────────────────────────────────────────────────────────
function insertEvent(kind, severity, title, detail, mac, snapshotId) {
  return db().prepare(
    'INSERT INTO events (occurred_at,kind,severity,title,detail,mac,snapshot_id) VALUES (?,?,?,?,?,?,?)'
  ).run(new Date().toISOString(), kind, severity, title, detail || null, mac || null, snapshotId || null);
}

function getEvents(limit = 50, kind = null, severity = null, offset = 0) {
  let q = 'SELECT * FROM events WHERE 1=1';
  const params = [];
  if (kind)     { q += ' AND kind=?';     params.push(kind); }
  if (severity) { q += ' AND severity=?'; params.push(severity); }
  q += ' ORDER BY occurred_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db().prepare(q).all(...params);
}

// ── Baselines ─────────────────────────────────────────────────────────────
function upsertBaseline(metric, mean, stddev, n) {
  db().prepare('INSERT OR REPLACE INTO baselines (metric,mean,stddev,n,updated_at) VALUES (?,?,?,?,?)')
      .run(metric, mean, stddev, n, new Date().toISOString());
}

function getBaselines() {
  const rows = db().prepare('SELECT * FROM baselines').all();
  const m = {};
  rows.forEach(r => { m[r.metric] = r; });
  return m;
}

// ── Monthly traffic ────────────────────────────────────────────────────────
function getMonth() { return new Date().toISOString().slice(0, 7); }

function addMonthlyTraffic(rx, tx) {
  const month = getMonth();
  db().prepare(`
    INSERT INTO monthly_traffic (month,rx_bytes,tx_bytes,budget_gb)
    VALUES (?,?,?,?)
    ON CONFLICT(month) DO UPDATE SET rx_bytes=rx_bytes+excluded.rx_bytes, tx_bytes=tx_bytes+excluded.tx_bytes
  `).run(month, rx || 0, tx || 0, cfg.MONTHLY_BUDGET_GB);
  return db().prepare('SELECT * FROM monthly_traffic WHERE month=?').get(month);
}

function getBudget(month) {
  return db().prepare('SELECT * FROM monthly_traffic WHERE month=?').get(month || getMonth());
}

function setBudgetWarn(month, field) {
  db().prepare(`UPDATE monthly_traffic SET ${field}=1 WHERE month=?`).run(month);
}

// ── Daily summaries ────────────────────────────────────────────────────────
function saveSummary(date, model, scoreAvg, scoreMin, scoreMax, md) {
  db().prepare(`
    INSERT OR REPLACE INTO daily_summaries (date,generated_at,model,score_avg,score_min,score_max,summary_md)
    VALUES (?,?,?,?,?,?,?)
  `).run(date, new Date().toISOString(), model, scoreAvg, scoreMin, scoreMax, md);
}

function getLatestSummary() {
  return db().prepare('SELECT * FROM daily_summaries ORDER BY date DESC LIMIT 1').get();
}

// ── WiFi clients ───────────────────────────────────────────────────────────
function insertWifiClients(clients, snapshotId) {
  const now = new Date().toISOString();
  const stmt = db().prepare(
    'INSERT INTO wifi_clients (snapshot_id,mac,ip,hostname,signal,noise,tx_rate,rx_rate,band,ssid,seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  const insert = db().transaction(cs => {
    for (const c of cs) stmt.run(snapshotId, c.mac, c.ip||null, c.hostname||null, c.signal||null, c.noise||null, c.tx_rate||null, c.rx_rate||null, c.band||null, c.ssid||null, now);
  });
  insert(clients);
}

function getWifiClients(hoursBack = 1) {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  return db().prepare('SELECT * FROM wifi_clients WHERE seen_at > ? ORDER BY seen_at DESC').all(since);
}

function getWifiHistory(days = 7) {
  return db().prepare(`
    SELECT date(seen_at) as date, band, COUNT(DISTINCT mac) as unique_clients, AVG(signal) as avg_signal
    FROM wifi_clients WHERE seen_at > datetime('now', ? || ' days')
    GROUP BY date(seen_at), band ORDER BY date DESC
  `).all('-' + days);
}

// ── Security events ────────────────────────────────────────────────────────
function insertSecurityEvent(type, srcIp, count, detail) {
  return db().prepare(
    'INSERT INTO security_events (detected_at,type,src_ip,count,detail) VALUES (?,?,?,?,?)'
  ).run(new Date().toISOString(), type, srcIp||null, count||1, detail||null);
}

function getSecurityEvents(limit = 50, type = null, hoursBack = 24) {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  let q = 'SELECT * FROM security_events WHERE detected_at > ?';
  const params = [since];
  if (type) { q += ' AND type=?'; params.push(type); }
  q += ' ORDER BY detected_at DESC LIMIT ?';
  params.push(limit);
  return db().prepare(q).all(...params);
}

function getSecuritySummary(hoursBack = 24) {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  return db().prepare(`
    SELECT type, COUNT(*) as cnt, SUM(count) as total_count
    FROM security_events WHERE detected_at > ?
    GROUP BY type ORDER BY total_count DESC
  `).all(since);
}

// ── Blocked IPs ────────────────────────────────────────────────────────────
function blockIp(ip, reason, auto = false) {
  db().prepare('INSERT OR REPLACE INTO blocked_ips (ip,reason,blocked_at,auto) VALUES (?,?,?,?)').run(ip, reason, new Date().toISOString(), auto ? 1 : 0);
}

function getBlockedIps() {
  return db().prepare('SELECT * FROM blocked_ips ORDER BY blocked_at DESC').all();
}

function unblockIp(ip) {
  db().prepare('DELETE FROM blocked_ips WHERE ip=?').run(ip);
}

// ── Speed tests ────────────────────────────────────────────────────────────
function insertSpeedtest(down, up, latency, jitter, server, source) {
  return db().prepare(
    'INSERT INTO speedtest_results (tested_at,download_mbps,upload_mbps,latency_ms,jitter_ms,server,source) VALUES (?,?,?,?,?,?,?)'
  ).run(new Date().toISOString(), down, up, latency, jitter, server||null, source||'auto');
}

function getSpeedHistory(days = 7) {
  return db().prepare(
    'SELECT * FROM speedtest_results WHERE tested_at > datetime(\'now\', ? || \' days\') ORDER BY tested_at ASC'
  ).all('-' + days);
}

function getLatestSpeed() {
  return db().prepare('SELECT * FROM speedtest_results ORDER BY tested_at DESC LIMIT 1').get();
}

// ── Packages ───────────────────────────────────────────────────────────────
function upsertPackages(pkgList, upgradeableList) {
  const now = new Date().toISOString();
  const upgradeMap = {};
  for (const u of upgradeableList) upgradeMap[u.name] = u.new_version;

  const stmt = db().prepare(`
    INSERT OR REPLACE INTO packages (name,version,size_kb,description,upgradeable,new_version,updated_at)
    VALUES (?,?,?,?,?,?,?)
  `);
  const run = db().transaction(pkgs => {
    for (const p of pkgs) {
      stmt.run(p.name, p.version, p.size_kb||null, p.description||null,
               upgradeMap[p.name] ? 1 : 0, upgradeMap[p.name]||null, now);
    }
  });
  run(pkgList);
}

function getPackages(upgradeableOnly = false) {
  if (upgradeableOnly) return db().prepare('SELECT * FROM packages WHERE upgradeable=1 ORDER BY name').all();
  return db().prepare('SELECT * FROM packages ORDER BY name').all();
}

// ── Backups ────────────────────────────────────────────────────────────────
function insertBackup(filename, sizeBytes, note) {
  return db().prepare('INSERT INTO backups (created_at,filename,size_bytes,note) VALUES (?,?,?,?)').run(new Date().toISOString(), filename, sizeBytes||null, note||null);
}

function getBackups() {
  return db().prepare('SELECT * FROM backups ORDER BY created_at DESC').all();
}

// ── Remediation ────────────────────────────────────────────────────────────
function insertRemediationLog(issue, action, result, auto, success) {
  return db().prepare(
    'INSERT INTO remediation_log (triggered_at,issue,action,result,auto,success) VALUES (?,?,?,?,?,?)'
  ).run(new Date().toISOString(), issue, action, result||null, auto?1:0, success?1:0);
}

function getRemediationLog(limit = 30) {
  return db().prepare('SELECT * FROM remediation_log ORDER BY triggered_at DESC LIMIT ?').all(limit);
}

// ── DNS stats ──────────────────────────────────────────────────────────────
function insertDnsStats(queries, hits, misses, cacheSize, blocked) {
  return db().prepare(
    'INSERT INTO dns_stats (collected_at,queries,cache_hits,cache_misses,cache_size,blocked) VALUES (?,?,?,?,?,?)'
  ).run(new Date().toISOString(), queries||null, hits||null, misses||null, cacheSize||null, blocked||0);
}

function getDnsHistory(hoursBack = 24) {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  return db().prepare('SELECT * FROM dns_stats WHERE collected_at > ? ORDER BY collected_at ASC').all(since);
}

module.exports = {
  db,
  // snapshots
  insertSnapshot, getLastSnapshot, getSnapshots, getScoreHistory, getSnapshotsForBaseline,
  // devices
  upsertDevice, getDevices, getDeviceHours, insertDevicePresence,
  getNewUnalertedDevices, markDeviceAlerted, updateDeviceType,
  // events
  insertEvent, getEvents,
  // baselines
  upsertBaseline, getBaselines,
  // traffic
  addMonthlyTraffic, getBudget, setBudgetWarn, getMonth,
  // summaries
  saveSummary, getLatestSummary,
  // wifi
  insertWifiClients, getWifiClients, getWifiHistory,
  // security
  insertSecurityEvent, getSecurityEvents, getSecuritySummary,
  blockIp, getBlockedIps, unblockIp,
  // speedtest
  insertSpeedtest, getSpeedHistory, getLatestSpeed,
  // packages
  upsertPackages, getPackages,
  // backups
  insertBackup, getBackups,
  // remediation
  insertRemediationLog, getRemediationLog,
  // dns
  insertDnsStats, getDnsHistory,
  // helpers
  wanBytes,
};
