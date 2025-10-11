// deposit-bot.js — Vault50Bot (Telegram-only, enhanced)
try { require('dotenv').config(); } catch (_) {}

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NOTIFY_CHAT = process.env.TELEGRAM_CHAT_ID;

const ADDR = {
  BTC: process.env.ADDR_BTC,
  ETH: process.env.ADDR_ETH,
  BNB: process.env.ADDR_BNB,
  SOL: process.env.ADDR_SOL,
};

const RPC = {
  ETH: process.env.ETH_RPC || 'https://eth.llamarpc.com',
  BNB: process.env.BNB_RPC || 'https://bsc-dataseed.binance.org',
  SOL: process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com',
  BTC_API: process.env.BTC_MEMPOOL_API || 'https://mempool.space/api',
};

const CONF = {
  BTC: Number(process.env.CONFIRMS_BTC || 1),
  EVM: Number(process.env.CONFIRMS_EVM || 1),
  SOL: Number(process.env.CONFIRMS_SOL || 1),
};

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s));
const DEFAULT_PROOF = process.env.PROOF_MESSAGE || '🧾 Latest Proof of Payout\n(Share latest TX link + winner here)\n✅ Verified on-chain.';

if (!TG_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new TelegramBot(TG_TOKEN, { polling: true });

async function postToChannel(text) {
  if (!NOTIFY_CHAT) return;
  try { await bot.sendMessage(NOTIFY_CHAT, text, { disable_web_page_preview: true }); }
  catch (e) { console.error('Telegram send error:', e?.message); }
}

const providerETH = new ethers.JsonRpcProvider(RPC.ETH);
const providerBNB = new ethers.JsonRpcProvider(RPC.BNB);
const solConn = new Connection(RPC.SOL, 'confirmed');

const seen = new Set();
let txCount = 0;
const launchedAt = Date.now();

function fmt(n, decimals = 8) {
  const s = Number(n).toFixed(decimals);
  return s.replace(/\.?0+$/, '');
}
function msgDeposit(token, amount, total) {
  return `💸 New Deposit\nToken: ${token}\nAmount: ${amount}\nTotal Wallet: ${total}`;
}

async function getBtcTotals(addr, base) {
  const { data } = await axios.get(`${base}/address/${addr}`, { timeout: 15000 });
  const cs = data.chain_stats || { funded_txo_sum: 0, spent_txo_sum: 0 };
  const ms = data.mempool_stats || { funded_txo_sum: 0, spent_txo_sum: 0 };
  const confirmed = (cs.funded_txo_sum - cs.spent_txo_sum) / 1e8;
  const pending = (ms.funded_txo_sum - ms.spent_txo_sum) / 1e8;
  return { confirmed, total: confirmed + pending };
}
async function getEvmTotal(provider, address) {
  const wei = await provider.getBalance(address);
  return Number(ethers.formatEther(wei));
}
async function getSolTotal(conn, address) {
  const lamports = await conn.getBalance(new PublicKey(address), 'confirmed');
  return lamports / 1e9;
}

// === Watchers ===
async function pollBTC() {
  const addr = ADDR.BTC;
  if (!addr) return;
  try {
    const [confirmed, mempool, addrInfo] = await Promise.all([
      axios.get(`${RPC.BTC_API}/address/${addr}/txs`, { timeout: 15000 }),
      axios.get(`${RPC.BTC_API}/address/${addr}/txs/mempool`, { timeout: 15000 }),
      axios.get(`${RPC.BTC_API}/address/${addr}`, { timeout: 15000 }),
    ]);
    const items = [...(confirmed.data || []), ...(mempool.data || [])];
    const funded = (addrInfo.data?.chain_stats?.funded_txo_sum || 0);
    const spent = (addrInfo.data?.chain_stats?.spent_txo_sum || 0);
    const totalBtc = (funded - spent) / 1e8;

    for (const tx of items.slice(0, 50)) {
      const txid = tx.txid;
      if (seen.has(txid)) continue;
      const outs = (tx.vout || []).filter(v => v.scriptpubkey_address === addr);
      if (!outs.length) continue;
      const conf = tx.status?.confirmed ? 1 : 0;
      if (conf < CONF.BTC) continue;
      const amtBtc = outs.reduce((a, v) => a + (v.value || 0), 0) / 1e8;
      seen.add(txid); txCount++;
      await postToChannel(msgDeposit('BTC', `${fmt(amtBtc)} BTC`, `${fmt(totalBtc)} BTC`));
    }
  } catch (_) {}
}

function makeEvmWatcher(label, provider, toAddr, confirmsNeeded) {
  let lastBlock = 0;
  return async function tick() {
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
          const total = Number(ethers.formatEther(await provider.getBalance(toAddr)));
          seen.add(hash); txCount++;
          await postToChannel(msgDeposit(label, `${fmt(amount, 6)} ${label}`, `${fmt(total, 6)} ${label}`));
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
  const addr = ADDR.SOL;
  if (!addr) return;
  try {
    const pub = new PublicKey(addr);
    const sigs = await solConn.getSignaturesForAddress(pub, lastSolSig ? { before: lastSolSig } : {}, 50);
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
        if (p?.type === 'transfer' && p?.info?.destination === addr) {
          const lamports = Number(p.info.lamports || 0);
          const sol = lamports / 1e9;
          seen.add(s.signature); txCount++;
          await postToChannel(msgDeposit('SOL', `${fmt(sol, 6)} SOL`, `${fmt(totalSOL, 6)} SOL`));
          break;
        }
      }
    }
    if (sigs.length) lastSolSig = sigs[0].signature;
  } catch (_) {}
}

