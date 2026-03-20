<div align="center">

# 🏠 Smart Homelab

**An AI-powered router monitoring dashboard for OpenWrt**

Self-hosted · Zero cloud dependency · One command to run

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![CI](https://github.com/yaoleifly/smart-homelab/actions/workflows/ci.yml/badge.svg)](https://github.com/yaoleifly/smart-homelab/actions)
[![Version](https://img.shields.io/badge/version-1.1.0-orange.svg)](CHANGELOG.md)

**English** | [中文](#-中文说明)

</div>

---

## What is Smart Homelab?

Smart Homelab turns your OpenWrt router into a fully observable, AI-assisted network operations center — running entirely on your own hardware with no cloud accounts, no subscriptions, and no data leaving your home.

It connects to your router over SSH every 5 minutes, collects dozens of health metrics, stores them in a local SQLite database, and presents everything in a polished single-page dashboard. When something goes wrong — a WAN outage, a ping spike, an SSH brute-force attempt — it can alert you via Telegram and even fix the problem automatically.

The optional Claude AI integration lets you ask plain-language questions like *"Why is my network slow tonight?"* and get a grounded answer based on real data from your router.

---

## ✨ Features

### 📊 Real-time Monitoring
Every metric that matters — WAN up/down, external IP, ping round-trip time, packet loss, memory usage, CPU load average, storage, and the count of connected devices — is collected, stored, and charted. A composite **health score (0–100)** summarises the router's overall condition using a weighted algorithm with smooth decay curves and noise filtering, so you see trends rather than jitter.

### 📈 Traffic Analysis
Per-collection Rx/Tx deltas are stored and visualised as time-series charts and a **7×24 heatmap** that shows which hours of which days have the heaviest traffic at a glance. Monthly totals are tracked against a configurable budget, and an alert fires if you approach the limit.

### 📡 WiFi Client Intelligence
Client data is collected from both `hostapd_cli all_sta` and `iw station dump`, merged, and presented per frequency band (2.4 GHz / 5 GHz / 6 GHz) with signal strength and data rates. MAC addresses are matched against a built-in OUI lookup table (250+ vendor prefixes) to automatically classify devices as phones, computers, routers, IoT gadgets, or NAS systems.

### 🛡️ Security Audit
The dashboard surfaces SSH brute-force attempts (grouped by source IP), firewall DROP packet counts, and lets you manually block or unblock IP addresses — which instantly applies an `iptables` rule on the router via SSH.

### 🤖 AI Assistant
With a Claude API key configured, you can ask natural-language questions about your network directly in the dashboard. The assistant receives the current router state as context and answers in Chinese with concrete, data-backed responses. Anomaly events are also summarised by the AI so you understand not just *that* something happened but *why* it matters.

### 🔧 Auto Remediation
Define thresholds, and the system will act on them. In **auto** mode it can restart the WAN interface, DNS daemon, WiFi, or firewall; drop kernel caches when memory pressure is high; and even reboot the router as a last resort. In **observe** mode (the default) it logs what *would* have been done, so you can review before enabling automation.

### 🔔 Alerting
Telegram push notifications for: WAN down/recovery, ping spike (>3× baseline), sustained high load (≥2.0 for 3 consecutive readings), memory pressure (>88%), significant health score decline, and unusual night-time traffic. Every alert type has a configurable cooldown to prevent notification spam.

### 📦 Package Management
Browse installed OpenWrt packages, see which ones have upgrades available, and install, upgrade, or remove packages — all from the browser, without touching a terminal.

### 🗄️ Config Backup
Create point-in-time snapshots of the router's configuration and restore any of them with one click.

### 📱 Mobile UI
The layout is fully responsive. On small screens the sidebar collapses into a bottom navigation bar, stat grids reflow to two columns, and all cards remain usable with a thumb.

### 🧙 Setup Wizard
First-time visitors are greeted by a guided three-step wizard: enter SSH credentials → test the connection live → optionally add AI and Telegram keys → done. No config file editing, no command line required after install.

---

## 📋 Requirements

| Dependency | Notes |
|---|---|
| **Node.js ≥ 18** | Server runtime |
| **npm** | Dependency installation |
| **sshpass** | SSH password authentication to the router |
| **OpenWrt router** | Tested on GL-iNet BE6500; any OpenWrt device should work |
| **Claude API Key** | Optional — enables AI Q&A and anomaly summaries |
| **Telegram Bot Token** | Optional — enables push notifications |

---

## 🚀 Installation

### One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/yaoleifly/smart-homelab/main/install.sh | bash
```

The script checks for Node.js, npm, and sshpass; clones this repo; runs `npm install`; and starts the server with pm2 (or nohup as a fallback). When it finishes, open your browser:

**→ http://localhost:7070**

The Setup Wizard will appear. Follow the three steps to connect your router.

### Manual Installation

```bash
git clone https://github.com/yaoleifly/smart-homelab.git
cd smart-homelab
npm install
node server.js
```

### Production: Persistent with pm2

```bash
npm install -g pm2
pm2 start server.js --name smart-homelab
pm2 save       # survive reboots
pm2 startup    # generate systemd/launchd entry
```

---

## ⚙️ Configuration

All settings are managed through the in-browser **Settings** page (gear icon ⚙️ at the bottom of the sidebar). No manual file editing is needed after the initial setup.

| Setting | Default | Description |
|---|---|---|
| Router IP / Host | — | SSH address of your OpenWrt router |
| SSH Port | `22` | Router SSH port |
| Username | `root` | SSH login username |
| Password | — | SSH login password |
| AI API Key | — | Anthropic Claude API key (`sk-ant-api…`) |
| AI Host | `api.anthropic.com` | Custom API endpoint (e.g. for proxies) |
| AI Model | `claude-sonnet-4-6` | Claude model to use for AI features |
| Telegram Token | — | Telegram Bot token for push alerts |
| Telegram Chat ID | — | Your Telegram user or group ID |
| Monthly Budget (GB) | `0` (unlimited) | Alert threshold for monthly traffic |
| Collection Interval | `300` s | How often to poll the router |
| Remediation Mode | `observe` | `observe` (log only) or `auto` (apply fixes) |

> Settings are persisted to `data/user-config.json`, which is excluded from git and never contains hardcoded secrets.

---

## 🗂️ Project Structure

```
smart-homelab/
├── server.js          # HTTP server — all API routes, zero external dependencies
├── collect.sh         # SSH into router and dump raw metric data
├── parser.js          # Parse raw output → structured JSON snapshot
├── ingest.js          # Persist snapshot, trigger alerts, run remediation
├── store.js           # SQLite database layer (better-sqlite3, WAL mode)
├── ai.js              # Health scoring, anomaly detection, Claude API calls
├── alerts.js          # Alert rule engine, cooldowns, Telegram push
├── remediate.js       # SSH-based auto-fix actions
├── oui.js             # MAC OUI → device type lookup (250+ prefixes)
├── diagnose.js        # Structured multi-metric network diagnosis
├── backup.js          # Router config snapshot and restore
├── speedtest.js       # WAN speed test runner and history
├── config.js          # Runtime config: env vars > user-config > defaults
├── user-config.js     # Read/write data/user-config.json
├── dashboard.html     # Single-page frontend (vanilla JS + Chart.js, no build step)
└── install.sh         # One-liner installer with pm2/nohup
```

---

## 🔒 Data & Privacy

- All collected metrics are stored **locally** in `data/monitor.db` (SQLite, WAL mode)
- Router SSH credentials live only in `data/user-config.json`, which is git-ignored
- The dashboard server binds to `0.0.0.0:7070` — restrict with a firewall if needed
- **No telemetry.** The only outbound connections are: SSH to your router, optionally the Claude API, and optionally Telegram — all under your control

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, PR guidelines, and coding conventions. Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) or [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) issue templates.

---

## 📄 License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">

## 🇨🇳 中文说明

</div>

## Smart Homelab 是什么？

Smart Homelab 将你的 OpenWrt 路由器变成一个完全可观测、由 AI 辅助的家庭网络运维中心。整个系统运行在你自己的硬件上，无需云账号、无需订阅、数据永不离开你的家。

它每 5 分钟通过 SSH 连接路由器，采集数十项健康指标，存入本地 SQLite 数据库，并在精心设计的单页仪表盘中呈现一切。当出现问题时 —— WAN 断线、延迟飙升、SSH 暴力破解 —— 它可以通过 Telegram 提醒你，甚至自动修复问题。

可选的 Claude AI 集成让你可以用自然语言提问，比如"今晚网络为什么这么慢？"，并基于路由器的真实数据得到有依据的回答。

---

## ✨ 功能特性

### 📊 实时监控
采集所有关键指标：WAN 上下线状态、外网 IP、ping 往返延迟、丢包率、内存使用率、CPU 负载、存储空间、在线设备数。综合**健康评分（0–100）**通过加权算法和平滑衰减曲线汇总路由器整体状态，让你看到趋势而非瞬间抖动。

### 📈 流量分析
每次采集记录上下行增量，可视化为时间序列图表和 **7×24 热力图**，一眼看出哪些时段流量最大。月度流量汇总并与可配置的预算对比，超出阈值自动告警。

### 📡 WiFi 客户端智能识别
通过 `hostapd_cli all_sta` 和 `iw station dump` 双源采集客户端数据，按频段（2.4GHz / 5GHz / 6GHz）展示，包含信号强度和传输速率。内置 250+ 个 MAC OUI 前缀数据库，自动将设备分类为手机、电脑、路由器、IoT 设备或 NAS。

### 🛡️ 安全审计
显示 SSH 暴力破解尝试（按来源 IP 归组统计）、防火墙拦截数据包计数，支持在浏览器中手动封锁或解封 IP，操作即时通过 SSH 同步到路由器的 iptables 规则。

### 🤖 AI 智能问答
配置 Claude API Key 后，可在仪表盘内直接用自然语言询问网络状态。助手以当前路由器实时数据为上下文，用中文给出具体、有数据支撑的回答。异常事件也会由 AI 总结成易读的说明，帮助你理解不只是"发生了什么"，更是"为什么重要"。

### 🔧 自动修复
设定阈值，系统会自动响应。在 **auto（自动）** 模式下，可自动重启 WAN 接口、DNS 服务、WiFi 或防火墙；内存压力过高时清理内核缓存；最坏情况下重启路由器。默认的 **observe（观察）** 模式只记录"本应执行的操作"，方便你审查后再决定是否启用自动化。

### 🔔 告警通知
Telegram 推送通知：WAN 断线/恢复、ping 飙升（>3 倍基线）、持续高负载（连续 3 次 ≥2.0）、内存压力（>88%）、健康评分明显下滑、夜间异常流量。每种告警都有独立冷却时间，避免通知轰炸。

### 📦 插件管理
在浏览器中浏览已安装的 OpenWrt 软件包，查看可升级列表，安装、升级或卸载包 —— 无需打开终端。

### 🗄️ 配置备份
对路由器配置创建时间点快照，一键恢复任意历史版本。

### 📱 移动端适配
布局完全响应式。小屏幕下侧边栏折叠为底部导航栏，统计卡片变为两列布局，所有操作均适合拇指操作。

### 🧙 新手引导向导
首次访问时自动弹出三步引导：填写 SSH 凭据 → 实时测试连接 → 可选配置 AI 和 Telegram → 完成。无需编辑任何配置文件，安装后全程浏览器操作。

---

## 📋 依赖要求

| 依赖 | 说明 |
|---|---|
| **Node.js ≥ 18** | 服务器运行时 |
| **npm** | 依赖安装 |
| **sshpass** | SSH 密码认证连接路由器 |
| **OpenWrt 路由器** | 在 GL-iNet BE6500 上测试，理论支持所有 OpenWrt 设备 |
| **Claude API Key** | 可选，AI 问答和异常摘要功能需要 |
| **Telegram Bot Token** | 可选，推送告警通知需要 |

---

## 🚀 安装方式

### 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/yaoleifly/smart-homelab/main/install.sh | bash
```

脚本会自动检查 Node.js、npm、sshpass，克隆仓库，运行 `npm install`，并用 pm2（或 nohup 作为备用）启动服务。完成后打开浏览器：

**→ http://localhost:7070**

新手引导向导将自动弹出，按步骤完成路由器连接配置即可。

### 手动安装

```bash
git clone https://github.com/yaoleifly/smart-homelab.git
cd smart-homelab
npm install
node server.js
```

### 生产环境：使用 pm2 持久运行

```bash
npm install -g pm2
pm2 start server.js --name smart-homelab
pm2 save       # 开机自启
pm2 startup    # 生成 systemd/launchd 启动项
```

---

## ⚙️ 配置说明

所有设置通过浏览器内的 **系统设置** 页面（侧边栏底部 ⚙️ 图标）管理，无需手动编辑配置文件。

| 设置项 | 默认值 | 说明 |
|---|---|---|
| 路由器 IP / 主机名 | — | OpenWrt 路由器的 SSH 地址 |
| SSH 端口 | `22` | 路由器 SSH 端口 |
| 用户名 | `root` | SSH 登录用户名 |
| 密码 | — | SSH 登录密码 |
| AI API Key | — | Anthropic Claude API 密钥（`sk-ant-api…`） |
| AI Host | `api.anthropic.com` | 自定义 API 端点（如代理） |
| AI 模型 | `claude-sonnet-4-6` | AI 功能使用的 Claude 模型 |
| Telegram Token | — | Bot Token，用于推送告警 |
| Telegram Chat ID | — | 你的 Telegram 用户或群组 ID |
| 月流量预算 (GB) | `0`（不限） | 超出后触发告警 |
| 采集间隔 (秒) | `300` | 轮询路由器的频率 |
| 自动修复模式 | `observe` | `observe`（仅记录）或 `auto`（自动修复） |

> 配置持久存储于 `data/user-config.json`，已加入 `.gitignore`，不包含任何硬编码凭据。

---

## 🗂️ 项目结构

```
smart-homelab/
├── server.js          # HTTP 服务器，所有 API 路由，零外部依赖
├── collect.sh         # SSH 进入路由器采集原始指标数据
├── parser.js          # 解析原始输出 → 结构化 JSON 快照
├── ingest.js          # 持久化快照，触发告警，执行修复
├── store.js           # SQLite 数据层（better-sqlite3，WAL 模式）
├── ai.js              # 健康评分、异常检测、Claude API 调用
├── alerts.js          # 告警规则引擎、冷却机制、Telegram 推送
├── remediate.js       # 通过 SSH 执行自动修复动作
├── oui.js             # MAC OUI → 设备类型分类（250+ 前缀）
├── diagnose.js        # 多指标结构化网络诊断
├── backup.js          # 路由器配置快照与恢复
├── speedtest.js       # WAN 速度测试运行器和历史记录
├── config.js          # 运行时配置：环境变量 > 用户配置 > 默认值
├── user-config.js     # 读写 data/user-config.json
├── dashboard.html     # 单页前端（原生 JS + Chart.js，无构建步骤）
└── install.sh         # 一键安装脚本，支持 pm2 和 nohup
```

---

## 🔒 数据与隐私

- 所有采集数据**本地存储**于 `data/monitor.db`（SQLite，WAL 模式）
- 路由器 SSH 凭据仅保存于 `data/user-config.json`，已加入 git-ignore
- 仪表盘服务监听 `0.0.0.0:7070`，如需限制访问请配置防火墙
- **零遥测**。唯一的出站连接是：SSH 到你的路由器、可选的 Claude API、可选的 Telegram —— 均由你掌控

---

## 🤝 参与贡献

欢迎任何形式的贡献！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解本地开发配置、PR 规范和编码约定。提交问题请使用 [Bug 反馈](.github/ISSUE_TEMPLATE/bug_report.md) 或 [功能建议](.github/ISSUE_TEMPLATE/feature_request.md) 模板。

---

## 📄 开源协议

[MIT](LICENSE) — 自由使用、修改和分发。
