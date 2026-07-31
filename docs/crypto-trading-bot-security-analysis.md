# Security Analysis: Haehnchen/crypto-trading-bot

- **Repository:** https://github.com/Haehnchen/crypto-trading-bot
- **Commit analyzed:** `240857abe4780d465e07d184e580506c7822dded` (2026-03-01, current master)
- **Analysis date:** 2026-07-31
- **Scope:** Static analysis for malware, keyloggers, credential exfiltration, obfuscation, supply-chain tampering, and malicious install/CI hooks.

## Verdict: CLEAN

No malware, keylogger, backdoor, credential exfiltration, or obfuscated code was
found. The project is a legitimate, long-standing open-source margin/spot trading
bot by Daniel Espendiller (author of the Symfony Support plugin for PhpStorm),
MIT-licensed, with a public issue/PR history.

## What was checked and what was found

### 1. Install-time attack vectors (npm scripts)
`package.json` defines **no** `preinstall`, `install`, or `postinstall` hooks —
the most common npm malware vector. Scripts are limited to build (`esbuild`,
`tsc`), test (`mocha`), and pm2 deploy commands.

### 2. Dependencies / supply chain
- All dependencies are mainstream, widely-used packages: `ccxt`, `express`,
  `telegraf`, `better-sqlite3`, `talib`, `technicalindicators`, `nodemailer`,
  `winston`, `moment`, `commander`, etc. No typosquats spotted.
- All **463** `resolved` entries in `package-lock.json` point to the official
  `registry.npmjs.org` — no git URLs, no third-party registries, no tarball URLs.
- Native-build packages (`better-sqlite3`, `talib`) are the standard published
  versions; native compilation at install time is expected for these.

### 3. Dynamic code execution / obfuscation
Zero hits in first-party source for `eval(`, `new Function`, `child_process`,
`execSync`, `spawn(`, `String.fromCharCode`, `atob(`, or base64/hex
`Buffer.from` decoding. No minified/obfuscated blobs: no source line exceeds
500 characters outside the vendored, human-readable `slim-select.js` UI library.

### 4. Keylogger check
The only keyboard event listeners are benign browser-UI handlers in the bot's
own local dashboard:
- `views/desk/form.ejs`, `views/dashboard/settings.ejs` — arrow-key/Enter
  navigation of a symbol-search dropdown.
- `web/static/js/orders.js` — `keyup` to recalculate an order total and filter a
  table locally.

No captured keystrokes are stored or transmitted anywhere. There is no
OS-level input hooking anywhere in the codebase (and no dependency capable of it).

### 5. Network traffic / exfiltration
Every outbound call site was enumerated. Complete list of destinations:
- Exchange APIs via the `ccxt` library — driven by user-configured exchange profiles.
- `api.binance.com/api/v3/ticker/price` and `api.coingecko.com` — public,
  unauthenticated price/market data.
- `symbol-search.tradingview.com` — public symbol search for the UI.
- Notifications (Slack webhook, Telegram via `telegraf`, email via
  `nodemailer`/`sendmail`) — all go **only** to endpoints the user configures;
  the Slack URL in docs is a `hooks.slack.com/services/...` placeholder.
- Frontend CDNs (jsdelivr, cdnjs, d3js.org, s3.tradingview.com) for dashboard
  JS/CSS assets.

No hardcoded IP addresses, no unknown hosts, no telemetry/analytics beacons.

### 6. Credential handling
Exchange API keys/secrets are read from the user's local config and passed only
into `ccxt.Exchange({ apiKey, secret })` (`src/modules/system/exchange_instance_service.ts`),
which signs requests to the exchange the user selected. Credentials are never
logged to remote services or sent to any third party.

### 7. CI / repo hygiene
- The single GitHub Actions workflow (`.github/workflows/node.js.yml`) is a
  stock Node.js test workflow (`npm install` + `npm test`) with no secret
  access, no curl-to-shell, no artifact exfiltration.
- All binary files verified by magic bytes: PNGs are real screenshots,
  `slim-select.js` is plain ASCII JavaScript source.

## Caveats (not malware, but worth knowing)

1. **Static analysis of one commit.** This covers the current master. If you
   run this bot, pin the commit you audited and re-review before pulling updates.
2. **Dependency depth.** Lockfile sources were verified, but the *contents* of
   all 463 transitive packages were not individually audited. Use
   `npm audit` / a lockfile-pinned install and avoid `npm install` on unpinned ranges.
3. **Operational risk.** The web dashboard ships with `basic-auth` — if you
   expose it to the internet, set strong credentials and prefer keeping it
   bound to localhost/VPN. Give the bot's exchange API keys **trade-only**
   permissions (no withdrawal) as a general precaution with any trading bot.
4. **Financial risk is separate from security risk.** A clean codebase says
   nothing about strategy profitability.
