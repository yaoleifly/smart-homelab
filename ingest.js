'use strict';
// ingest.js - called from parser.js after snapshot JSON is written
// Usage: node ingest.js <json_file_path>
const fs      = require('fs');
const store   = require('./store');
const ai      = require('./ai');
const alerts  = require('./alerts');
const remediate = require('./remediate');
const oui     = require('./oui');

const file = process.argv[2];
if (!file) { console.error('[ingest] No file path given'); process.exit(1); }

async function main() {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Compute delta vs last snapshot
  const last     = store.getLastSnapshot();
  let deltaRx = null, deltaTx = null;
  if (last) {
    const prevRaw = JSON.parse(last.raw);
    const prevRx  = store.wanBytes(prevRaw, 'rx');
    const prevTx  = store.wanBytes(prevRaw, 'tx');
    const curRx   = store.wanBytes(snapshot, 'rx');
    const curTx   = store.wanBytes(snapshot, 'tx');
    if (prevRx != null && curRx != null && curRx >= prevRx) deltaRx = curRx - prevRx;
    if (prevTx != null && curTx != null && curTx >= prevTx) deltaTx = curTx - prevTx;
  }

  // Health score
  const { score } = ai.scoreSnapshot(snapshot);

  // Insert snapshot
  const result = store.insertSnapshot(snapshot, score, deltaRx, deltaTx);
  const snapId = result.lastInsertRowid;

  // WAN events
  if (!snapshot.wan.up) {
    store.insertEvent('wan_down', 'error', 'WAN 断线', `WAN 接口 down，协议: ${snapshot.wan.proto}`, null, snapId);
    alerts.sendTelegram(`🔴 *家庭网络 WAN 断线*\n协议: ${snapshot.wan.proto || '未知'}\n时间: ${new Date().toLocaleString('zh-CN')}`);
  } else if (last && JSON.parse(last.raw).wan?.up === false) {
    store.insertEvent('wan_up', 'info', 'WAN 已恢复', `外网 IP: ${snapshot.wan.ipv4_address}`, null, snapId);
    alerts.sendTelegram(`✅ *家庭网络 WAN 已恢复*\n外网 IP: ${snapshot.wan.ipv4_address}`);
  }

  // Upsert devices + presence + OUI classification
  const hour = new Date().getHours();
  for (const lease of snapshot.dhcp_leases) {
    store.upsertDevice(lease.mac, lease.hostname, lease.ip, snapshot.collected_at);
    store.insertDevicePresence(lease.mac, snapId, hour);
    // Auto-classify device type from MAC OUI if not yet set
    const existing = store.getDevices().find(d => d.mac === lease.mac);
    if (existing && (!existing.type || existing.type === 'unknown')) {
      const match = oui.lookup(lease.mac);
      if (match) store.updateDeviceType(lease.mac, match.type);
    }
  }

  // New device alerts
  alerts.checkNewDevices();

  // Anomaly detection (statistical baseline)
  ai.checkAnomalies(snapshot, snapId);

  // Rule-based alert checks
  alerts.checkPingSpike(snapshot, snapId);
  alerts.checkSustainedLoad(snapshot, snapId);
  alerts.checkMemPressure(snapshot, snapId);
  alerts.checkHealthDecline(score, snapId);
  snapshot._deltaRx = deltaRx; snapshot._deltaTx = deltaTx;
  alerts.checkNightActivity(snapshot, snapId);

  // Monthly bandwidth
  if (deltaRx != null || deltaTx != null) {
    store.addMonthlyTraffic(deltaRx || 0, deltaTx || 0);
    alerts.checkBudget();
  }

  // ── NEW: WiFi clients ──────────────────────────────────────────────────
  if (snapshot.wifi?.clients?.length > 0) {
    try {
      store.insertWifiClients(snapshot.wifi.clients, snapId);
    } catch (e) { console.error('[ingest] wifi insert error:', e.message); }
  }

  // ── NEW: Security events ───────────────────────────────────────────────
  if (snapshot.security) {
    // SSH brute force
    for (const { ip, count } of (snapshot.security.ssh_fails || [])) {
      if (count >= 3) {
        store.insertSecurityEvent('ssh_fail', ip, count, `SSH 认证失败 ${count} 次`);
        if (count >= 10) {
          store.insertEvent('security', 'error', `🚨 SSH 暴力破解检测: ${ip}`, `${count} 次失败尝试`);
          alerts.sendTelegram(`🚨 *SSH 暴力破解告警*\n来源 IP: \`${ip}\`\n失败次数: ${count}\n时间: ${new Date().toLocaleString('zh-CN')}`);
        }
      }
    }
    // High firewall drops
    if (snapshot.security.fw_drop_count > 100) {
      store.insertSecurityEvent('fw_drop', null, snapshot.security.fw_drop_count, `防火墙拦截 ${snapshot.security.fw_drop_count} 个数据包`);
    }
  }

  // ── NEW: Packages ──────────────────────────────────────────────────────
  if (snapshot.packages?.installed?.length > 0) {
    try {
      store.upsertPackages(snapshot.packages.installed, snapshot.packages.upgradeable || []);
      const upgradeCount = (snapshot.packages.upgradeable || []).length;
      if (upgradeCount > 0) {
        store.insertEvent('packages', 'info', `📦 发现 ${upgradeCount} 个可更新软件包`, snapshot.packages.upgradeable.map(u => u.name).join(', ').slice(0, 200));
      }
    } catch (e) { console.error('[ingest] packages error:', e.message); }
  }

  // ── NEW: Auto-remediation ──────────────────────────────────────────────
  try {
    const remediations = await remediate.runRemediation(snapshot);
    if (remediations.length > 0) {
      console.log(`[ingest] Remediation: ${remediations.length} action(s) taken`);
    }
  } catch (e) { console.error('[ingest] remediation error:', e.message); }

  // ── NEW: Storage alerts ────────────────────────────────────────────────
  for (const disk of (snapshot.storage || [])) {
    if (disk.use_pct > 85) {
      store.insertEvent('storage', 'warn', `💾 存储空间不足: ${disk.mount}`, `使用率 ${disk.use_pct}% (${(disk.avail_kb/1024).toFixed(0)} MB 剩余)`);
    }
  }

  console.log(`[ingest] snapshot ${snapshot.date} ${snapshot.collected_at} health=${score} devs=${snapshot.dhcp_leases.length} wifi=${snapshot.wifi?.clients?.length || 0}`);
}

main().catch(err => {
  console.error('[ingest] Error:', err.message);
  process.exit(1);
});
