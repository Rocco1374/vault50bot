try { require('dotenv').config(); } catch (_) {}

const http = require('http');
const url = require('url');
const crypto = require('crypto');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');

// Env
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const PUBLIC_URL = process.env.PUBLIC_URL;
const PORT       = Number(process.env.PORT || 10000);

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean).map(Number);

const ADDR = {
  BTC: process.env.ADDR_BTC || '',
  ETH: process.env.ADDR_ETH || '',
  BNB: process.env.ADDR_BNB || '',
  SOL: process.env.ADDR_SOL || ''
};

const RPC = {
  ETH: process.env.ETH_RPC || 'https://eth.llamarpc.com',
  BNB: process.env.BNB_RPC || 'https://bsc-dataseed.binance.org',
  SOL: process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com',
  BTC: process.env.BTC_MEMPOOL_API || 'https://mempool.space/api'
};

const CONF = {
  BTC: Number(process.env.CONFIRMS_BTC || 1),
  EVM: Number(process.env.CONFIRMS_EVM || 1),
  SOL: Number(process.env.CONFIRMS_SOL || 1)
};

const ENABLE_WATCHERS = String(process.env.ENABLE_WATCHERS || 'true').toLowerCase() === 'true';

const DEFAULT_PROOF = process.env.PROOF_MESSAGE || 'Latest Proof of Payout\n(Share latest TX link + winner here)\nVerified on-chain.';

// USD Round (mutable via commands)
let ENTRY_USD        = Number(process.env.ENTRY_USD || 50);
let ROUND_TARGET_USD = Number(process.env.ROUND_TARGET_USD || 2000);
let ENTRY_TOL        = Math.max(0, Math.min(0.5, Number(process.env.ENTRY_TOLERANCE_PCT || 0.10)));
let PAYOUT_PCT       = Math.max(0.10, Math.min(1.00, Number(process.env.PAYOUT_PCT || 1.00)));

const PROOF_AUTO = String(process.env.PROOF_AUTO || 'false').toLowerCase() === 'true';
const PROOF_REMINDER_MIN = Number(process.env.PROOF_REMINDER_MIN || 30);
const PRICE_SOURCE = process.env.PRICE_SOURCE || 'https://api.coingecko.com/api/v3/simple/price';

