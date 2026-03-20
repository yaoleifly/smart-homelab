'use strict';
const https = require('https');
const cfg   = require('./config');
const store = require('./store');

// ── Telegram ───────────────────────────────────────────────────────────────
const _queue = [];
let _sending = false;

function sendTelegram(text) {
  if (!cfg.TELEGRAM_TOKEN) return;
  _queue.push(text);
  if (!_sending) drainQueue();
}

function drainQueue() {
  if (!_queue.length) { _sending = false; return; }
  _sending = true;
  const text = _queue.shift().slice(0, 4000);
  const body = JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${cfg.TELEGRAM_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    res.resume();
    setTimeout(drainQueue, 1000);
  });
  req.on('error', err => { console.warn('[alerts] Telegram error:', err.message); setTimeout(drainQueue, 3000); });
  req.end(body);
}

// ── Cooldown helper (avoid repeat alerts) ─────────────────────────────────
function recentlyAlerter(key, minutes = 30) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  return !!store.db().prepare(
    "SELECT id FROM events WHERE title LIKE ? AND occurred_at > ? LIMIT 1"
  ).get('%' + key + '%', since);
}

// ── New Device Detection ───────────────────────────────────────────────────
function checkNewDevices() {
  const newDevs = store.getNewUnalertedDevices();
  for (const dev of newDevs) {
    const hostname = dev.hostname || '未知设备';
    const vendor   = dev.vendor   || '';
    const msg = `🔔 *新设备接入家庭网络*\n\n` +
      `主机名: \`${hostname}\`\n` +
      `IP 地址: \`${dev.ip}\`\n` +
      `MAC: \`${dev.mac}\`\n` +
      (vendor ? `厂商: ${vendor}\n` : '') +
      `首次发现: ${dev.first_seen.slice(0, 19).replace('T', ' ')} UTC\n\n` +
      `如果不认识此设备，请检查路由器安全设置。`;
    sendTelegram(msg);
    store.markDeviceAlerted(dev.mac);
    store.insertEvent('new_device', 'warn', `新设备: ${hostname} (${dev.ip})`, `MAC: ${dev.mac}${vendor ? ' · ' + vendor : ''}`, dev.mac);
    console.log(`[alerts] New device: ${dev.mac} ${hostname} ${dev.ip}`);
  }
}

// ── Bandwidth Budget ───────────────────────────────────────────────────────
function checkBudget() {
  const month = store.getMonth();
  const b = store.getBudget(month);
  if (!b || b.budget_gb <= 0) return;
  const totalGB  = (b.rx_bytes + b.tx_bytes) / 1e9;
  const budgetGB = b.budget_gb;
  const pct      = totalGB / budgetGB * 100;

  if (pct >= 100 && !b.warn_100) {
    sendTelegram(`⚠️ *月度流量已耗尽*\n已用 ${totalGB.toFixed(1)} GB / ${budgetGB} GB (${pct.toFixed(0)}%)`);
    store.insertEvent('budget_warn', 'error', `月度流量已耗尽 (${pct.toFixed(0)}%)`, `已用 ${totalGB.toFixed(1)} GB`);
    store.setBudgetWarn(month, 'warn_100');
  } else if (pct >= 80 && !b.warn_80) {
    sendTelegram(`⚠️ *月度流量已用 80%*\n已用 ${totalGB.toFixed(1)} GB / ${budgetGB} GB`);
    store.insertEvent('budget_warn', 'warn', `月度流量已用 80%`, `已用 ${totalGB.toFixed(1)} GB`);
    store.setBudgetWarn(month, 'warn_80');
  } else if (pct >= 50 && !b.warn_50) {
    sendTelegram(`ℹ️ *月度流量已用 50%*\n已用 ${totalGB.toFixed(1)} GB / ${budgetGB} GB`);
    store.insertEvent('budget_warn', 'info', `月度流量已用 50%`, `已用 ${totalGB.toFixed(1)} GB`);
    store.setBudgetWarn(month, 'warn_50');
  }
}

// ── Ping Spike Detection ───────────────────────────────────────────────────
// Fires if current RTT is > 3× the recent average (last 5 snapshots)
function checkPingSpike(snapshot, snapId) {
  const rtt = snapshot.ping?.rtt_avg_ms;
  if (rtt == null || rtt <= 0 || snapshot.ping?.packet_loss_pct > 0) return;

  const recent = store.getSnapshots(1).slice(0, 5);
  if (recent.length < 3) return;
  const avgRtt = recent.reduce((s, r) => s + (r.ping_rtt || 0), 0) / recent.length;
  if (avgRtt < 10) return; // not enough baseline yet

  if (rtt > avgRtt * 3 && rtt > 150) {
    const key = 'Ping 突升';
    if (!recentlyAlerter(key, 20)) {
      store.insertEvent('anomaly', 'warn',
        `⚡ ${key}: ${rtt.toFixed(0)} ms (均值 ${avgRtt.toFixed(0)} ms)`,
        `当前延迟是近期均值的 ${(rtt / avgRtt).toFixed(1)} 倍`, null, snapId
      );
      sendTelegram(`⚡ *Ping 突升告警*\n当前: ${rtt.toFixed(0)} ms\n近期均值: ${avgRtt.toFixed(0)} ms\n时间: ${new Date().toLocaleString('zh-CN')}`);
    }
  }
}

