# Smart Homelab

**English** | [中文](#中文说明)

---

## English

An AI-powered router monitoring dashboard for OpenWrt — self-hosted, zero cloud dependency, single `node server.js` to run.

### Features

| Category | Details |
|---|---|
| **Real-time Monitoring** | WAN status, ping RTT, memory, CPU load, connected devices |
| **Health Scoring** | 0–100 composite score with smooth curves and noise filtering |
| **Traffic Analysis** | Per-5-min delta Rx/Tx, 7×24 heatmap, monthly budget tracking |
| **WiFi Clients** | Per-band (2.4/5/6 GHz) client list via `hostapd_cli` + `iw` |
| **Device Management** | MAC OUI auto-classification, hostname tracking, presence heatmap |
| **Security Audit** | SSH brute-force detection, firewall drop stats, IP block/unblock |
| **AI Assistant** | Ask questions about your network in natural language (Claude API) |
| **Auto Remediation** | Rule-based auto-fix: restart WAN/DNS/WiFi, drop caches, reboot |
| **Alerting** | Telegram notifications: WAN down, ping spike, high load, night traffic |
| **Anomaly Detection** | Statistical baseline (σ=2.5) for traffic, ping, load, memory |
| **Package Manager** | Browse, install, upgrade, remove OpenWrt packages via opkg |
| **Config Backup** | Snapshot router config, restore from history |
| **Speed Test** | Run and chart WAN speed tests |
| **SSE Live Push** | Browser receives real-time health updates without polling |
| **Mobile UI** | Responsive layout with bottom nav for phones |
| **Settings Page** | Configure SSH, AI key, Telegram, budget — all in-browser, no config file editing |

### Requirements

| Dependency | Notes |
|---|---|
| **Node.js ≥ 18** | Runtime |
| **sshpass** | SSH password auth to router |
| **OpenWrt router** | Tested on GL-iNet BE6500; any OpenWrt device should work |
| **Claude API Key** | Optional — required for AI Q&A and anomaly summaries |
| **Telegram Bot** | Optional — required for push notifications |

### Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/yaoleifly/smart-homelab/main/install.sh | bash
```

Then open **http://localhost:7070** and configure your router SSH credentials in the **Settings** page.

#### Manual Install

```bash
git clone https://github.com/yaoleifly/smart-homelab.git
cd smart-homelab
npm install
node server.js
```

#### Run with pm2 (recommended for production)

```bash
npm install -g pm2
pm2 start server.js --name smart-homelab
pm2 save
pm2 startup
```

### Configuration

All settings are managed through the in-browser **Settings** page (⚙️ gear icon in sidebar). No manual file editing required.

| Setting | Description |
|---|---|
| Router IP / Host | SSH address of your OpenWrt router |
| SSH Port | Default: 22 |
| Username | Default: `root` |
| Password | Router SSH password |
| AI API Key | Anthropic Claude API key (`sk-ant-api…`) |
| AI Host | Default: `api.anthropic.com` (supports custom endpoints) |
| AI Model | Default: `claude-sonnet-4-6` |
| Telegram Token | Bot token for push alerts |
| Telegram Chat ID | Your Telegram chat/user ID |
| Monthly Budget (GB) | Traffic budget alert threshold |
| Collection Interval | How often to poll the router (default: 300s) |
| Remediation Mode | `observe` (log only) or `auto` (apply fixes) |

Settings are stored in `data/user-config.json` — never committed to git.

### Project Structure

```
smart-homelab/
├── server.js          # HTTP server, all API routes
├── collect.sh         # SSH into router, dump raw data
├── parser.js          # Parse raw SSH output → JSON snapshot
├── ingest.js          # Store snapshot, run alerts & remediation
├── store.js           # SQLite database layer (better-sqlite3)
├── ai.js              # Health scoring, anomaly detection, Claude API
├── alerts.js          # Alert rules + Telegram notifications
├── remediate.js       # Auto-fix actions via SSH
├── oui.js             # MAC OUI → device type classification
├── diagnose.js        # Structured network diagnosis
├── backup.js          # Router config backup/restore
├── speedtest.js       # WAN speed test
├── config.js          # Runtime config (env > user-config > defaults)
├── user-config.js     # Persistent user settings (data/user-config.json)
├── dashboard.html     # Single-page frontend (vanilla JS, Chart.js)
└── install.sh         # One-liner installer
```

### Data & Privacy

- All data is stored **locally** in `data/monitor.db` (SQLite)
- Router credentials live only in `data/user-config.json` (git-ignored)
- No telemetry, no external services except the AI API and Telegram (both optional)

### License

MIT

---

## 中文说明

一个为 OpenWrt 路由器打造的 AI 智能监控面板 —— 完全自托管，零云依赖，一条命令启动。

### 功能特性

| 模块 | 说明 |
|---|---|
| **实时监控** | WAN 状态、ping 延迟、内存、CPU 负载、在线设备数 |
| **健康评分** | 0–100 综合评分，平滑曲线算法 + 噪声过滤 |
| **流量分析** | 每 5 分钟上下行增量、7×24 热力图、月度流量预算 |
| **WiFi 客户端** | 按频段（2.4/5/6 GHz）展示连接设备，来源 `hostapd_cli` + `iw` |
| **设备管理** | MAC OUI 自动分类、主机名追踪、在线时段热力图 |
| **安全审计** | SSH 暴力破解检测、防火墙拦截统计、IP 封锁/解封 |
| **AI 问答** | 用自然语言询问网络状态（基于 Claude API） |
| **自动修复** | 规则驱动：自动重启 WAN/DNS/WiFi、清理缓存、重启路由器 |
| **告警通知** | Telegram 推送：WAN 断线、延迟飙升、负载过高、夜间异常流量 |
| **异常检测** | 基于统计基线（σ=2.5）检测流量、延迟、负载、内存异常 |
| **插件管理** | 通过 opkg 浏览、安装、升级、卸载 OpenWrt 软件包 |
| **配置备份** | 快照路由器配置，支持历史恢复 |
| **测速** | 执行并图表化 WAN 速度测试 |
| **SSE 实时推送** | 浏览器实时接收健康状态更新，无需轮询 |
| **移动端适配** | 响应式布局，手机底部导航栏 |
| **设置页面** | 浏览器内配置 SSH、AI Key、Telegram、流量预算，无需手动编辑文件 |

### 依赖要求

| 依赖 | 说明 |
|---|---|
| **Node.js ≥ 18** | 运行时 |
| **sshpass** | SSH 密码认证连接路由器 |
| **OpenWrt 路由器** | 在 GL-iNet BE6500 上测试，理论支持所有 OpenWrt 设备 |
| **Claude API Key** | 可选，AI 问答和异常摘要功能需要 |
| **Telegram Bot** | 可选，推送告警通知需要 |

### 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/yaoleifly/smart-homelab/main/install.sh | bash
```

安装完成后打开 **http://localhost:7070**，在 **系统设置** 页面（⚙️ 侧边栏底部）填写路由器 SSH 信息即可。

#### 手动安装

```bash
git clone https://github.com/yaoleifly/smart-homelab.git
cd smart-homelab
npm install
node server.js
```

#### 使用 pm2 持久运行（推荐生产环境）

```bash
npm install -g pm2
pm2 start server.js --name smart-homelab
pm2 save
pm2 startup
```

### 配置说明

所有设置通过浏览器内的 **系统设置** 页面管理，无需手动编辑配置文件。

| 设置项 | 说明 |
|---|---|
| 路由器 IP / 主机名 | OpenWrt 路由器的 SSH 地址 |
| SSH 端口 | 默认 22 |
| 用户名 | 默认 `root` |
| 密码 | 路由器 SSH 密码 |
| AI API Key | Anthropic Claude API 密钥（`sk-ant-api…`） |
| AI Host | 默认 `api.anthropic.com`，支持自定义端点 |
| AI 模型 | 默认 `claude-sonnet-4-6` |
| Telegram Token | Bot Token，用于推送告警 |
| Telegram Chat ID | 你的 Telegram 用户/群组 ID |
| 月流量预算 (GB) | 超出后触发告警 |
| 采集间隔 (秒) | 轮询路由器的频率，默认 300 秒 |
| 自动修复模式 | `observe`（仅记录）或 `auto`（自动修复） |

配置存储于 `data/user-config.json`，已加入 `.gitignore`，不会被提交到 git。

### 项目结构

```
smart-homelab/
├── server.js          # HTTP 服务器，所有 API 路由
├── collect.sh         # SSH 进入路由器采集原始数据
├── parser.js          # 解析 SSH 原始输出 → JSON 快照
├── ingest.js          # 存储快照，执行告警与自动修复
├── store.js           # SQLite 数据层（better-sqlite3）
├── ai.js              # 健康评分、异常检测、Claude API
├── alerts.js          # 告警规则 + Telegram 推送
├── remediate.js       # 通过 SSH 执行自动修复动作
├── oui.js             # MAC OUI → 设备类型分类
├── diagnose.js        # 结构化网络诊断
├── backup.js          # 路由器配置备份/恢复
├── speedtest.js       # WAN 速度测试
├── config.js          # 运行时配置（环境变量 > 用户配置 > 默认值）
├── user-config.js     # 持久化用户设置（data/user-config.json）
├── dashboard.html     # 单页前端（原生 JS + Chart.js）
└── install.sh         # 一键安装脚本
```

### 数据与隐私

- 所有数据**本地存储**于 `data/monitor.db`（SQLite）
- 路由器凭据仅保存在 `data/user-config.json`（已 git-ignore）
- 无任何遥测，无外部服务依赖（AI API 和 Telegram 均为可选）

### 开源协议

MIT
