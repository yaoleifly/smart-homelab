'use strict';
// remediate.js - Auto-remediation engine for OpenWrt router issues
const { exec } = require('child_process');
const cfg   = require('./config');
const store = require('./store');

const SSH_BASE = `sshpass -p '${cfg.ROUTER_PASS}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=no ${cfg.ROUTER_USER}@${cfg.ROUTER_HOST}`;

function remoteExec(cmd) {
  return new Promise((resolve, reject) => {
    exec(`${SSH_BASE} '${cmd.replace(/'/g, "'\\''")}'`, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// Cooldown: don't repeat same fix within N minutes
function recentlyAttempted(issue, minutes = 10) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const row = store.db().prepare(
    "SELECT id FROM remediation_log WHERE issue=? AND triggered_at > ? LIMIT 1"
  ).get(issue, since);
  return !!row;
}

async function tryFix(issue, action, cmd) {
  const auto = cfg.REMEDIATION_MODE === 'auto';

  store.insertEvent('remediation', 'info',
    `🔧 检测到问题: ${issue}`,
    `建议动作: ${action} | 模式: ${auto ? '自动执行' : '仅建议'}`
  );

  if (!auto) {
    store.insertRemediationLog(issue, action, '观察模式，未执行', false, false);
    return { issue, action, auto: false, executed: false };
  }

  try {
    const result = await remoteExec(cmd);
    store.insertRemediationLog(issue, action, result.slice(0, 500) || '执行完成', true, true);
    store.insertEvent('remediation', 'info', `✅ 自动修复成功: ${issue}`, action);
    return { issue, action, executed: true, success: true, result };
  } catch (e) {
    store.insertRemediationLog(issue, action, e.message, true, false);
    store.insertEvent('remediation', 'error', `❌ 自动修复失败: ${issue}`, e.message);
    return { issue, action, executed: true, success: false, error: e.message };
  }
}

// ── Main remediation check ─────────────────────────────────────────────────
async function runRemediation(snapshot) {
  const results = [];
  if (!snapshot) return results;

  // 1. WAN 断线 → 重启 WAN 接口
  if (!snapshot.wan.up && !recentlyAttempted('WAN接口断线', 5)) {
    results.push(await tryFix(
      'WAN接口断线',
      '重启 WAN 接口 (ifdown wan && ifup wan)',
      'ifdown wan && sleep 3 && ifup wan'
    ));
  }

  // 2. 内存超过 90% → 清理缓存
  const memPct = snapshot.memory.total_kb > 0
    ? snapshot.memory.used_kb / snapshot.memory.total_kb * 100
    : 0;
  if (memPct > 90 && !recentlyAttempted('内存压力过高', 15)) {
    results.push(await tryFix(
      '内存压力过高',
      '清理系统缓存 (drop_caches)',
      'sync && echo 3 > /proc/sys/vm/drop_caches'
    ));
  }

  // 3. CPU 负载 > 4 持续高压 → 列出并尝试重启异常服务
  if (snapshot.system.load_1 > 4 && !recentlyAttempted('CPU负载异常', 15)) {
    results.push(await tryFix(
      'CPU负载异常',
      '查看高负载进程 (top -b -n1)',
      'top -b -n1 | head -20'
    ));
  }

  // 4. DNS 故障检测：WAN up 但 DNS 不通 → 重启 dnsmasq
  if (snapshot.wan.up && snapshot.ping.packet_loss_pct === 100 && !recentlyAttempted('DNS故障', 10)) {
    // Ping by IP succeeded before, DNS likely broken
    results.push(await tryFix(
      'DNS故障',
      '重启 dnsmasq 服务',
      '/etc/init.d/dnsmasq restart'
    ));
  }

  // 5. SSH 暴力破解 → 封锁攻击 IP
  if (snapshot.security?.ssh_fails?.length > 0) {
    for (const { ip, count } of snapshot.security.ssh_fails) {
      if (count >= 5 && ip !== 'unknown') {
        const alreadyBlocked = store.getBlockedIps().find(b => b.ip === ip);
        if (!alreadyBlocked) {
          store.blockIp(ip, `SSH暴力破解 (${count}次失败)`, true);
          store.insertSecurityEvent('ssh_fail', ip, count, `检测到 ${count} 次 SSH 失败尝试`);
          if (!recentlyAttempted(`封锁IP_${ip}`, 60)) {
            results.push(await tryFix(
              `SSH暴力破解 (${ip})`,
              `封锁 IP: iptables DROP from ${ip}`,
              `iptables -I INPUT -s ${ip} -j DROP`
            ));
          }
        }
      }
    }
  }

  // 6. 存储满 > 90% → 清理临时文件
  for (const disk of (snapshot.storage || [])) {
    if (disk.use_pct > 90 && disk.mount === '/overlay' && !recentlyAttempted(`存储满_${disk.mount}`, 30)) {
      results.push(await tryFix(
        `存储满 ${disk.mount} (${disk.use_pct}%)`,
        '清理 opkg 缓存和临时文件',
        'rm -rf /tmp/opkg-lists/* /var/cache/opkg/* 2>/dev/null; true'
      ));
    }
  }

  return results;
}

// ── Manual trigger API ─────────────────────────────────────────────────────
async function manualFix(action) {
  const actions = {
    restart_wan:      { issue: '手动-WAN重启',    cmd: 'ifdown wan && sleep 3 && ifup wan' },
    restart_dnsmasq:  { issue: '手动-DNS重启',    cmd: '/etc/init.d/dnsmasq restart' },
    restart_wifi:     { issue: '手动-WiFi重启',   cmd: 'wifi reload' },
    drop_caches:      { issue: '手动-清理缓存',   cmd: 'sync && echo 3 > /proc/sys/vm/drop_caches' },
    restart_firewall: { issue: '手动-防火墙重启', cmd: '/etc/init.d/firewall restart' },
    reboot:           { issue: '手动-路由器重启', cmd: 'sleep 2 && reboot &' },
  };

  const a = actions[action];
  if (!a) throw new Error(`Unknown action: ${action}`);
  return tryFix(a.issue, action, a.cmd);
}

module.exports = { runRemediation, manualFix, remoteExec };
