#!/usr/bin/env node
// parser.js - Parse router SSH raw output into structured JSON
// Usage: echo "$RAW" | node parser.js <date> <timestamp> <data_dir>

const fs   = require('fs');
const path = require('path');
const date = process.argv[2];
const ts   = process.argv[3];
const dir  = process.argv[4];

const raw = fs.readFileSync('/dev/stdin', 'utf8');

// Split by ###SECTION### markers
const sections = {};
let current = null;
for (const line of raw.split('\n')) {
  const m = line.match(/^###([A-Z]+)###$/);
  if (m) { current = m[1]; sections[current] = []; }
  else if (current) sections[current].push(line);
}
const S = k => (sections[k] || []).join('\n');

// --- /proc/uptime ---
const uptimeParts = S('UPTIME').trim().split(' ');
const uptimeSec = parseFloat(uptimeParts[0]) || 0;

// --- /proc/loadavg ---
const loadParts = S('LOADAVG').trim().split(/\s+/);
const load1  = parseFloat(loadParts[0]) || 0;
const load5  = parseFloat(loadParts[1]) || 0;
const load15 = parseFloat(loadParts[2]) || 0;

function fmtUptime(s) {
  s = Math.round(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天 ${h}时 ${m}分`;
  if (h > 0) return `${h}时 ${m}分`;
  return `${m}分`;
}

// --- /proc/meminfo ---
const mem = {};
for (const line of (sections.MEMINFO || [])) {
  const m = line.match(/^(\w+):\s+(\d+)/);
  if (m) mem[m[1]] = parseInt(m[2]);
}

// --- df -k ---
const storage = [];
for (const line of (sections.DISKINFO || []).slice(1)) {
  const p = line.trim().split(/\s+/);
  if (p.length < 6) continue;
  const usePct = parseInt(p[4]);
  storage.push({
    filesystem: p[0],
    mount:      p[5],
    size_kb:    parseInt(p[1]),
    used_kb:    parseInt(p[2]),
    avail_kb:   parseInt(p[3]),
    use_pct:    isNaN(usePct) ? 0 : usePct
  });
}

// --- /proc/net/dev ---
const interfaces = [];
for (const line of (sections.NETDEV || []).slice(2)) {
  const m = line.match(
    /^\s*(\S+):\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/
  );
  if (!m) continue;
  interfaces.push({
    name:       m[1],
    rx_bytes:   parseInt(m[2]),
    rx_packets: parseInt(m[3]),
    rx_errors:  parseInt(m[4]),
    rx_dropped: parseInt(m[5]),
    tx_bytes:   parseInt(m[6]),
    tx_packets: parseInt(m[7]),
    tx_errors:  parseInt(m[8]),
    tx_dropped: parseInt(m[9])
  });
}

// --- WAN (ubus JSON) ---
let wan = {};
try { wan = JSON.parse(S('WAN').trim() || '{}'); } catch { wan = {}; }
const wanIpv4 = (wan['ipv4-address'] || [])[0] || {};
const wanRoute = (wan.route || [])[0] || {};
const wanIpv6  = (wan['ipv6-address'] || [])[0] || {};
const wanOut = {
  up:                  !!(wanIpv4.address),
  ipv4_address:        wanIpv4.address   || null,
  ipv4_prefix_length:  wanIpv4.mask      || null,
  ipv4_gateway:        wanRoute.nexthop  || null,
  ipv6_address:        wanIpv6.address   || null,
  uptime_seconds:      wan.uptime        || 0,
  proto:               wan.proto         || null,
  device:              wan.device        || null
};

// --- /tmp/dhcp.leases ---
const leases = [];
for (const line of (sections.LEASES || [])) {
  const p = line.trim().split(/\s+/);
  if (p.length < 4) continue;
  leases.push({
    expires:   parseInt(p[0]),
    mac:       p[1],
    ip:        p[2],
    hostname:  p[3] === '*' ? null : p[3],
    client_id: p[4] || '*'
  });
}
leases.sort((a, b) => {
  const n = ip => ip.split('.').reduce((acc, v) => acc * 256 + parseInt(v), 0);
  return n(a.ip) - n(b.ip);
});

// --- ping ---
const pingText = S('PING');
const lossM  = pingText.match(/(\d+)% packet loss/);
const rttM   = pingText.match(/min\/avg\/max[^=]+=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
const sentM  = pingText.match(/(\d+) packets? transmitted/);
const recvM  = pingText.match(/(\d+) packets? received|(\d+) received/);
const pingOut = {
  target:             '8.8.8.8',
  packets_sent:       sentM ? parseInt(sentM[1]) : 5,
  packets_received:   recvM ? parseInt(recvM[1] || recvM[2]) : 0,
  packet_loss_pct:    lossM ? parseInt(lossM[1]) : 100,
  rtt_min_ms:         rttM  ? parseFloat(rttM[1])  : null,
  rtt_avg_ms:         rttM  ? parseFloat(rttM[2])  : null,
  rtt_max_ms:         rttM  ? parseFloat(rttM[3])  : null
};

// --- logread errors ---
const errors = [];
for (const line of (sections.ERRORS || [])) {
  if (!line.trim()) continue;
  const m = line.match(/^(\w{3}\s+\w+\s+[\d: ]+\d{4})\s+\S+\s+(\S+):\s+(.+)$/);
  if (m) {
    errors.push({ time: m[1].trim(), daemon: m[2], message: m[3] });
  } else {
    errors.push({ time: '', daemon: 'system', message: line.trim() });
  }
}

// ── NEW: WiFi clients (iw station dump) ───────────────────────────────────
const wifiClients = [];
const wifiText = S('WIFI');
let currentIface = null;
let currentStation = null;

for (const line of wifiText.split('\n')) {
  const ifaceM = line.match(/^=IF=(\S+)/);
  if (ifaceM) { currentIface = ifaceM[1]; currentStation = null; continue; }

  const stationM = line.match(/^Station\s+([0-9a-f:]{17})\s+/i);
  if (stationM) {
    if (currentStation) wifiClients.push(currentStation);
    // Guess band from iface name: wlan0=2.4G, wlan1=5G, wlan2=6G
    let band = 'unknown';
    if (currentIface) {
      const idx = parseInt(currentIface.replace(/[^0-9]/g,'')) || 0;
      band = idx === 0 ? '2.4GHz' : idx === 1 ? '5GHz' : '6GHz';
    }
    currentStation = { mac: stationM[1].toLowerCase(), iface: currentIface, band, signal: null, tx_rate: null, rx_rate: null };
    continue;
  }
  if (!currentStation) continue;

  const sigM   = line.match(/signal:\s+([-\d]+)\s+dBm/);
  const txM    = line.match(/tx bitrate:\s+([\d.]+)\s+MBit/);
  const rxM    = line.match(/rx bitrate:\s+([\d.]+)\s+MBit/);
  if (sigM) currentStation.signal   = parseInt(sigM[1]);
  if (txM)  currentStation.tx_rate  = parseFloat(txM[1]);
  if (rxM)  currentStation.rx_rate  = parseFloat(rxM[1]);
}
if (currentStation) wifiClients.push(currentStation);

// ── Parse hostapd_cli all_sta (more reliable for AP mode) ─────────────────
const hostapdText = S('HOSTAPD');
let haIface = null;
let haStation = null;
const hostapdClients = [];

for (const line of hostapdText.split('\n')) {
  const ifaceM = line.match(/^=IF=(\S+)/);
  if (ifaceM) { haIface = ifaceM[1]; haStation = null; continue; }

  // MAC address line starts a new station block
  const macM = line.match(/^([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})$/i);
  if (macM) {
    if (haStation) hostapdClients.push(haStation);
    let band = 'unknown';
    if (haIface) {
      const idx = parseInt(haIface.replace(/[^0-9]/g,'')) || 0;
      band = idx === 0 ? '2.4GHz' : idx === 1 ? '5GHz' : '6GHz';
    }
    haStation = { mac: macM[1].toLowerCase(), iface: haIface, band, signal: null, tx_rate: null, rx_rate: null };
    continue;
  }
  if (!haStation) continue;
  const sigM  = line.match(/signal=(-\d+)/);
  const txM   = line.match(/tx_rate=(\d+)/);   // kbps
  const rxM   = line.match(/rx_rate=(\d+)/);
  if (sigM) haStation.signal  = parseInt(sigM[1]);
  if (txM)  haStation.tx_rate = Math.round(parseInt(txM[1]) / 1000);
  if (rxM)  haStation.rx_rate = Math.round(parseInt(rxM[1]) / 1000);
}
if (haStation) hostapdClients.push(haStation);

// Merge: hostapd has priority (more reliable), then iw station dump
const macSeen = new Set(wifiClients.map(c => c.mac));
for (const hc of hostapdClients) {
  if (!macSeen.has(hc.mac)) { wifiClients.push(hc); macSeen.add(hc.mac); }
  else {
    // Enrich existing iw entry with hostapd signal if missing
    const existing = wifiClients.find(c => c.mac === hc.mac);
    if (existing && existing.signal == null && hc.signal != null) existing.signal = hc.signal;
  }
}

// Enrich wifi clients with DHCP hostname/IP
for (const wc of wifiClients) {
  const lease = leases.find(l => l.mac.toLowerCase() === wc.mac.toLowerCase());
  if (lease) { wc.ip = lease.ip; wc.hostname = lease.hostname; }
}

// Also parse iwinfo for signal quality (fallback/supplement)
const iwLines = S('IWINFO').split('\n');
let iwIface = null;
const iwInfoMap = {};
for (const line of iwLines) {
  const m = line.match(/^(\w+)\s+ESSID:\s+"(.+)"/);
  if (m) { iwIface = m[1]; iwInfoMap[iwIface] = { ssid: m[2] }; }
  if (iwIface && iwInfoMap[iwIface]) {
    const bitM = line.match(/Bit Rate:\s+([\d.]+)\s+MBit\/s/);
    if (bitM) iwInfoMap[iwIface].bitrate = parseFloat(bitM[1]);
  }
}
// Attach SSID from iwinfo to clients by iface
for (const wc of wifiClients) {
  if (wc.iface && iwInfoMap[wc.iface]) wc.ssid = iwInfoMap[wc.iface].ssid;
}

// ── NEW: SSH failed logins ─────────────────────────────────────────────────
const sshFails = [];
const sshFailMap = {};
for (const line of (sections.SSHLOG || [])) {
  if (!line.trim()) continue;
  const ipM = line.match(/from\s+(\d+\.\d+\.\d+\.\d+)/i);
  const ip = ipM ? ipM[1] : 'unknown';
  if (!sshFailMap[ip]) sshFailMap[ip] = 0;
  sshFailMap[ip]++;
}
for (const [ip, count] of Object.entries(sshFailMap)) {
  if (count > 0) sshFails.push({ ip, count });
}
sshFails.sort((a, b) => b.count - a.count);

// ── NEW: Firewall DROP counter ─────────────────────────────────────────────
let fwDropCount = 0;
for (const line of (sections.IPTABLES || [])) {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+DROP/i);
  if (m) fwDropCount += parseInt(m[1]);
}

// ── NEW: Conntrack count ───────────────────────────────────────────────────
const conntrackCount = parseInt(S('CONNTRACK').trim()) || 0;

// ── NEW: Package list ──────────────────────────────────────────────────────
const packages = [];
for (const line of (sections.PKGLIST || [])) {
  const m = line.match(/^(.+?)\s+-\s+(.+?)(?:\s+-\s+(.+))?$/);
  if (m) packages.push({ name: m[1].trim(), version: m[2].trim(), description: m[3]?.trim() || null });
}

const upgradeable = [];
for (const line of (sections.PKGUPGRADE || [])) {
  const m = line.match(/^(.+?)\s+-\s+(.+?)(?:\s+-\s+.+)?$/);
  if (m) upgradeable.push({ name: m[1].trim(), new_version: m[2].trim() });
}

// ── NEW: WireGuard status ──────────────────────────────────────────────────
const wgText = S('WIREGUARD').trim();
const wireguard = {
  enabled: wgText.length > 10,
  peers: (wgText.match(/^peer:/gm) || []).length,
  raw: wgText.slice(0, 500)
};

// ── Assemble ───────────────────────────────────────────────────────────────
const output = {
  collected_at: ts,
  date,
  system: {
    uptime_raw:     fmtUptime(uptimeSec),
    uptime_seconds: Math.round(uptimeSec),
    load_1:         load1,
    load_5:         load5,
    load_15:        load15,
    conntrack:      conntrackCount
  },
  memory: {
    total_kb:     mem.MemTotal     || 0,
    free_kb:      mem.MemFree      || 0,
    available_kb: mem.MemAvailable || mem.MemFree || 0,
    buffers_kb:   mem.Buffers      || 0,
    cached_kb:    (mem.Cached || 0) + (mem.SReclaimable || 0),
    used_kb:      (mem.MemTotal || 0) - (mem.MemAvailable || mem.MemFree || 0)
  },
  storage,
  interfaces,
  wan: wanOut,
  dhcp_leases: leases,
  ping: pingOut,
  errors,
  wifi: {
    clients: wifiClients,
    client_count: wifiClients.length,
    by_band: {
      '2.4GHz': wifiClients.filter(c => c.band === '2.4GHz').length,
      '5GHz':   wifiClients.filter(c => c.band === '5GHz').length,
      '6GHz':   wifiClients.filter(c => c.band === '6GHz').length,
    }
  },
  security: {
    ssh_fails: sshFails,
    fw_drop_count: fwDropCount
  },
  packages: {
    installed: packages,
    upgradeable
  },
  wireguard
};

const outPath = path.join(dir, `${date}.json`);
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`[parser] Wrote ${outPath} (${leases.length} devices, ${wifiClients.length} wifi, ping ${pingOut.rtt_avg_ms}ms)`);

// Prune files older than 30 days
const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
for (const f of fs.readdirSync(dir)) {
  if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
  const fp = path.join(dir, f);
  if (fs.statSync(fp).mtimeMs < cutoff) {
    fs.unlinkSync(fp);
    console.log(`[parser] Pruned ${f}`);
  }
}

// Trigger async SQLite ingestion (non-blocking)
try {
  const { spawn } = require('child_process');
  const ingestProc = spawn(process.execPath, [
    require('path').join(__dirname, 'ingest.js'), outPath
  ], { detached: true, stdio: 'inherit', cwd: __dirname });
  ingestProc.unref();
} catch { /* ingest unavailable */ }
