# Handover: Collator Monitor

This document is a complete technical handover for any AI coding assistant (e.g. Claude Code, Cursor, Aider) picking up this project.

---

## What this project does

Monitors whether one or more Moonbeam or Moonriver collators are in the **active set** (selected candidates). Runs on GitHub Actions every 30 minutes. Publishes a static dashboard via GitHub Pages (or Vercel). Sends Telegram alerts on transitions.

The signal used is **not** delegation changes (which tools like W3Alert / Subscan can track). It queries the active set directly, which means it catches collators dropping out even when their delegation is unchanged.

---

## Architecture

```
collator-monitor/
├── index.html                  Static dashboard (GitHub Pages / Vercel)
├── status.json                 Machine-written state file (committed by CI)
├── config.json                 Human-written collator config
├── package.json                Node.js deps (just ethers v6)
├── scripts/
│   └── check.mjs               Core checker — runs in GitHub Actions
├── .github/
│   └── workflows/
│       └── monitor.yml         Cron workflow
├── README.md                   Setup guide
└── HANDOVER.md                 This file
```

### Data flow

1. **GitHub Actions** triggers `scripts/check.mjs` every 30 minutes
2. `check.mjs` reads `config.json`, calls the staking precompile for each collator, detects transitions, optionally sends Telegram, writes `status.json`
3. GitHub Actions commits `status.json` back to `main` with `[skip ci]` (prevents re-triggering)
4. **index.html** (served by GitHub Pages or Vercel) fetches `status.json` every 5 minutes and renders the dashboard

---

## Key contract: Staking Precompile

Both Moonbeam and Moonriver expose a staking precompile at the same address:

```
0x0000000000000000000000000000000000000800
```

This is an EVM contract backed by the `parachainStaking` Substrate pallet. Relevant ABI:

```solidity
// Current round number + first block + length
function round() view returns (uint256 current, uint256 first, uint256 length)

// True if the address is currently in the active selected-candidates set
function isSelectedCandidate(address candidate) view returns (bool)

// Points awarded to a candidate in a given round (0 early in round = normal)
function awardedPoints(uint32 round, address candidate) view returns (uint32)
```

RPC endpoints:
- Moonbeam:   `https://rpc.api.moonbeam.network`
- Moonriver:  `https://rpc.api.moonriver.moonbeam.network`

Both are public, no API key needed.

---

## config.json schema

```jsonc
{
  "collators": [
    {
      "address": "0x...",       // Required. H160 EVM format (0x + 40 hex chars)
      "network": "moonbeam",    // Required. "moonbeam" | "moonriver"
      "label":   "My Collator" // Optional. Display name
    }
  ],
  "consecutiveInactiveChecksBeforeAlert": 2,  // Default: 2
  "alerts": {
    "telegram": { "enabled": true }  // Token/chatId come from env vars, not here
  }
}
```

---

## status.json schema

Written by `check.mjs`, read by `index.html`. Do not edit manually.

```jsonc
{
  "lastUpdated": "2024-01-01T00:00:00.000Z",  // ISO timestamp of last check run
  "collators": {
    "moonbeam:0xabc...": {
      "address":            "0xabc...",
      "network":            "moonbeam",
      "label":              "My Collator",
      "isActive":           true,
      "points":             142,        // null if not active or call failed
      "currentRound":       4812,
      "consecutiveInactive": 0,         // resets to 0 when active
      "alertedInactive":    false,      // true = alert already sent, don't re-send
      "statusText":         "active",   // "active" | "inactive" | "warning" | "error"
      "lastChecked":        "2024-01-01T00:00:00.000Z",
      "lastError":          null        // string if RPC call failed
    }
  }
}
```

`statusText` values:
- `active`   — in set, points > 0
- `warning`  — in set, points = 0 (may be early in round; soft signal)
- `inactive` — NOT in active set (triggers alert after threshold)
- `error`    — RPC call failed

---

## Alert logic (check.mjs)

```
consecutiveInactive++  when !isActive
consecutiveInactive=0  when isActive (resets on recovery)

trigger INACTIVE ALERT when:
  !isActive AND consecutiveInactive >= threshold AND NOT already alertedInactive

trigger RECOVERY ALERT when:
  isActive AND alertedInactive was true

alertedInactive stays true until the collator recovers (prevents spam)
```

The threshold default is 2 consecutive checks (= ~1 hour of absence).

---

## Environment variables (GitHub Actions secrets)

| Secret | Purpose |
|--------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Numeric chat ID to send alerts to |

