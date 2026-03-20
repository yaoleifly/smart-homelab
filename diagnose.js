'use strict';
const { execSync } = require('child_process');
const cfg   = require('./config');
const store = require('./store');

async function runDiagnosis() {
  const last = store.getLastSnapshot();
  if (!last) return null;
  const s = JSON.parse(last.raw);
  const steps = [];
  const ts    = new Date().toISOString();

  function step(test, passed, result) {
    steps.push({ test, passed, result });
    return passed;
  }

  // Step 1: WAN interface
  const wanUp = s.wan.up;
  step('WAN 接口状态', wanUp, wanUp ? `已连接，外网 IP: ${s.wan.ipv4_address}` : 'WAN 未连接，接口为 down 状态');

  // Step 2: Ping latency
  const loss = s.ping.packet_loss_pct;
  const rtt  = s.ping.rtt_avg_ms;
  const pingOk = loss === 0 && rtt != null && rtt < 500;
  step('互联网连通性 (ping 8.8.8.8)', pingOk,
    pingOk ? `延迟 ${rtt?.toFixed(0)} ms，无丢包`
           : loss > 0 ? `丢包 ${loss}%，网络不稳定` : 'ping 超时，无法到达互联网');

  // Step 3: Memory pressure
  const memPct = last.mem_pct;
  const memOk  = memPct == null || memPct < 90;
  step('内存状态', memOk, memOk ? `内存使用 ${memPct}%，正常` : `内存使用 ${memPct}%，过高，可能影响性能`);

  // Step 4: Recent error logs
  const errCount = (s.errors || []).filter(e => /error|fail|crit/i.test((e.message||'') + (e.daemon||''))).length;
  const logsOk   = errCount === 0;
  step('系统错误日志', logsOk, logsOk ? '无严重错误日志' : `发现 ${errCount} 条错误日志`);

  // Step 5: Recommendations
  const recs = [];
  if (!wanUp && s.wan.proto === 'pppoe') recs.push('WAN PPPoE 断线，建议尝试在路由器后台重拨或重启 WAN 接口');
  if (memPct > 85) recs.push('内存压力较大，建议重启路由器释放内存');
  if (rtt > 150) recs.push('延迟偏高，可能与运营商质量有关，建议关注是否规律性出现');
  if (!errCount && wanUp && pingOk) recs.push('网络整体运行正常，无需干预');

  const failedCount = steps.filter(st => !st.passed).length;
  const severity    = failedCount === 0 ? 'info' : failedCount <= 1 ? 'warn' : 'error';
  const conclusion  = failedCount === 0
    ? '✅ 诊断通过，网络运行正常'
    : `⚠️ 发现 ${failedCount} 个问题，请参考建议处理`;

  const detail = steps.map(st => `${st.passed ? '✓' : '✗'} ${st.test}: ${st.result}`).join('\n')
    + (recs.length ? '\n\n建议:\n' + recs.map(r => '• ' + r).join('\n') : '');

  store.insertEvent('diagnosis', severity, conclusion, detail);

  return { steps, conclusion, recommendations: recs, severity };
}

module.exports = { runDiagnosis };
