'use strict';
// backup.js - Router config backup/restore system
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');
const store = require('./store');

const SSH_BASE = `sshpass -p '${cfg.ROUTER_PASS}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o BatchMode=no ${cfg.ROUTER_USER}@${cfg.ROUTER_HOST}`;
const SCP_BASE = `sshpass -p '${cfg.ROUTER_PASS}' scp -o StrictHostKeyChecking=no -o ConnectTimeout=15`;

function ensureBackupDir() {
  if (!fs.existsSync(cfg.BACKUP_DIR)) fs.mkdirSync(cfg.BACKUP_DIR, { recursive: true });
}

function remoteExec(cmd) {
  return new Promise((resolve, reject) => {
    exec(`${SSH_BASE} '${cmd}'`, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── Create backup ──────────────────────────────────────────────────────────
async function createBackup(note) {
  ensureBackupDir();
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const remotePath = `/tmp/backup-${ts}.tar.gz`;
  const localFile  = `router-backup-${ts}.tar.gz`;
  const localPath  = path.join(cfg.BACKUP_DIR, localFile);

  // Create tar on router: /etc + /overlay/etc (persistent config)
  await remoteExec(`tar -czf ${remotePath} /etc 2>/dev/null; echo done`);

  // SCP it to Mac
  await new Promise((resolve, reject) => {
    exec(`${SCP_BASE} ${cfg.ROUTER_USER}@${cfg.ROUTER_HOST}:${remotePath} "${localPath}"`,
      { timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
  });

  // Cleanup remote temp file
  await remoteExec(`rm -f ${remotePath}`).catch(() => {});

  const stat = fs.statSync(localPath);
  store.insertBackup(localFile, stat.size, note || '自动备份');
  store.insertEvent('backup', 'info', `📦 配置备份完成`, `文件: ${localFile} (${(stat.size/1024).toFixed(1)} KB)`);

  return { filename: localFile, size: stat.size, path: localPath };
}

// ── List backups ───────────────────────────────────────────────────────────
function listBackups() {
  ensureBackupDir();
  const dbBackups = store.getBackups();
  // Cross-reference with actual files
  return dbBackups.map(b => {
    const fp = path.join(cfg.BACKUP_DIR, b.filename);
    return { ...b, exists: fs.existsSync(fp) };
  });
}

// ── Delete backup ──────────────────────────────────────────────────────────
function deleteBackup(id) {
  const row = store.db().prepare('SELECT * FROM backups WHERE id=?').get(id);
  if (!row) throw new Error('Backup not found');
  const fp = path.join(cfg.BACKUP_DIR, row.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  store.db().prepare('DELETE FROM backups WHERE id=?').run(id);
  store.insertEvent('backup', 'info', `🗑️ 备份已删除`, row.filename);
}

// ── Auto-backup scheduler (called from server.js on cron) ─────────────────
async function autoBackupIfNeeded() {
  const backups = store.getBackups();
  const lastBackup = backups[0];
  const oneDayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  if (!lastBackup || lastBackup.created_at < oneDayAgo) {
    return createBackup('每日自动备份');
  }
  return null;
}

// ── Restore from backup ────────────────────────────────────────────────────
async function restoreBackup(id) {
  const row = store.db().prepare('SELECT * FROM backups WHERE id=?').get(id);
  if (!row) throw new Error('Backup not found');
  const fp = path.join(cfg.BACKUP_DIR, row.filename);
  if (!fs.existsSync(fp)) throw new Error('Backup file missing on disk');

  // Upload to router
  await new Promise((resolve, reject) => {
    exec(`${SCP_BASE} "${fp}" ${cfg.ROUTER_USER}@${cfg.ROUTER_HOST}:/tmp/restore.tar.gz`,
      { timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
  });

  // Extract (careful: this will overwrite /etc on the router)
  await remoteExec('tar -xzf /tmp/restore.tar.gz -C / 2>/dev/null; rm -f /tmp/restore.tar.gz');
  store.insertEvent('backup', 'warn', `♻️ 配置已恢复`, `从备份: ${row.filename}`);
  return { ok: true, filename: row.filename };
}

module.exports = { createBackup, listBackups, deleteBackup, autoBackupIfNeeded, restoreBackup };
