'use strict';
const https = require('https');
const cfg   = require('./config');
const store = require('./store');

// ── Health Score ───────────────────────────────────────────────────────────
function scoreSnapshot(s) {
  const w = cfg.HEALTH_WEIGHTS;

  // WAN: 100 if up, 0 if down. Bonus up to +5 for long uptime (>1h = stable)
  const wanBase  = s.wan.up ? 100 : 0;
  const uptimeH  = (s.wan.uptime_seconds || 0) / 3600;
  const wan      = s.wan.up ? Math.min(100, wanBase + (uptimeH > 1 ? 5 : 0)) : 0;

  // Ping: smooth curve. loss=0 + rtt<50=100, rtt 50-200 linear decay, >200=20. Any loss = severe penalty
  const loss   = s.ping.packet_loss_pct || 0;
  const rtt    = s.ping.rtt_avg_ms || 0;
  let ping;
  if (!s.wan.up)       ping = 0;
  else if (loss >= 20) ping = 0;
  else if (loss > 0)   ping = Math.max(0, 40 - loss * 2);
  else if (rtt <= 50)  ping = 100;
  else if (rtt <= 200) ping = Math.max(20, 100 - (rtt - 50) * 0.53);
  else                 ping = Math.max(0, 20 - (rtt - 200) * 0.1);

  // Memory: penalty only above 75% — router normally runs 60-70% which is fine
  const memP = s.memory.total_kb > 0 ? s.memory.used_kb / s.memory.total_kb * 100 : 0;
  const mem  = memP <= 75 ? 100 : Math.max(0, 100 - (memP - 75) * 4);

  // Load: OpenWrt routers rarely exceed 1.0. Scale: 0=100, 1.0=80, 2.0=50, 4+=0
  const l1   = s.system.load_1 || 0;
  const load = l1 <= 0.5 ? 100 : l1 <= 1.0 ? 100 - (l1 - 0.5) * 40 : l1 <= 2.0 ? 80 - (l1 - 1) * 30 : Math.max(0, 50 - (l1 - 2) * 25);

  // Errors: deduplicate by message prefix, ignore common noise
  const NOISE = /nf_conntrack|br-lan|option\s+deprecated|clock/i;
  const errMsgs = (s.errors || []).map(e => e.message || '').filter(m => m && !NOISE.test(m));
  const deduped = new Set(errMsgs.map(m => m.slice(0, 40)));
  const errors  = Math.max(0, 100 - deduped.size * 8);

  const score = Math.round(
    wan * w.wan + ping * w.ping + mem * w.mem + load * w.load + errors * w.errors
  );
  return { score, components: { wan, ping, mem, load, errors } };
}

// ── Anomaly Detection ──────────────────────────────────────────────────────
function checkAnomalies(s, snapshotId) {
  const baselines = store.getBaselines();
  const metrics = {
    ping_rtt:  s.ping.rtt_avg_ms,
    ping_loss: s.ping.packet_loss_pct,
    mem_pct:   s.memory.total_kb > 0 ? s.memory.used_kb / s.memory.total_kb * 100 : null,
    load_1:    s.system.load_1,
  };
  const anomalies = [];
  for (const [metric, value] of Object.entries(metrics)) {
    if (value == null) continue;
    const b = baselines[metric];
    if (!b || b.n < 10) continue; // need enough data
    const sigma = b.stddev > 0 ? Math.abs(value - b.mean) / b.stddev : 0;
    if (sigma >= cfg.ANOMALY_SIGMA) {
      const dir = value > b.mean ? '偏高' : '偏低';
      const label = { ping_rtt:'延迟', ping_loss:'丢包率', mem_pct:'内存使用率', load_1:'CPU负载' }[metric];
      const title = `${label} ${dir} (${sigma.toFixed(1)}σ)`;
      const detail = `当前: ${value.toFixed(1)}, 基线均值: ${b.mean.toFixed(1)}, 标准差: ${b.stddev.toFixed(1)}`;
      store.insertEvent('anomaly', sigma >= 3 ? 'error' : 'warn', title, detail, null, snapshotId);
      anomalies.push({ metric, value, mean: b.mean, stddev: b.stddev, sigma });
    }
  }
  return anomalies;
}