// === Commands ===
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🤖 Vault50Bot online.\nUse /help for all commands.', { disable_web_page_preview: true });
});
bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
  const text = `🧭 Vault50Bot Commands
/pool — show totals
/pool update — refresh
/poolupdate — same
/proof — payout proof
/stats — system stats
/announce <text> — admin only`;
  await bot.sendMessage(msg.chat.id, text);
});
bot.onText(/^\/pool(?:\s+update)?(?:@\w+)?$/, async (msg) => {
  try {
    const [btc, eth, bnb, sol] = await Promise.all([
      ADDR.BTC ? getBtcTotals(ADDR.BTC, RPC.BTC_API) : { confirmed: 0, total: 0 },
      ADDR.ETH ? getEvmTotal(providerETH, ADDR.ETH) : 0,
      ADDR.BNB ? getEvmTotal(providerBNB, ADDR.BNB) : 0,
      ADDR.SOL ? getSolTotal(solConn, ADDR.SOL) : 0,
    ]);
    const text = `📊 Pool Totals
BTC: ${fmt(btc.total)} BTC
ETH: ${fmt(eth, 6)} ETH
BNB: ${fmt(bnb, 6)} BNB
SOL: ${fmt(sol, 6)} SOL`;
    await bot.sendMessage(msg.chat.id, text);
  } catch { await bot.sendMessage(msg.chat.id, '⚠️ Error fetching totals.'); }
});
bot.onText(/^\/poolupdate(?:@\w+)?$/, async (msg) => { bot.emit('text', { ...msg, text: '/pool update' }); });
bot.onText(/^\/proof(?:@\w+)?$/, async (msg) => { await bot.sendMessage(msg.chat.id, DEFAULT_PROOF); });
bot.onText(/^\/stats(?:@\w+)?$/, async (msg) => {
  const uptime = Math.floor(process.uptime() / 3600);
  const text = `📈 Vault50 Stats
Transactions: ${txCount}
Uptime: ${uptime}h
Running since: ${new Date(launchedAt).toLocaleString()}`;
  await bot.sendMessage(msg.chat.id, text);
});
bot.onText(/^\/announce (.+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const text = match[1].trim();
  await postToChannel(`📢 Announcement\n${text}`);
});
bot.on('new_chat_members', async (msg) => {
  for (const user of msg.new_chat_members) {
    await bot.sendMessage(msg.chat.id, `👋 Welcome ${user.first_name || 'there'} to Vault50 Lounge!\nType /help for commands.`);
  }
});

// === Daily summary ===
async function postDailySummary() {
  try {
    const [btc, eth, bnb, sol] = await Promise.all([
      getBtcTotals(ADDR.BTC, RPC.BTC_API),
      getEvmTotal(providerETH, ADDR.ETH),
      getEvmTotal(providerBNB, ADDR.BNB),
      getSolTotal(solConn, ADDR.SOL),
    ]);
    const text = `📅 Daily Summary
BTC: ${fmt(btc.total)} BTC
ETH: ${fmt(eth, 6)} ETH
BNB: ${fmt(bnb, 6)} BNB
SOL: ${fmt(sol, 6)} SOL`;
    await postToChannel(text);
  } catch (_) {}
}
setInterval(postDailySummary, 24 * 60 * 60 * 1000);

// === Pollers ===
setInterval(pollBTC, 20000);
setInterval(pollETH, 12000);
setInterval(pollBNB, 12000);
setInterval(pollSOL, 20000);
console.log('Telegram deposit notifier running…');
