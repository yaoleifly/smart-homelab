'use strict';
// speedtest.js - Network speed test runner
// Tests download/upload speed from Mac through the router's WAN connection
const https = require('https');
const http  = require('http');
const store = require('./store');

// ── Download speed test ────────────────────────────────────────────────────
// Downloads a large file from a CDN and measures throughput
function testDownload() {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    let bytes = 0;

    // Use Cloudflare's speed test endpoint (100MB test)
    const options = {
      hostname: 'speed.cloudflare.com',
      path: '/__down?bytes=25000000',
      method: 'GET',
      headers: { 'User-Agent': 'smart-homelab-speedtest/1.0' },
      timeout: 30_000,
    };

    const req = https.request(options, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', chunk => { bytes += chunk.length; });
      res.on('end', () => {
        const elapsed = (Date.now() - startMs) / 1000;
        const mbps = elapsed > 0 ? (bytes * 8) / elapsed / 1_000_000 : 0;
        resolve(Math.round(mbps * 10) / 10);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── Upload speed test ──────────────────────────────────────────────────────
function testUpload() {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const uploadBytes = 10_000_000; // 10MB
    let sent = 0;

    const options = {
      hostname: 'speed.cloudflare.com',
      path: '/__up',
      method: 'POST',
      headers: {
        'Content-Type':   'application/octet-stream',
        'Content-Length': uploadBytes,
        'User-Agent':     'smart-homelab-speedtest/1.0',
      },
      timeout: 30_000,
    };

    const req = https.request(options, res => {
      res.resume(); // drain response
      res.on('end', () => {
        const elapsed = (Date.now() - startMs) / 1000;
        const mbps = elapsed > 0 ? (uploadBytes * 8) / elapsed / 1_000_000 : 0;
        resolve(Math.round(mbps * 10) / 10);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Upload timeout')); });
    req.on('error', reject);

    // Send random data in chunks
    const chunk = Buffer.alloc(65536, 0x00);
    function writeChunk() {
      while (sent < uploadBytes) {
        const toSend = Math.min(chunk.length, uploadBytes - sent);
        const ok = req.write(chunk.slice(0, toSend));
        sent += toSend;
        if (!ok) { req.once('drain', writeChunk); return; }
      }
      req.end();
    }
    writeChunk();
  });
}

// ── Latency test ───────────────────────────────────────────────────────────
function testLatency() {
  return new Promise((resolve) => {
    const samples = [];
    let done = 0;
    const n = 5;

    function ping() {
      const t = Date.now();
      const req = https.request({ hostname: 'speed.cloudflare.com', path: '/cdn-cgi/trace', method: 'GET', timeout: 5_000 }, res => {
        res.resume();
        res.on('end', () => {
          samples.push(Date.now() - t);
          done++;
          if (done < n) setTimeout(ping, 200);
          else {
            samples.sort((a, b) => a - b);
            const avg    = samples.reduce((s, v) => s + v, 0) / samples.length;
            const jitter = samples.length > 1
              ? samples.slice(1).reduce((s, v, i) => s + Math.abs(v - samples[i]), 0) / (samples.length - 1)
              : 0;
            resolve({ latency: Math.round(avg), jitter: Math.round(jitter) });
          }
        });
      });
      req.on('error', () => { done++; if (done >= n) resolve({ latency: null, jitter: null }); });
      req.on('timeout', () => { req.destroy(); done++; if (done >= n) resolve({ latency: null, jitter: null }); });
      req.end();
    }
    ping();
  });
}

// ── Full speed test ────────────────────────────────────────────────────────
async function runSpeedtest(source = 'manual') {
  console.log('[speedtest] Starting...');

  const latencyResult = await testLatency().catch(() => ({ latency: null, jitter: null }));
  console.log(`[speedtest] Latency: ${latencyResult.latency}ms, jitter: ${latencyResult.jitter}ms`);

  const download = await testDownload().catch(e => { console.error('[speedtest] Download error:', e.message); return null; });
  console.log(`[speedtest] Download: ${download} Mbps`);

  const upload = await testUpload().catch(e => { console.error('[speedtest] Upload error:', e.message); return null; });
  console.log(`[speedtest] Upload: ${upload} Mbps`);

  const result = {
    download_mbps: download,
    upload_mbps:   upload,
    latency_ms:    latencyResult.latency,
    jitter_ms:     latencyResult.jitter,
    server:        'Cloudflare (speed.cloudflare.com)',
    source,
    tested_at:     new Date().toISOString(),
  };

  store.insertSpeedtest(download, upload, latencyResult.latency, latencyResult.jitter, result.server, source);
  store.insertEvent('speedtest', 'info',
    `⚡ 测速完成: ↓${download ?? '—'} Mbps ↑${upload ?? '—'} Mbps`,
    `延迟: ${latencyResult.latency ?? '—'} ms | 抖动: ${latencyResult.jitter ?? '—'} ms`
  );

  console.log(`[speedtest] Done: ↓${download} ↑${upload} Mbps, latency ${latencyResult.latency}ms`);
  return result;
}

module.exports = { runSpeedtest, testDownload, testUpload, testLatency };
