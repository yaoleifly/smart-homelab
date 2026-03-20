# Contributing to Smart Homelab

Thanks for your interest! Contributions of all sizes are welcome — bug fixes, new features, documentation improvements, and translations.

---

## Quick Start (Local Dev)

**Prerequisites:** Node.js ≥ 18, npm, sshpass, an OpenWrt router (or use Demo Mode)

```bash
git clone https://github.com/yaoleifly/smart-homelab.git
cd smart-homelab
npm install
node server.js
# Open http://localhost:7070
```

On first launch the Setup Wizard appears. You can skip it and use **Demo Mode** to explore the UI without a real router.

---

## Project Structure

```
server.js        HTTP server — add new API routes here
dashboard.html   Single-file frontend — HTML + CSS + vanilla JS
collect.sh       SSH data collection script
parser.js        Parses raw SSH output into a JSON snapshot
ingest.js        Stores snapshot, triggers alerts & remediation
store.js         All SQLite queries (better-sqlite3)
ai.js            Health scoring, anomaly detection, Claude API calls
alerts.js        Alert rule engine + Telegram notifications
remediate.js     SSH-based auto-fix actions
oui.js           MAC OUI → device type lookup table
config.js        Runtime config (env > user-config.json > defaults)
user-config.js   Read/write data/user-config.json
```

---

## How to Contribute

### Reporting Bugs

Use the **Bug Report** issue template. Include:
- OS and Node.js version (`node -v`)
- Router model and OpenWrt version
- Relevant lines from `logs/collect.log` or `logs/server.log`
- Steps to reproduce

### Suggesting Features

Use the **Feature Request** issue template. Describe the use case before the solution — this helps evaluate fit.

### Submitting a Pull Request

1. **Fork** the repo and create a branch: `git checkout -b feat/my-feature`
2. Make your changes (see conventions below)
3. Test manually: start the server, check the affected pages
4. **Commit** with a clear message:
   - `feat:` new feature
   - `fix:` bug fix
   - `docs:` documentation only
   - `refactor:` no behaviour change
   - `chore:` tooling/config
5. Push and open a PR against `main`

### PR Guidelines

- Keep PRs focused — one logical change per PR
- Update `CHANGELOG.md` under `[Unreleased]` if user-facing
- Don't bump `package.json` version — maintainers handle releases
- Screenshots welcome for UI changes

---

## Coding Conventions

### Backend (Node.js)
- `'use strict'` at the top of every module
- No new runtime dependencies without discussion — the goal is minimal deps
- All DB access goes through `store.js`; no raw SQLite elsewhere
- Credentials are **never** hardcoded; always read from `config.js` or `user-config.js`
- New API routes: add to `server.js`, follow the existing `if (pathname === …)` pattern

### Frontend (`dashboard.html`)
- Vanilla JS only — no frameworks, no build step
- New pages: add a `<section class="page" id="page-xxx">` block, a `.nav-item` in the sidebar, and a `renderPage` branch
- CSS variables for all colours — never use raw hex/rgb values
- All text strings in Chinese (this is the primary interface language)

### Shell (`collect.sh`)
- Read all credentials from environment variables — never hardcode
- New data sections: add a `printf "###SECTION###\n"; ...` block, then parse in `parser.js`

---

## Release Process (maintainers)

```bash
npm version patch   # or minor / major
git push --follow-tags
# Then create a GitHub Release from the new tag
```

---

## License

By contributing you agree your work will be licensed under the [MIT License](LICENSE).