// ── Baseline Computation ───────────────────────────────────────────────────
function updateBaselines() {
  const rows = store.getSnapshotsForBaseline(cfg.BASELINE_DAYS);
  if (rows.length < 5) return;
  const metrics = ['ping_rtt', 'ping_loss', 'mem_pct', 'load_1', 'delta_rx', 'delta_tx'];
  for (const metric of metrics) {
    const vals = rows.map(r => r[metric]).filter(v => v != null && v >= 0);
    if (vals.length < 5) continue;
    const n    = vals.length;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    store.upsertBaseline(metric, mean, Math.sqrt(variance), n);
  }
  console.log(`[ai] Updated baselines from ${rows.length} snapshots`);
}

// ── Claude API ─────────────────────────────────────────────────────────────
function callClaude(systemPrompt, userContent, maxTokens = 600) {
  return new Promise((resolve, reject) => {
    if (!cfg.ANTHROPIC_KEY) { reject(new Error('No ANTHROPIC_API_KEY')); return; }
    const body = JSON.stringify({
      model: cfg.ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    const req = https.request({
      hostname: cfg.ANTHROPIC_HOST,
      path:     cfg.ANTHROPIC_PATH,
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         cfg.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) { reject(new Error(r.error.message)); return; }
          // MiniMax may return thinking blocks before text; find the text block
          const textBlock = (r.content || []).find(b => b.type === 'text');
          if (textBlock) { resolve(textBlock.text); return; }
          // Fallback: first block with text field
          const anyText = (r.content || []).find(b => b.text);
          if (anyText) { resolve(anyText.text); return; }
          reject(new Error('No text in response: ' + JSON.stringify(r.content)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ── Daily Summary ──────────────────────────────────────────────────────────
async function generateDailySummary(date) {
  const scoreHistory = store.getScoreHistory(1).find(r => r.date === date);
  const events       = store.getEvents(20, null, null, 0).filter(e => e.occurred_at.startsWith(date));
  const budget       = store.getBudget(date.slice(0, 7));
  const newDevices   = events.filter(e => e.kind === 'new_device');
  const anomalies    = events.filter(e => e.kind === 'anomaly');

  const context = `
日期: ${date}
健康评分: 均值 ${scoreHistory?.avg ?? '—'}, 最低 ${scoreHistory?.min ?? '—'}, 最高 ${scoreHistory?.max ?? '—'}
异常事件: ${anomalies.length} 条
新设备: ${newDevices.length} 台
月度流量: 下行 ${budget ? (budget.rx_bytes/1e9).toFixed(2) : '—'} GB, 上行 ${budget ? (budget.tx_bytes/1e9).toFixed(2) : '—'} GB
近期告警:\n${events.slice(0, 8).map(e => `  [${e.severity}] ${e.title}`).join('\n') || '  无'}
  `.trim();

  const md = await callClaude(
    '你是一个家庭网络运维助手。请用中文生成一份简洁的每日网络健康日报，包括：总体状况、主要异常（如有）、新设备（如有）、流量使用情况、运维建议（1-2条）。语气专业简洁，总字数控制在200字以内。',
    context, 500
  );

  if (scoreHistory) {
    store.saveSummary(date, cfg.ANTHROPIC_MODEL, scoreHistory.avg, scoreHistory.min, scoreHistory.max, md);
  } else {
    store.saveSummary(date, cfg.ANTHROPIC_MODEL, null, null, null, md);
  }
  store.insertEvent('ai_summary', 'info', `AI 日报已生成 (${date})`, md.slice(0, 200));
  return md;
}

// ── Log Analysis ───────────────────────────────────────────────────────────
async function analyzeLogs(logLines) {
  const deduped = [...new Set(logLines.filter(Boolean))].slice(0, 30);
  if (!deduped.length) return '无日志可分析。';
  return callClaude(
    '你是一个 OpenWrt 网络设备日志分析专家。请用中文分析以下日志，指出：1.最重要的3个问题模式；2.可能的根本原因；3.建议的处理措施。保持简洁。',
    deduped.join('\n'), 600
  );
}

module.exports = { scoreSnapshot, checkAnomalies, updateBaselines, generateDailySummary, analyzeLogs, callClaude };