// Telegram (webhook)
if (!TG_TOKEN) { console.error('Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }

const bot = new TelegramBot(TG_TOKEN);
const webhookPath = `/telegram/${encodeURIComponent(TG_TOKEN)}`;
const fullWebhook = `${PUBLIC_URL}${webhookPath}`;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (req.method === 'GET' && parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('Vault50Bot OK');
  }
  if (req.method === 'POST' && parsed.pathname === webhookPath) {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        bot.processUpdate(update);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, async () => {
  console.log('Listening on', PORT);
  try {
    await bot.setWebHook(fullWebhook);
    console.log('Webhook set ->', fullWebhook);
  } catch (e) {
    console.log('Failed to set webhook:', e.message || e);
  }
  console.log(`Watchers: ${ENABLE_WATCHERS ? 'ON' : 'OFF (webhook-only). Use /pool to view totals.'}`);
});

// Helpers
function fmt(n, d = 8) {
  const out = Number(n).toFixed(d);
  return out.replace(/\.?0+$/, '');
}
async function postToChannel(text, extra = {}) {
  if (!CHAT_ID) return;
  try { await bot.sendMessage(CHAT_ID, text, { disable_web_page_preview: true, ...extra }); }
  catch (e) { console.error('Telegram send error:', e?.message); }
}
function isAdmin(id) { return ADMIN_IDS.includes(id); }

// Providers
const providerETH = new ethers.JsonRpcProvider(RPC.ETH);
const providerBNB = new ethers.JsonRpcProvider(RPC.BNB);
const solConn     = new Connection(RPC.SOL, 'confirmed');

// Prices
let priceCache = { ts: 0, data: { BTC: 0, ETH: 0, BNB: 0, SOL: 0 } };
async function refreshPrices() {
  try {
    const { data } = await axios.get(PRICE_SOURCE, {
      params: { ids: 'bitcoin,ethereum,binancecoin,solana', vs_currencies: 'usd' },
      timeout: 10000
    });
    priceCache = {
      ts: Date.now(),
      data: {
        BTC: data.bitcoin?.usd || 0,
        ETH: data.ethereum?.usd || 0,
        BNB: data.binancecoin?.usd || 0,
        SOL: data.solana?.usd || 0
      }
    };
  } catch (_) {}
}
async function getPrices() { if ((Date.now() - priceCache.ts) > 60000) await refreshPrices(); return priceCache.data; }
function toUSD(symbol, amount, px) { const p = px[symbol] || 0; return Number((amount * p).toFixed(2)); }
function ticketsForUSD(usd, entryUsd = ENTRY_USD, tol = ENTRY_TOL) {
  if (usd < entryUsd * (1 - tol)) return 0;
  const raw = usd / entryUsd;
  const nearest = Math.round(raw);
  const ok = Math.abs(usd - nearest * entryUsd) <= entryUsd * tol;
  if (ok) return Math.max(1, nearest);
  const flo = Math.floor(raw);
  if (flo >= 1) {
    const remainder = usd - flo * entryUsd;
    if (remainder <= entryUsd * tol) return flo;
  }
  return 0;
}

// Round state
const COINS = ['BTC', 'ETH', 'BNB', 'SOL'];
const rounds = COINS.reduce((acc, s) => (acc[s] = { id: 1, entries: [], startedAt: Date.now(), winner: null, proof: null }, acc), {});
const grand = { usdTotal: 0 };

function newRoundAll() {
  for (const s of COINS) {
    rounds[s] = { id: rounds[s].id + 1, entries: [], startedAt: Date.now(), winner: null, proof: null };
  }
  grand.usdTotal = 0;
}
function addEntry(symbol, entry) {
  rounds[symbol].entries.push(entry);
  grand.usdTotal += entry.usd;
}
function reachedUsdTarget() { return grand.usdTotal >= ROUND_TARGET_USD; }
function buildTicketBag() {
  const bag = [];
  for (const s of COINS) {
    for (const e of rounds[s].entries) {
      for (let i = 0; i < e.tickets; i++) bag.push({ symbol: s, ...e });
    }
  }
  return bag;
}

// Fairness seed sources
async function fetchChainSeeds() {
  try {
    const [btcHead, ethBlock, solSlot] = await Promise.all([
      axios.get(`${RPC.BTC}/blocks/tip/hash`, { timeout: 10000 }).then(r => String(r.data)).catch(() => ''),
      providerETH.getBlock('latest').then(b => String(b?.hash || '')).catch(() => ''),
      solConn.getSlot('finalized').then(n => String(n)).catch(() => '')
    ]);
    return { btcHead, ethHead: ethBlock, solSlot };
  } catch (_) { return { btcHead: '', ethHead: '', solSlot: '' }; }
}

// Draw and announce
async function runUsdDraw() {
  const seedParts = await fetchChainSeeds();
  const bag = buildTicketBag();
  if (!bag.length) return;

  const seedMaterial = JSON.stringify({
    seed: seedParts,
    txids: bag.map(b => b.txid),
    totalUsd: grand.usdTotal.toFixed(2)
  });
  const h = crypto.createHash('sha256').update(seedMaterial).digest('hex');
  const idx = parseInt(h.slice(0, 16), 16) % bag.length;
  const winner = bag[idx];
  const payoutUsd = grand.usdTotal * PAYOUT_PCT;

  await postToChannel(
    [
      'USD Round — Winner Selected',
      `Target: $${ROUND_TARGET_USD}`,
      `Total tickets: ${bag.length}`,
      `USD collected: $${grand.usdTotal.toFixed(2)}`,
      `Payout (USD basis): $${payoutUsd.toFixed(2)} (${Math.round(PAYOUT_PCT * 100)}%)`,
      '',
      `Winner address: ${winner.from}`,
      `Winning entry: ${winner.symbol} TX ${winner.txid}`,
      '',
      'Fairness Proof',
      `seed.btcHead: ${seedParts.btcHead}`,
      `seed.ethHead: ${seedParts.ethHead}`,
      `seed.solSlot: ${seedParts.solSlot}`,
      `seed.hash: ${h}`,
      `index: ${idx}/${bag.length - 1}`,
      '',
      'Send payout to the winner address above (same chain).',
      'After you send, submit: /proofpaid ' + winner.symbol + ' <tx> [amount]'
    ].join('\n')
  );

  global.__usd_round = { seedParts, bagLen: bag.length, hash: h, winner, startedAt: Date.now() };
}

// Manual proof + rotate
async function finalizeUsdProofManual(symbol, txid, paidAmount) {
  const amtLine = paidAmount ? `Paid: ${fmt(Number(paidAmount), 6)} ${symbol}\n` : '';
  await postToChannel(
    [
      'USD Round — Payout Confirmed (Manual)',
      `Chain: ${symbol}`,
      `${amtLine}TX: ${txid}`,
      '',
      'Round closed. New USD round is now open.'
    ].join('\n')
  );
  newRoundAll();
}

// Watchers
const seen = new Set();

async function pollBTC() {
  if (!ADDR.BTC) return;
  try {
    const [confirmed, mempool, addrInfo] = await Promise.all([
      axios.get(`${RPC.BTC}/address/${ADDR.BTC}/txs`, { timeout: 15000 }),
      axios.get(`${RPC.BTC}/address/${ADDR.BTC}/txs/mempool`, { timeout: 15000 }),
      axios.get(`${RPC.BTC}/address/${ADDR.BTC}`, { timeout: 15000 })
    ]);
    const items = [...(confirmed.data || []), ...(mempool.data || [])];
    const funded = (addrInfo.data?.chain_stats?.funded_txo_sum || 0);
    theSpent = (addrInfo.data?.chain_stats?.spent_txo_sum || 0);
    const totalBtc = (funded - theSpent) / 1e8;

    for (const tx of items.slice(0, 60)) {
      const txid = tx.txid;
      if (seen.has(txid)) continue;
      const outs = (tx.vout || []).filter(v => v.scriptpubkey_address === ADDR.BTC);
      if (!outs.length) continue;
      const isConfirmed = tx.status?.confirmed ? 1 : 0;
      if (isConfirmed < CONF.BTC) continue;

      const amtBtc = outs.reduce((a, v) => a + (v.value || 0), 0) / 1e8;
      seen.add(txid);

      const prices = await getPrices();
      const usd = toUSD('BTC', amtBtc, prices);
      const tickets = ticketsForUSD(usd);
      if (tickets > 0) {
        const from = (tx.vin?.[0]?.prevout?.scriptpubkey_address) || 'unknown';
        addEntry('BTC', { from, amount: amtBtc, usd, tickets, txid, ts: Date.now() });
        await postToChannel(
          [
            'Entry accepted (BTC)',
            `Amount: ${fmt(amtBtc)} BTC (~$${usd})`,
            `Tickets: ${tickets}`,
            `Progress: $${grand.usdTotal.toFixed(2)} / $${ROUND_TARGET_USD}`
          ].join('\n')
        );
      } else {
        await postToChannel(
          [
            'Deposit (BTC) did not match entry rule',
            `Required: $${ENTRY_USD} +/- ${Math.round(ENTRY_TOL * 100)}%`,
            `Amount: ${fmt(amtBtc)} BTC (~$${usd})`
          ].join('\n')
        );
      }

      if (reachedUsdTarget()) await runUsdDraw();
      else {
        await postToChannel(
          [
            'New Deposit',
            'Token: BTC',
            `Amount: ${fmt(amtBtc)} BTC`,
            `Total Wallet: ${fmt(totalBtc)} BTC`
          ].join('\n')
        );
      }
    }
  } catch (_) {}
}

function makeEvmWatcher(label, provider, toAddr, confirmsNeeded) {
  let lastBlock = 0;
  return async function tick() {
    if (!toAddr) return;
    try {
      const tip = await provider.getBlockNumber();
      if (!lastBlock) lastBlock = tip - 3;
      const from = Math.max(lastBlock + 1, tip - 6);
      for (let bn = from; bn <= tip - confirmsNeeded + 1; bn++) {
        const block = await provider.getBlock(bn, true);
        if (!block?.transactions) continue;
        for (const tx of block.transactions) {
          if (!tx.to) continue;
          if (tx.to.toLowerCase() !== toAddr.toLowerCase()) continue;
          const hash = tx.hash;
          if (seen.has(hash)) continue;

          const amount = Number(ethers.formatEther(tx.value));
          seen.add(hash);

          const prices = await getPrices();
          const usd = toUSD(label, amount, prices);
          const tickets = ticketsForUSD(usd);
          if (tickets > 0) {
            const fromAddr = tx.from || 'unknown';
            addEntry(label, { from: fromAddr, amount, usd, tickets, txid: hash, ts: Date.now() });
            await postToChannel(
              [
                `Entry accepted (${label})`,
                `Amount: ${fmt(amount, 6)} ${label} (~$${usd})`,
                `Tickets: ${tickets}`,
                `Progress: $${grand.usdTotal.toFixed(2)} / $${ROUND_TARGET_USD}`
              ].join('\n')
            );
          } else {
            await postToChannel(
              [
                `Deposit (${label}) did not match entry rule`,
                `Required: $${ENTRY_USD} +/- ${Math.round(ENTRY_TOL * 100)}%`,
                `Amount: ${fmt(amount, 6)} ${label} (~$${usd})`
              ].join('\n')
            );
          }

          if (reachedUsdTarget()) await runUsdDraw();
          else {
            const total = Number(ethers.formatEther(await provider.getBalance(toAddr)));
            await postToChannel(
              [
                'New Deposit',
                `Token: ${label}`,
                `Amount: ${fmt(amount, 6)} ${label}`,
                `Total Wallet: ${fmt(total, 6)} ${label}`
              ].join('\n')
            );
          }
        }
      }
      lastBlock = tip - confirmsNeeded + 1;
    } catch (_) {}
  };
}
const pollETH = makeEvmWatcher('ETH', providerETH, ADDR.ETH || '', CONF.EVM);
const pollBNB = makeEvmWatcher('BNB', providerBNB, ADDR.BNB || '', CONF.EVM);

let lastSolSig = null;
async function pollSOL() {
  if (!ADDR.SOL) return;
  try {
    const pub = new PublicKey(ADDR.SOL);
    const sigs = await solConn.getSignaturesForAddress(pub, lastSolSig ? { before: lastSolSig } : {}, 60);
    const list = sigs.slice().reverse();
    const totalLamports = await solConn.getBalance(pub, 'confirmed');
    const totalSOL = totalLamports / 1e9;

    for (const s of list) {
      if (seen.has(s.signature)) continue;
      const tx = await solConn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) continue;
      const ixs = tx.transaction?.message?.instructions || [];
      for (const ins of ixs) {
        const p = ins.parsed;
        if (p?.type === 'transfer' && p?.info?.destination === ADDR.SOL) {
          const lamports = Number(p.info.lamports || 0);
          const sol = lamports / 1e9;
          seen.add(s.signature);

          const prices = await getPrices();
          const usd = toUSD('SOL', sol, prices);
          const tickets = ticketsForUSD(usd);
          if (tickets > 0) {
            const fromAddr = p?.info?.source || 'unknown';
            addEntry('SOL', { from: fromAddr, amount: sol, usd, tickets, txid: s.signature, ts: Date.now() });
            await postToChannel(
              [
                'Entry accepted (SOL)',
                `Amount: ${fmt(sol, 6)} SOL (~$${usd})`,
                `Tickets: ${tickets}`,
                `Progress: $${grand.usdTotal.toFixed(2)} / $${ROUND_TARGET_USD}`
              ].join('\n')
            );
          } else {
            await postToChannel(
              [
                'Deposit (SOL) did not match entry rule',
                `Required: $${ENTRY_USD} +/- ${Math.round(ENTRY_TOL * 100)}%`,
                `Amount: ${fmt(sol, 6)} SOL (~$${usd})`
              ].join('\n')
            );
          }

          if (reachedUsdTarget()) await runUsdDraw();
          else {
            await postToChannel(
              [
                'New Deposit',
                'Token: SOL',
                `Amount: ${fmt(sol, 6)} SOL`,
                `Total Wallet: ${fmt(totalSOL, 6)} SOL`
              ].join('\n')
            );
          }
          break;
        }
      }
    }
    if (sigs.length) lastSolSig = sigs[0].signature;
  } catch (_) {}
}

// Start watchers
if (ENABLE_WATCHERS) {
  setInterval(pollBTC, 20000);
  setInterval(pollETH, 12000);
  setInterval(pollBNB, 12000);
  setInterval(pollSOL, 20000);
}

// Commands (public)
bot.onText(/^\/start(?:@\w+)?$/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      'Welcome to Vault50.',
      `Entry: $${ENTRY_USD.toFixed(2)} (+/- ${Math.round(ENTRY_TOL * 100)}%)`,
      `Target pot: $${ROUND_TARGET_USD.toFixed(2)}`,
      'Use /help for commands.'
    ].join('\n'),
    { disable_web_page_preview: true }
  );
});

