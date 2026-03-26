/**
 * Collator active-set checker
 *
 * Reads config.json, queries the Moonbeam/Moonriver staking precompile for each
 * configured collator, detects active-set transitions, sends Telegram alerts,
 * and writes the result back to status.json.
 *
 * Called by GitHub Actions every 30 minutes.
 */

import { ethers } from 'ethers';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');

// ── RPC endpoints ─────────────────────────────────────────────────────────────

const RPC = {
  moonbeam:   'https://rpc.api.moonbeam.network',
  moonriver:  'https://rpc.api.moonriver.moonbeam.network',
};

// ── Staking precompile ────────────────────────────────────────────────────────

const PRECOMPILE = '0x0000000000000000000000000000000000000800';

const ABI = [
  // Current round info: returns (currentRound, firstBlock, length)
  'function round() view returns (uint256 current, uint256 first, uint256 length)',
  // Whether a collator is in the current active set
  'function isSelectedCandidate(address candidate) view returns (bool)',
  // Points awarded to a candidate in a given round (0 early in round is normal)
  'function awardedPoints(uint32 round, address candidate) view returns (uint32)',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const readJSON  = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJSON = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

function shortAddr(addr) {
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

async function sendTelegram(message) {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = process.env.TELEGRAM_CHAT_ID?.split(',').map(s => s.trim()).filter(Boolean);
  if (!token || !chatIds?.length) {
    console.log('  [Telegram] No credentials set — skipping notification.');
    return;
  }
  for (const chatId of chatIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      });
      if (!res.ok) console.error('  [Telegram] Send failed:', await res.text());
      else         console.log('  [Telegram] Alert sent to', shortAddr(chatId));
    } catch (err) {
      console.error('  [Telegram] Error:', err.message);
    }
  }
}

// ── On-chain query ────────────────────────────────────────────────────────────

async function queryCollator(address, network) {
  const provider = new ethers.JsonRpcProvider(RPC[network]);
  const staking  = new ethers.Contract(PRECOMPILE, ABI, provider);

  const [roundData, isActive] = await Promise.all([
    staking.round(),
    staking.isSelectedCandidate(address),
  ]);

  const currentRound = Number(roundData.current);
  const firstBlock   = Number(roundData.first);
  const roundLength  = Number(roundData.length);

  // awardedPoints is only meaningful while active.
  // It starts at 0 at the beginning of each round and increments as blocks are produced.
  let points = null;
  if (isActive) {
    try {
      points = Number(await staking.awardedPoints(currentRound, address));
    } catch (_) {
      // Not fatal — some RPC nodes may not expose this in all conditions.
    }
  }

  return { currentRound, firstBlock, roundLength, isActive, points };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const envConfig = process.env.COLLATOR_CONFIG ? JSON.parse(process.env.COLLATOR_CONFIG) : null;
  const fileConfig = readJSON(join(ROOT, 'config.json'));
  const collators  = envConfig?.collators || fileConfig.collators || [];
  const threshold  = envConfig?.consecutiveInactiveChecksBeforeAlert ?? fileConfig.consecutiveInactiveChecksBeforeAlert ?? 2;
  
  const statusPath = join(ROOT, 'status.json');
  const prev       = existsSync(statusPath) ? readJSON(statusPath) : { collators: {} };
  const now        = new Date().toISOString();

  const next = { lastUpdated: now, collators: {} };

  for (const col of collators) {
    if (!col.address || col.address === '0xYOUR_COLLATOR_ADDRESS_HERE') {
      console.warn(`Skipping placeholder collator "${col.label}".`);
      continue;
    }

    const key   = `${col.network}:${shortAddr(col.address.toLowerCase())}`;
    const p     = prev.collators?.[key] ?? {};
    const label = col.label || shortAddr(col.address);

    console.log(`\nChecking ${label} (${col.network})…`);

    // ── Query chain ────────────────────────────────────────────────────────────
    let data;
    try {
      data = await queryCollator(col.address, col.network);
    } catch (err) {
      console.error(`  ✗ RPC error: ${err.message}`);
      next.collators[key] = {
        ...p,
        address:   shortAddr(col.address),
        network:   col.network,
        label:     col.label || '',
        statusText: 'error',
        lastError:  err.message,
        lastChecked: now,
      };
      continue;
    }

    const { currentRound, isActive, points } = data;

    // ── Consecutive inactive counter ──────────────────────────────────────────
    // Resets to 0 the moment the collator is active again.
    const consecutiveInactive = isActive ? 0 : (p.consecutiveInactive ?? 0) + 1;

    // ── Alert state ───────────────────────────────────────────────────────────
    // alertedInactive stays true until the collator recovers, so we don't spam.
    const wasAlertedInactive = p.alertedInactive ?? false;
    const triggerInactiveAlert = !isActive && consecutiveInactive >= threshold && !wasAlertedInactive;
    const triggerRecoveryAlert = isActive && wasAlertedInactive;

    // ── Derive display status ─────────────────────────────────────────────────
    // "warning" = in active set but 0 points so far this round (soft signal).
    let statusText;
    if (!isActive)          statusText = 'inactive';
    else if (points === 0)  statusText = 'warning';
    else                    statusText = 'active';

    // ── Send alerts ───────────────────────────────────────────────────────────
    if (triggerInactiveAlert) {
      await sendTelegram(
        `🚨 <b>Collator not in active set</b>\n\n` +
        `<b>${label}</b>\n<code>${col.address}</code>\n` +
        `Network: ${col.network} · Round: ${currentRound}\n` +
        `Seen inactive for ${consecutiveInactive} consecutive checks.`
      );
    }

    if (triggerRecoveryAlert) {
      await sendTelegram(
        `✅ <b>Collator back in active set</b>\n\n` +
        `<b>${label}</b>\n<code>${col.address}</code>\n` +
        `Network: ${col.network} · Round: ${currentRound}`
      );
    }

    // ── Log ───────────────────────────────────────────────────────────────────
    const pointsStr = points !== null ? points : '–';
    console.log(`  Round: ${currentRound} | Active: ${isActive} | Points this round: ${pointsStr}`);
    if (!isActive) console.log(`  Consecutive inactive checks: ${consecutiveInactive}/${threshold}`);

    // ── Persist ───────────────────────────────────────────────────────────────
    next.collators[key] = {
      address:    shortAddr(col.address),
      network:    col.network,
      label:      col.label || '',
      isActive,
      points,
      currentRound,
      consecutiveInactive,
      alertedInactive: !isActive && (triggerInactiveAlert || wasAlertedInactive),
      statusText,
      lastChecked: now,
      lastError:   null,
    };
  }

  writeJSON(statusPath, next);
  console.log('\nstatus.json updated.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
