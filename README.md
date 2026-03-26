# Collator Monitor

Tracks whether a Moonbeam or Moonriver collator is in the active set — without relying on delegation changes.

Uses `isSelectedCandidate(address)` and `awardedPoints(round, address)` from the ParachainStaking precompile (`0x0000000000000000000000000000000000000800`) via direct `eth_call`. Runs as a GitHub Actions cron every 30 minutes.

## How it works

```
GitHub Actions (every 30 min)
  └─ scripts/check.mjs
       ├─ reads  config.json       (your collators)
       ├─ calls  isSelectedCandidate(address) on each
       ├─ calls  awardedPoints(round, address) for active collators
       ├─ detects transitions (active → inactive, or back)
       ├─ sends  Telegram alert on transition
       └─ writes status.json       (committed back to repo)

GitHub Pages
  └─ index.html fetches status.json every 5 min and renders the dashboard
```

Rounds are ~2 hours. 30-minute polling gives ~4 checks per round.
The alert fires only after **2 consecutive inactive checks** (configurable) to avoid noise during round transitions.

---

## Quick start

### 1. Fork / clone this repo

```bash
git clone https://github.com/YOUR_USERNAME/collator-monitor.git
cd collator-monitor
```

### 2. Edit `config.json`

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

> **Address format**: H160 / EVM format (`0x` + 40 hex chars).  
> This is the address shown in Moonscan. NOT the SS58 / Substrate format.

### 3. Push to GitHub

```bash
git add config.json
git commit -m "feat: add my collators"
git push
```

### 4. Enable GitHub Pages

1. Go to **Settings → Pages** in your GitHub repo
2. Source: **Deploy from a branch**
3. Branch: `main`, folder: `/ (root)`
4. Save — your dashboard will be live at `https://YOUR_USERNAME.github.io/collator-monitor/`

### 5. Set up Telegram alerts (optional but recommended)

1. Message [@BotFather](https://t.me/botfather) on Telegram → `/newbot` → copy the token
2. Start a chat with your new bot, then find your chat ID via `https://api.telegram.org/botTOKEN/getUpdates`
3. Go to **Settings → Secrets and variables → Actions** in your GitHub repo
4. Add two repository secrets:
   - `TELEGRAM_BOT_TOKEN` — the token from BotFather
   - `TELEGRAM_CHAT_ID`   — your numeric chat ID

### 6. Trigger first run

Go to **Actions → Collator monitor → Run workflow** to run immediately without waiting 30 minutes.

---

## Files

| File | Purpose |
|------|---------|
| `config.json` | List of collators to watch. **Edit this.** |
| `status.json` | Auto-updated by CI. Do not edit manually. |
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