bot.onText(/^\/help(?:@\w+)?$/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      'Commands:',
      '/pool - live pool totals',
      '/target - USD target and progress',
      '/proof - latest payout proof',
      '/stats - system stats',
      '/audit - official wallets',
      '/verify - how to verify on-chain'
    ].join('\n'),
    { disable_web_page_preview: true }
  );
});

bot.onText(/^\/pool(?:\s+update)?(?:@\w+)?$/i, async (msg) => {
  try {
    const btcInfo = await axios.get(`${RPC.BTC}/address/${ADDR.BTC}`, { timeout: 15000 }).then(r => r.data).catch(() => ({}));
    const funded = (btcInfo?.chain_stats?.funded_txo_sum || 0);
    const spent  = (btcInfo?.chain_stats?.spent_txo_sum || 0);
    const btcTotal = (funded - spent) / 1e8;

    const [ethWei, bnbWei, solLamports] = await Promise.all([
      ADDR.ETH ? providerETH.getBalance(ADDR.ETH) : 0n,
      ADDR.BNB ? providerBNB.getBalance(ADDR.BNB) : 0n,
      ADDR.SOL ? solConn.getBalance(new PublicKey(ADDR.SOL), 'confirmed') : 0
    ]);

    const ethTotal = Number(ethers.formatEther(ethWei || 0n));
    const bnbTotal = Number(ethers.formatEther(bnbWei || 0n));
    const solTotal = (solLamports || 0) / 1e9;

    bot.sendMessage(
      msg.chat.id,
      [
        'Pool Totals',
        `BTC: ${fmt(btcTotal)} BTC`,
        `ETH: ${fmt(ethTotal, 6)} ETH`,
        `BNB: ${fmt(bnbTotal, 6)} BNB`,
        `SOL: ${fmt(solTotal, 6)} SOL`,
        '',
        `USD Target: $${ROUND_TARGET_USD.toFixed(2)}`,
        `Progress this round: $${grand.usdTotal.toFixed(2)} (${Math.min(100, Math.round(100 * grand.usdTotal / ROUND_TARGET_USD))}%)`
      ].join('\n')
    );
  } catch {
    bot.sendMessage(msg.chat.id, 'Error fetching totals.');
  }
});