// ── Sustained High Load ────────────────────────────────────────────────────
// Fires if load_1 > threshold for 3 consecutive snapshots
function checkSustainedLoad(snapshot, snapId) {
  const THRESHOLD = 2.0;
  const l1 = snapshot.system?.load_1;
  if (l1 == null || l1 < THRESHOLD) return;

  const recent = store.getSnapshots(1).slice(0, 3);
  if (recent.length < 3) return;
  const allHigh = recent.every(r => (r.load_1 || 0) >= THRESHOLD);
  if (!allHigh) return;

  const key = 'CPU持续高负载';
  if (!recentlyAlerter(key, 30)) {
    store.insertEvent('anomaly', 'warn',
      `🔥 ${key}: load_1=${l1.toFixed(2)}`,
      `CPU 负载 ≥ ${THRESHOLD} 已持续 3 个采样周期 (${recent.length * 5} 分钟)`, null, snapId
    );
    sendTelegram(`🔥 *CPU 持续高负载告警*\nload_1 = ${l1.toFixed(2)}\n持续时间: ≥15 分钟\n时间: ${new Date().toLocaleString('zh-CN')}`);
  }
}

// ── Memory Pressure ────────────────────────────────────────────────────────
function checkMemPressure(snapshot, snapId) {
  const memP = snapshot.memory?.total_kb > 0
    ? snapshot.memory.used_kb / snapshot.memory.total_kb * 100 : 0;
  if (memP < 88) return;
  const key = '内存压力过高';
  if (!recentlyAlerter(key, 30)) {
    store.insertEvent('anomaly', 'warn',
      `💾 ${key}: ${memP.toFixed(0)}%`,
      `内存使用率 ${memP.toFixed(1)}%，可能影响路由性能`, null, snapId
    );
    sendTelegram(`💾 *内存压力告警*\n使用率: ${memP.toFixed(0)}%\n时间: ${new Date().toLocaleString('zh-CN')}`);
  }
}

// ── Health Score Decline ───────────────────────────────────────────────────
// Fires if health score drops ≥15 points compared to average of last 5 readings
function checkHealthDecline(currentScore, snapId) {
  if (currentScore == null) return;
  const recent = store.getSnapshots(1).slice(0, 5);
  if (recent.length < 3) return;
  const avg = recent.reduce((s, r) => s + (r.health || 0), 0) / recent.length;
  const drop = avg - currentScore;
  if (drop >= 15) {
    const key = '健康评分急跌';
    if (!recentlyAlerter(key, 20)) {
      store.insertEvent('anomaly', 'warn',
        `📉 ${key}: ${currentScore} (均值 ${avg.toFixed(0)})`,
        `健康评分较近期均值下降 ${drop.toFixed(0)} 分`, null, snapId
      );
      sendTelegram(`📉 *健康评分急跌*\n当前: ${currentScore}\n近期均值: ${avg.toFixed(0)}\n下降: ${drop.toFixed(0)} 分\n时间: ${new Date().toLocaleString('zh-CN')}`);
    }
  }
}

// ── Night-time Anomalous Activity ──────────────────────────────────────────
// Fires if a non-phone/computer device generates unusual traffic between 0-6 AM
function checkNightActivity(snapshot, snapId) {
  const hour = new Date().getHours();
  if (hour < 0 || hour > 5) return; // only 00:00–05:59

  const deltaRx = snapshot._deltaRx || 0;
  const deltaTx = snapshot._deltaTx || 0;
  const totalMB = (deltaRx + deltaTx) / 1e6;

  if (totalMB > 50) { // >50MB in a 5-min window at night
    const key = '深夜异常流量';
    if (!recentlyAlerter(key, 60)) {
      store.insertEvent('anomaly', 'warn',
        `🌙 ${key}: ${totalMB.toFixed(0)} MB (${hour}:xx)`,
        `深夜时段检测到 ${totalMB.toFixed(0)} MB 异常流量`, null, snapId
      );
      sendTelegram(`🌙 *深夜异常流量告警*\n流量: ${totalMB.toFixed(0)} MB\n时段: 0${hour}:00\n时间: ${new Date().toLocaleString('zh-CN')}`);
    }
  }
}

module.exports = {
  sendTelegram,
  checkNewDevices,
  checkBudget,
  checkPingSpike,
  checkSustainedLoad,
  checkMemPressure,
  checkHealthDecline,
  checkNightActivity,
};