Both are optional. If absent, alerts are skipped and a log message is printed.

---

## GitHub Actions workflow (monitor.yml)

```yaml
on:
  schedule:
    - cron: '*/30 * * * *'  # every 30 min
  workflow_dispatch:          # manual trigger

permissions:
  contents: write             # needed to commit status.json

steps:
  - checkout
  - setup-node@v4 (node 20)
  - npm install
  - node scripts/check.mjs   (with TELEGRAM_* env vars)
  - git add status.json
  - commit + push (only if changed, [skip ci] to prevent loop)
```

The `[skip ci]` tag in the commit message prevents GitHub Actions from triggering itself again when status.json is pushed.

---

## index.html

Pure vanilla JS, no build step, no dependencies. Served as a static file.

- Fetches `status.json?t=${Date.now()}` every 5 minutes (cache-busting)
- Renders collator cards sorted by severity (inactive → warning → active)
- Shows: label, address, network badge, status badge, round, points, last checked time
- Animated progress bar counts down to next refresh
- Live/stale/error indicator dot in the top bar
- Alert banner when any collator is inactive

---

## How to extend

### Add email alerts
In `check.mjs`, add a `sendEmail()` function alongside `sendTelegram()`. Use NodeMailer or a transactional service (Resend, Sendgrid) — both work in GitHub Actions. Add the relevant API key as a GitHub secret.

### Add more networks
Update the `RPC` object in `check.mjs`:
```js
const RPC = {
  moonbeam:  'https://rpc.api.moonbeam.network',
  moonriver: 'https://rpc.api.moonriver.moonbeam.network',
  // moonbase: 'https://rpc.api.moonbase.moonbeam.network',  // testnet
};
```
The precompile address is the same on all Moonbeam-based networks.

### Check `selectedCandidates()` (full active set)
The precompile also exposes:
```solidity
function selectedCandidates() view returns (address[] memory)
```
This returns the entire active set as an array. Useful if you want to track the full set size or detect unexpected collators.

### Require 0 points for a full round (not just any check)
Track `roundWhenPointsWereZero` in status.json. Only warn if `points === 0 && currentRound > roundWhenPointsWereZero`. This avoids early-round false positives.

### Use Substrate API instead of EVM precompile
If you prefer Polkadot.js, use `@polkadot/api` to query:
- `api.query.parachainStaking.selectedCandidates()` — full active set
- `api.query.parachainStaking.round()` — current round info

Moonbeam WS endpoints:
- Moonbeam:   `wss://wss.api.moonbeam.network`
- Moonriver:  `wss://wss.api.moonriver.moonbeam.network`

---

## Local development

```bash
# Install
npm install

# Run one check cycle (writes status.json)
node scripts/check.mjs

# Serve dashboard locally
npx serve . -p 3000
# Then open http://localhost:3000

# With Telegram alerts locally (optional)
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy node scripts/check.mjs
```

---

## Known limitations

1. **Tab must stay open** — the dashboard auto-refresh is client-side JS. If the tab is closed, it won't poll. The actual monitoring is in GitHub Actions, so alerts still work regardless.

2. **`awardedPoints` at round start** — this will always be 0 at the beginning of a new round until the collator produces its first block. The `warning` status for 0 points is a soft signal; don't act on it unless it persists for multiple checks.

3. **GitHub Actions cron jitter** — GitHub doesn't guarantee exact cron timing, especially under load. Runs may be delayed by several minutes. This is fine for round-level monitoring.

4. **Public GitHub Pages** — if the repo is public, the dashboard URL is publicly accessible. The data it shows (collator addresses, active status) is already public on-chain, so this is generally fine. For strict privacy, use a private repo + GitHub Pro, or deploy to Vercel with password protection.

5. **RPC reliability** — the public Moonbeam/Moonriver RPC endpoints are generally stable but can be rate-limited or briefly unavailable. `check.mjs` logs the error and marks the collator as `statusText: 'error'` without crashing. The next run will retry.

---

## Useful links

- [Moonbeam staking precompile docs](https://docs.moonbeam.network/builders/pallets-precompiles/precompiles/staking/)
- [Moonbeam staking precompile ABI](https://github.com/moonbeam-foundation/moonbeam/blob/master/precompiles/parachain-staking/StakingInterface.sol)
- [Moonscan (Moonbeam)](https://moonscan.io)
- [Moonscan (Moonriver)](https://moonriver.moonscan.io)
- [GitHub Actions cron syntax](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)