bot.onText(/^\/proof(?:@\w+)?$/i, (msg) => bot.sendMessage(msg.chat.id, DEFAULT_PROOF));
bot.onText(/^\/stats(?:@\w+)?$/i, (msg) => {
  const uptimeH = Math.floor(process.uptime() / 3600);
  bot.sendMessage(
    msg.chat.id,
    [
      'Stats',
      `Uptime: ${uptimeH}h`,
      `USD this round: $${grand.usdTotal.toFixed(2)}`,
      `Entry: $${ENTRY_USD.toFixed(2)} (+/- ${Math.round(ENTRY_TOL * 100)}%)`,
      `Payout: ${Math.round(PAYOUT_PCT * 100)}%`
    ].join('\n')
  );
});
bot.onText(/^\/audit(?:@\w+)?$/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      'Audit — Official Wallets',
      `BTC: ${ADDR.BTC}`,
      `ETH: ${ADDR.ETH}`,
      `BNB: ${ADDR.BNB}`,
      `SOL: ${ADDR.SOL}`
    ].join('\n')
  );
});
bot.onText(/^\/verify(?:@\w+)?$/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      'Verify:',
      '1) Match winner address with deposit transaction in the draw post.',
      '2) Open payout transaction; confirm from is pool wallet and to is winner.',
      '3) Fairness: SHA-256 over (seed parts + list of TXIDs + totalUsd). Index = hash % totalTickets.'
    ].join('\n')
  );
});
bot.onText(/^\/target(?:@\w+)?$/i, (msg) => {
  const pct = Math.min(100, Math.round(100 * grand.usdTotal / ROUND_TARGET_USD));
  bot.sendMessage(
    msg.chat.id,
    [
      `USD Target: $${ROUND_TARGET_USD.toFixed(2)}`,
      `Progress: $${grand.usdTotal.toFixed(2)} (${pct}%)`,
      `Entry: $${ENTRY_USD.toFixed(2)} (+/- ${Math.round(ENTRY_TOL * 100)}%)`
    ].join('\n')
  );
});

