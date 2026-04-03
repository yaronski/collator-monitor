/**
 * Collator active-set checker
 *
 * Reads config.json, queries the Moonbeam/Moonriver staking precompile for each
 * configured collator, detects active-set transitions, sends Telegram alerts,
 * and writes the result back to status.json.
 *
 * Called by GitHub Actions every hour.
 */

import { ethers } from 'ethers';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');

const RPC = {
  moonbeam: [
    'https://rpc.api.moonbeam.network',
    'https://moonbeam.public.blastapi.io',
    'https://moonbeam-rpc.publicnode.com',
  ],
  moonriver: [
    'https://rpc.api.moonriver.moonbeam.network',
    'https://moonriver.public.blastapi.io',
    'https://moonriver-rpc.publicnode.com',
  ],
};

const PRECOMPILE = '0x0000000000000000000000000000000000000800';

const STAKING_ABI = [
  'function round() view returns (uint256)',
  'function isSelectedCandidate(address) view returns (bool)',
  'function awardedPoints(uint32, address) view returns (uint32)',
  'function selectedCandidates() view returns (address[])',
  'function getCandidateTotalCounted(address) view returns (uint256)',
];

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJSON = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

function shortAddr(addr) {
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function formatCompact(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'm';
  if (num >= 1_000) return (num / 1_000).toFixed(2) + 'k';
  return num.toFixed(2);
}

function formatStake(weiBigInt) {
  return formatCompact(Number(ethers.formatEther(weiBigInt)));
}

function formatUsd(usd) {
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(1) + 'm';
  if (usd >= 1_000) return '$' + (usd / 1_000).toFixed(1) + 'k';
  return '$' + usd.toFixed(0);
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = process.env.TELEGRAM_CHAT_ID?.split(',').map(s => s.trim()).filter(Boolean);
  if (!token || !chatIds?.length) {
    console.log('  [Telegram] No credentials set — skipping notification.');
    return;
  }
  for (const chatId of chatIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      });
      if (!res.ok) console.error('  [Telegram] Send failed:', await res.text());
      else console.log('  [Telegram] Alert sent to', shortAddr(chatId));
    } catch (err) {
      console.error('  [Telegram] Error:', err.message);
    }
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function fetchCollatorNames(network, addresses) {
  const base = network === 'moonbeam'
    ? 'https://moonbeam.moonscan.io/address/'
    : 'https://moonriver.moonscan.io/address/';

  const names = {};
  for (const addr of addresses) {
    try {
      const res = await fetch(base + addr, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const match = html.match(/Public Name Tag[^]*?<span[^>]*>([^<]+)<\/span>/);
      if (match && match[1].trim()) {
        names[addr] = match[1].trim();
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  const count = Object.keys(names).length;
  console.log(`  ✓ Moonscan names: ${count}/${addresses.length} for ${network}`);
  return names;
}

async function fetchPrices() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=moonbeam,moonriver&vs_currencies=usd');
    if (!res.ok) return null;
    const data = await res.json();
    return {
      moonbeam: data.moonbeam?.usd ?? null,
      moonriver: data.moonriver?.usd ?? null,
    };
  } catch (err) {
    console.log(`  ✗ Price fetch failed: ${err.message}`);
    return null;
  }
}

async function queryCollator(address, network) {
  const rpcUrls = RPC[network];
  if (!rpcUrls) throw new Error(`Unknown network: ${network}`);

  let lastError;
  for (const rpcUrl of rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const contract = new ethers.Contract(PRECOMPILE, STAKING_ABI, provider);

      const [roundResult, isActive] = await withTimeout(
        Promise.all([contract.round(), contract.isSelectedCandidate(address)]),
        20000
      );

      const currentRound = Number(roundResult);

      let points = null;
      if (isActive) {
        try {
          points = Number(await withTimeout(contract.awardedPoints(currentRound, address), 10000));
        } catch (_) {}
      }

      console.log(`  ✓ RPC: ${rpcUrl}`);
      return { currentRound, isActive, points };
    } catch (err) {
      lastError = err;
      console.log(`  ✗ RPC failed (${rpcUrl}): ${err.message}`);
    }
  }

  throw lastError;
}

async function fetchRanking(network) {
  const rpcUrls = RPC[network];
  if (!rpcUrls) return null;

  for (const rpcUrl of rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const contract = new ethers.Contract(PRECOMPILE, STAKING_ABI, provider);

      console.log(`  Fetching ranking for ${network}…`);
      const candidates = await withTimeout(contract.selectedCandidates(), 20000);

      const stakePromises = candidates.map(addr =>
        contract.getCandidateTotalCounted(addr)
          .then(stake => ({ address: addr.toLowerCase(), stake }))
          .catch(() => ({ address: addr.toLowerCase(), stake: 0n }))
      );

      const results = await withTimeout(Promise.all(stakePromises), 45000);

      results.sort((a, b) => {
        if (b.stake > a.stake) return 1;
        if (b.stake < a.stake) return -1;
        return 0;
      });

      const ranked = results.map((r, i) => ({
        rank: i + 1,
        address: r.address,
        stake: r.stake.toString(),
        stakeFormatted: formatStake(r.stake),
      }));

      console.log(`  ✓ Ranking fetched: ${ranked.length} candidates from ${rpcUrl}`);
      return ranked;
    } catch (err) {
      console.log(`  ✗ Ranking failed (${rpcUrl}): ${err.message}`);
    }
  }

  console.log(`  ✗ Could not fetch ranking for ${network}`);
  return null;
}

