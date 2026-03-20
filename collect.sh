#!/usr/bin/env bash
# collect.sh - SSH into OpenWrt router and save structured JSON snapshot
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$DIR/data"
LOG_DIR="$DIR/logs"

ROUTER_HOST="${ROUTER_HOST:-}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_PASS="${ROUTER_PASS:-}"
ROUTER_PORT="${ROUTER_PORT:-22}"

if [ -z "$ROUTER_HOST" ] || [ -z "$ROUTER_PASS" ]; then
  mkdir -p "$LOG_DIR"
  echo "[$(date)] ERROR: ROUTER_HOST or ROUTER_PASS not set" >> "$LOG_DIR/collect.log"
  exit 1
fi

ROUTER="${ROUTER_USER}@${ROUTER_HOST}"
DATE=$(date '+%Y-%m-%d')
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

mkdir -p "$DATA_DIR" "$LOG_DIR"

echo "[$(date)] Starting collection..." >> "$LOG_DIR/collect.log"

# Collect raw data in one SSH session
RAW=$(sshpass -p "$ROUTER_PASS" ssh \
  -o StrictHostKeyChecking=no \
  -o ConnectTimeout=15 \
  -o BatchMode=no \
  -p "$ROUTER_PORT" \
  "$ROUTER" \
  'printf "###UPTIME###\n"; cat /proc/uptime; \
   printf "###LOADAVG###\n"; cat /proc/loadavg; \
   printf "###MEMINFO###\n"; cat /proc/meminfo; \
   printf "###DISKINFO###\n"; df -k; \
   printf "###NETDEV###\n"; cat /proc/net/dev; \
   printf "###WAN###\n"; ubus call network.interface.wan status 2>/dev/null || echo "{}"; \
   printf "###LEASES###\n"; cat /tmp/dhcp.leases 2>/dev/null || true; \
   printf "###PING###\n"; ping -c 5 -W 2 8.8.8.8 2>&1 || true; \
   printf "###ERRORS###\n"; logread 2>/dev/null | grep -iE "err|warn|fail|crit|attack|drop" | tail -30 || true; \
   printf "###WIFI###\n"; for iface in $(iw dev 2>/dev/null | grep Interface | awk "{print \$2}"); do echo "=IF=$iface"; iw dev $iface station dump 2>/dev/null || true; done; \
   printf "###HOSTAPD###\n"; for sock in $(ls /var/run/hostapd* 2>/dev/null); do iface=$(basename $sock); echo "=IF=$iface"; hostapd_cli -i $iface all_sta 2>/dev/null || true; done; \
   printf "###IWINFO###\n"; iwinfo 2>/dev/null || true; \
   printf "###IPTABLES###\n"; iptables -nvL INPUT 2>/dev/null | head -30 || true; \
   printf "###SSHLOG###\n"; logread 2>/dev/null | grep -iE "authentication failure|Failed password|Invalid user|sshd" | tail -30 || true; \
   printf "###DNSSTAT###\n"; cat /var/log/dnsmasq.log 2>/dev/null | tail -20 || logread 2>/dev/null | grep dnsmasq | tail -20 || true; \
   printf "###PKGLIST###\n"; opkg list-installed 2>/dev/null | head -100 || true; \
   printf "###PKGUPGRADE###\n"; opkg list-upgradeable 2>/dev/null || true; \
   printf "###FWDROP###\n"; iptables -nvL FORWARD 2>/dev/null | grep -i drop | head -10 || true; \
   printf "###CONNTRACK###\n"; cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo "0"; \
   printf "###WIREGUARD###\n"; wg show 2>/dev/null || true') \
  2>>"$LOG_DIR/collect.log"

# Parse with Node.js
echo "$RAW" | /opt/homebrew/opt/node/bin/node "$DIR/parser.js" "$DATE" "$TIMESTAMP" "$DATA_DIR" \
  >> "$LOG_DIR/collect.log" 2>&1

echo "[$(date)] Done." >> "$LOG_DIR/collect.log"