// Admin (DM only)
bot.onText(/^\/announce\s+(.+)/i, async (msg, m) => {
  if (!isAdmin(msg.from.id)) return;
  await postToChannel(`Announcement\n${m[1].trim()}`);
  bot.sendMessage(msg.chat.id, 'Announced.');
});

bot.onText(/^\/setentryusd\s+([0-9]+(?:\.[0-9]+)?)$/i, (msg, m) => {
  if (!isAdmin(msg.from.id)) return;
  ENTRY_USD = Math.max(1, Number(m[1]));
  bot.sendMessage(msg.chat.id, `Entry set to $${ENTRY_USD.toFixed(2)} (effective now).`);
});
bot.onText(/^\/settargetusd\s+([0-9]+(?:\.[0-9]+)?)$/i, (msg, m) => {
  if (!isAdmin(msg.from.id)) return;
  ROUND_TARGET_USD = Math.max(ENTRY_USD, Number(m[1]));
  bot.sendMessage(msg.chat.id, `USD round target set to $${ROUND_TARGET_USD.toFixed(2)} (effective now).`);
});
bot.onText(/^\/settol\s+(0(\.\d+)?|0?\.\d+|0\.50|0\.5)$/i, (msg, m) => {
  if (!isAdmin(msg.from.id)) return;
  const v = Number(m[1]);
  if (v < 0 || v > 0.5) return bot.sendMessage(msg.chat.id, 'Tolerance must be between 0.00 and 0.50');
  ENTRY_TOL = v;
  bot.sendMessage(msg.chat.id, `Entry tolerance set to ${(ENTRY_TOL * 100).toFixed(0)}% (effective now).`);
});
bot.onText(/^\/setpayout\s+(0\.\d+|1(\.0+)?)$/i, (msg, m) => {
  if (!isAdmin(msg.from.id)) return;
  PAYOUT_PCT = Math.max(0.10, Math.min(1.00, Number(m[1])));
  bot.sendMessage(msg.chat.id, `Payout set to ${Math.round(PAYOUT_PCT * 100)}% of pot (effective now).`);
});
bot.onText(/^\/restartround$/i, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  newRoundAll();
  bot.sendMessage(msg.chat.id, `New USD round opened. Progress reset to $0 / $${ROUND_TARGET_USD.toFixed(2)}.`);
});