function getNeighbors(ranking, myAddress, count, tokenPrice, names) {
  if (!ranking || !ranking.length) return null;

  const addr = myAddress.toLowerCase();
  const myIndex = ranking.findIndex(r => r.address === addr);

  if (myIndex === -1) {
    const lastInSet = ranking[ranking.length - 1];
    return {
      rank: null,
      totalSelected: ranking.length,
      myStake: null,
      myStakeFormatted: null,
      neighbors: null,
      threshold: lastInSet ? {
        rank: lastInSet.rank,
        address: lastInSet.address,
        name: shortAddr(lastInSet.address),
        stakeFormatted: lastInSet.stakeFormatted,
      } : null,
    };
  }

  const me = ranking[myIndex];
  const myStakeNum = Number(ethers.formatEther(BigInt(me.stake)));
  const start = Math.max(0, myIndex - count);
  const end = Math.min(ranking.length, myIndex + count + 1);
  const slice = ranking.slice(start, end);

  const neighbors = slice.map(r => {
    const gapWei = BigInt(me.stake) - BigInt(r.stake);
    const absGapWei = gapWei < 0n ? -gapWei : gapWei;
    const gapNum = Number(ethers.formatEther(absGapWei));
    const sign = gapWei > 0n ? '-' : '+';
    const rStakeNum = Number(ethers.formatEther(BigInt(r.stake)));
    const pctDiff = rStakeNum > 0 ? ((rStakeNum - myStakeNum) / myStakeNum) * 100 : 0;

    const name = names[r.address] || shortAddr(r.address);

    const result = {
      rank: r.rank,
      address: r.address,
      name,
      stakeFormatted: r.stakeFormatted,
      gap: sign + formatCompact(gapNum),
      gapPercent: (pctDiff >= 0 ? '+' : '') + pctDiff.toFixed(1) + '%',
      isSelf: r.address === addr,
    };

    if (tokenPrice && !result.isSelf) {
      const gapUsd = gapNum * tokenPrice;
      result.gapUsd = sign + formatUsd(gapUsd);
    }

    return result;
  });

  return {
    rank: me.rank,
    totalSelected: ranking.length,
    myStake: me.stakeFormatted,
    myStakeNum,
    neighbors,
    threshold: buildThreshold(ranking, myStakeNum, tokenPrice, names),
  };
}

function buildThreshold(ranking, myStakeNum, tokenPrice, names) {
  const last = ranking[ranking.length - 1];
  if (!last) return null;
  const lastStakeNum = Number(ethers.formatEther(BigInt(last.stake)));
  const marginNum = myStakeNum - lastStakeNum;
  const absMarginNum = Math.abs(marginNum);
  const sign = marginNum >= 0 ? '+' : '-';
  const lastName = names[last.address] || shortAddr(last.address);
  const t = {
    rank: last.rank,
    address: last.address,
    name: lastName,
    stakeFormatted: last.stakeFormatted,
    margin: sign + formatCompact(absMarginNum),
    marginPercent: (marginNum >= 0 ? '+' : '') + ((marginNum / myStakeNum) * 100).toFixed(1) + '%',
  };
  if (tokenPrice) {
    t.marginUsd = sign + formatUsd(absMarginNum * tokenPrice);
  }
  return t;
}

