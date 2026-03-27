# Collator Monitor

Tracks whether a Moonbeam or Moonriver collator is in the active set — without relying on delegation changes.

Uses `isSelectedCandidate(address)` and `awardedPoints(round, address)` from the ParachainStaking precompile (`0x0000000000000000000000000000000000000800`) via direct `eth_call`. Runs as a GitHub Actions cron every 30 minutes.

**Privacy**: Collator addresses and Telegram chat IDs are stored in GitHub Secrets, not in the repo. The public `status.json` only shows truncated addresses (`0x1234…5678`).

## How it works

```
GitHub Actions (every 30 min)
  └─ scripts/check.mjs
       ├─ reads  COLLATOR_CONFIG secret   (your collators - private)
       ├─ calls  isSelectedCandidate(address) on each
       ├─ calls  awardedPoints(round, address) for active collators
       ├─ detects transitions (active → inactive, or back)
       ├─ sends  Telegram alert on transition
       └─ writes status.json              (addresses truncated, committed to repo)

GitHub Pages
  └─ index.html fetches status.json every 5 min and renders the dashboard
```

Rounds are ~2 hours. 30-minute polling gives ~4 checks per round.
The alert fires only after **2 consecutive inactive checks** (configurable) to avoid noise during round transitions.

---

## Quick start

### 1. Fork this repo

Click "Fork" in the top right, then clone your fork:

```bash
git clone https://github.com/YOUR_USERNAME/collator-monitor.git
cd collator-monitor
```

### 2. Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions** and add these repository secrets:

| Secret | Required | Example value |
|--------|----------|---------------|
| `COLLATOR_CONFIG` | **Yes** | See below |
| `TELEGRAM_BOT_TOKEN` | Optional | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `TELEGRAM_CHAT_ID` | Optional (but required if token is set) | `123456789` or `123456789,987654321` |

#### `COLLATOR_CONFIG` format

```json
{
  "collators": [
    {
      "address": "0xYourCollatorH160Address",
      "network": "moonbeam",
      "label": "My Moonbeam Collator"
    },
    {
      "address": "0xAnotherCollator",
      "network": "moonriver",
      "label": "My Moonriver Collator"
    }
  ],
  "consecutiveInactiveChecksBeforeAlert": 2
}
```

> **Address format**: H160 / EVM format (`0x` + 40 hex chars). This is the address shown in Moonscan, NOT the SS58/Substrate format.

#### Multiple Telegram recipients

Separate chat IDs with commas in `TELEGRAM_CHAT_ID`:
```
123456789,987654321,111222333
```

#### Getting Telegram credentials

1. Message [@BotFather](https://t.me/botfather) → `/newbot` → copy the token
2. Start a chat with your bot
3. Get your chat ID: `https://api.telegram.org/botYOUR_TOKEN/getUpdates` (look for `chat.id`)

### 3. Enable GitHub Pages

1. Go to **Settings → Pages** in your GitHub repo
2. Source: **Deploy from a branch**
3. Branch: `main`, folder: `/ (root)`
4. Save

Your dashboard will be live at: `https://YOUR_USERNAME.github.io/collator-monitor/`

### 4. Trigger first run

Go to **Actions → Collator monitor → Run workflow** to run immediately without waiting 30 minutes.

---

## Files

| File | Purpose |
|------|---------|
| `config.json` | Template only. Real config comes from `COLLATOR_CONFIG` secret. |
| `status.json` | Auto-updated by CI. Addresses are truncated for privacy. |
| `index.html` | Dashboard. Fetches `status.json` every 5 min. |
| `scripts/check.mjs` | Node.js checker. Runs in GitHub Actions. |
| `.github/workflows/monitor.yml` | Cron schedule + git-push logic. |

---

## Status meanings

| Status | Meaning |
|--------|---------|
| `active` | In the active set, earning points this round |
| `warning` | In the active set but **0 points** so far this round (soft signal — may be early in round) |
| `inactive` | **Not in the active set** — alerts sent after 2 consecutive checks |
| `error` | RPC call failed |

---

## Local development

For local testing, you can edit `config.json` directly (it will be used if `COLLATOR_CONFIG` secret is not set):

```bash
npm install
node scripts/check.mjs        # run one check cycle

# Serve the dashboard locally
npx serve . -p 3000
# open http://localhost:3000
```

---

## Changing the check interval

Edit `.github/workflows/monitor.yml`:

```yaml
schedule:
  - cron: '*/30 * * * *'   # every 30 min — change as needed (minimum: */5)
```

> GitHub Actions free tier has a monthly limit of 2,000 minutes.  
> Every 30 min = ~1,440 runs/month × ~30 sec each ≈ **720 minutes/month** (well within limits).

---

## Private deployment

The simplest option is a **private GitHub repo** with GitHub Pages enabled (requires GitHub Pro/Team for private repos + Pages).

Alternatively, deploy `index.html` and `status.json` to **Vercel** as a static site:

1. Import the repo in Vercel
2. Set the output directory to `.` (root)
3. GitHub Actions still handles the cron and commits `status.json` to git
4. Vercel auto-deploys on every push — so each status update triggers a redeploy

> Note: Vercel free tier limits to 100 deployments/day, so every-30-min updates = 48/day — fine.