// Manual proof submit
bot.onText(/^\/proofpaid\s+(BTC|ETH|BNB|SOL)\s+(\S+)(?:\s+([0-9]*\.?[0-9]+))?$/i, async (msg, m) => {
  if (!isAdmin(msg.from.id)) return;
  const symbol = m[1].toUpperCase();
  const txid = m[2];
  const amount = m[3] ? Number(m[3]) : null;
  await finalizeUsdProofManual(symbol, txid, amount);
  await bot.sendMessage(msg.chat.id, 'Proof posted and round rotated.');
});

// Welcome hook (if used in groups)
bot.on('new_chat_members', async (msg) => {
  for (const user of msg.new_chat_members) {
    await bot.sendMessage(msg.chat.id, 'Welcome to Vault50. Use /help for commands.');
  }
});

// Daily summary
async function postDailySummary() {
  try {
    const btcInfo = await axios.get(`${RPC.BTC}/address/${ADDR.BTC}`, { timeout: 15000 }).then(r => r.data).catch(() => ({}));
    const funded = (btcInfo?.chain_stats?.funded_txo_sum || 0);
    const spent  = (btcInfo?.chain_stats?.spent_txo_sum || 0);
    const btcTotal = (funded - spent) / 1e8;

    const [ethWei, bnbWei, solLamports] = await Promise.all([
      ADDR.ETH ? providerETH.getBalance(ADDR.ETH) : 0n,
      ADDR.BNB ? providerBNB.getBalance(ADDR.BNB) : 0n,
      ADDR.SOL ? solConn.getBalance(new PublicKey(ADDR.SOL), 'confirmed') : 0
    ]);

    const ethTotal = Number(ethers.formatEther(ethWei || 0n));
    const bnbTotal = Number(ethers.formatEther(bnbWei || 0n));
    const solTotal = (solLamports || 0) / 1e9;

    await postToChannel(
      [
        'Daily Summary',
        `BTC: ${fmt(btcTotal)} BTC`,
        `ETH: ${fmt(ethTotal, 6)} ETH`,
        `BNB: ${fmt(bnbTotal, 6)} BNB`,
        `SOL: ${fmt(solTotal, 6)} SOL`,
        '',
        `USD Round: $${grand.usdTotal.toFixed(2)} / $${ROUND_TARGET_USD.toFixed(2)} (Entry $${ENTRY_USD.toFixed(2)})`
      ].join('\n')
    );
  } catch (_) {}
}
setInterval(postDailySummary, 24 * 60 * 60 * 1000);

// Prime prices
refreshPrices().catch(() => {});