async function main() {
  const envConfig = process.env.COLLATOR_CONFIG ? JSON.parse(process.env.COLLATOR_CONFIG) : null;
  const fileConfig = readJSON(join(ROOT, 'config.json'));
  const collators = envConfig?.collators || fileConfig.collators || [];
  const threshold = envConfig?.consecutiveInactiveChecksBeforeAlert ?? fileConfig.consecutiveInactiveChecksBeforeAlert ?? 2;

  const statusPath = join(ROOT, 'status.json');
  const prev = existsSync(statusPath) ? readJSON(statusPath) : { collators: {} };
  const now = new Date().toISOString();

  const next = { lastUpdated: now, collators: {} };

  const networks = [...new Set(collators.map(c => c.network))];

  console.log('\nFetching prices…');
  const prices = await fetchPrices();
  if (prices) {
    console.log(`  GLMR: $${prices.moonbeam} | MOVR: $${prices.moonriver}`);
  }
  if (prices) next.prices = prices;

  const rankings = {};
  const allRankingAddrs = {};
  for (const net of networks) {
    rankings[net] = await fetchRanking(net);
    if (rankings[net]) {
      allRankingAddrs[net] = rankings[net].map(r => r.address);
    }
  }

  console.log('\nFetching collator names from Moonscan…');
  const allNames = {};
  for (const net of networks) {
    const addrs = allRankingAddrs[net] || [];
    if (addrs.length) {
      allNames[net] = await fetchCollatorNames(net, addrs);
    }
  }

  next.rankings = {};
  for (const net of networks) {
    if (rankings[net]) {
      next.rankings[net] = rankings[net].map(r => ({
        rank: r.rank,
        address: r.address,
        name: allNames[net]?.[r.address] || null,
        stakeFormatted: r.stakeFormatted,
        stakeEther: Math.round(Number(ethers.formatEther(BigInt(r.stake))) * 10000) / 10000,
      }));
    }
  }

  for (const col of collators) {
    if (!col.address || col.address === '0xYOUR_COLLATOR_ADDRESS_HERE') {
      console.warn(`Skipping placeholder collator "${col.label}".`);
      continue;
    }

    const addr = col.address.toLowerCase();
    const key = `${col.network}:${shortAddr(addr)}`;
    const p = prev.collators?.[key] ?? {};
    const moonscanName = allNames[col.network]?.[addr];
    const label = col.label || moonscanName || shortAddr(addr);

    console.log(`\nChecking ${label} (${col.network})…`);

    let data;
    try {
      data = await queryCollator(col.address, col.network);
    } catch (err) {
      console.error(`  ✗ RPC error: ${err.message}`);
      next.collators[key] = {
        ...p,
        address: addr,
        network: col.network,
        label,
        statusText: 'error',
        lastError: err.message,
        lastChecked: now,
        ranking: getNeighbors(rankings[col.network], col.address, 2, prices?.[col.network], allNames[col.network] || {}),
      };
      continue;
    }

    const { currentRound, isActive, points } = data;

    const consecutiveInactive = isActive ? 0 : (p.consecutiveInactive ?? 0) + 1;

    const wasAlertedInactive = p.alertedInactive ?? false;
    const triggerInactiveAlert = !isActive && consecutiveInactive >= threshold && !wasAlertedInactive;
    const triggerRecoveryAlert = isActive && wasAlertedInactive;

    let statusText;
    if (!isActive) statusText = 'inactive';
    else statusText = 'active';

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

    const pointsStr = points !== null ? points : '–';
    console.log(`  Round: ${currentRound} | Active: ${isActive} | Points this round: ${pointsStr}`);
    if (!isActive) console.log(`  Consecutive inactive checks: ${consecutiveInactive}/${threshold}`);

    const ranking = getNeighbors(rankings[col.network], col.address, 2, prices?.[col.network], allNames[col.network] || {});
    if (ranking?.rank) {
      console.log(`  Rank: ${ranking.rank}/${ranking.totalSelected} | Stake: ${ranking.myStake}`);
    }

    next.collators[key] = {
      address: addr,
      network: col.network,
      label,
      isActive,
      points,
      currentRound,
      consecutiveInactive,
      alertedInactive: !isActive && (triggerInactiveAlert || wasAlertedInactive),
      statusText,
      lastChecked: now,
      lastError: null,
      ranking,
    };
  }

  writeJSON(statusPath, next);
  console.log('\nstatus.json updated.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
