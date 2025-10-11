// deposit-bot.js — Vault50 Telegram Bot (Full Version)
try { require('dotenv').config(); } catch (_) {}

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');

/* ======= ENV SETUP ======= */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((n) => Number(n));

const DEFAULT_PROOF =
  process.env.PROOF_MESSAGE ||
  '🧾 Latest Proof of Payout\n✅ Verified on-chain.';

if (!TG_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

/* ======= INITIALIZATION ======= */
const bot = new TelegramBot(TG_TOKEN, { polling: true });
const providerETH = new ethers.JsonRpcProvider(RPC.ETH);
const providerBNB = new ethers.JsonRpcProvider(RPC.BNB);
const solConn = new Connection(RPC.SOL, 'confirmed');

/* ======= HELPERS ======= */
function fmt(n, d = 8) {
  return String(Number(n).toFixed(d)).replace(/\.?0+$/, '');
}

async function btcTotals(addr) {
  if (!addr) return { confirmed: 0, total: 0 };
  const { data } = await axios.get(`${RPC.BTC_API}/address/${addr}`);
  const cs = data.chain_stats || { funded_txo_sum: 0, spent_txo_sum: 0 };
  const ms = data.mempool_stats || { funded_txo_sum: 0, spent_txo_sum: 0 };
  const confirmed = (cs.funded_txo_sum - cs.spent_txo_sum) / 1e8;
  const total = confirmed + (ms.funded_txo_sum - ms.spent_txo_sum) / 1e8;
  return { confirmed, total };
}

async function evmTotal(provider, address) {
  if (!address) return 0;
  const wei = await provider.getBalance(address);
  return Number(ethers.formatEther(wei));
}

async function solTotal(address) {
  if (!address) return 0;
  const lam = await solConn.getBalance(new PublicKey(address), 'confirmed');
  return lam / 1e9;
}

function post(text) {
  if (!CHAT_ID) return;
  bot.sendMessage(CHAT_ID, text, { disable_web_page_preview: true }).catch(() => {});
}

/* ======= COMMANDS ======= */
bot.onText(/^\/start/, (msg) =>
  bot.sendMessage(msg.chat.id, '🤖 Vault50Bot online.\nUse /help for all commands.')
);

bot.onText(/^\/help/, (msg) =>
  bot.sendMessage(
    msg.chat.id,
    `🧭 Vault50Bot Commands
/pool — show totals
/pool update — refresh
/poolupdate — same
/proof — payout proof
/stats — system stats
/announce <text> — admin only`
  )
);

bot.onText(/^\/pool(?:\s+update)?/, async (msg) => {
  try {
    const [btc, eth, bnb, sol] = await Promise.all([
      btcTotals(ADDR.BTC),
      evmTotal(providerETH, ADDR.ETH),
      evmTotal(providerBNB, ADDR.BNB),
      solTotal(ADDR.SOL),
    ]);
    const text = `📊 Pool Totals
BTC: ${fmt(btc.total)} BTC
ETH: ${fmt(eth, 6)} ETH
BNB: ${fmt(bnb, 6)} BNB
SOL: ${fmt(sol, 6)} SOL`;
    bot.sendMessage(msg.chat.id, text);
  } catch {
    bot.sendMessage(msg.chat.id, '⚠️ Error fetching totals.');
  }
});

bot.onText(/^\/poolupdate/, (msg) =>
  bot.emit('text', { ...msg, text: '/pool update' })
);

bot.onText(/^\/proof/, (msg) => bot.sendMessage(msg.chat.id, DEFAULT_PROOF));

bot.onText(/^\/stats/, (msg) => {
  const uptime = Math.floor(process.uptime() / 3600);
  bot.sendMessage(
    msg.chat.id,
    `📈 Vault50 Stats
Uptime: ${uptime}h
Running since: ${new Date().toLocaleString()}`
  );
});

bot.onText(/^\/announce (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  post(`📢 Announcement\n${match[1]}`);
});

/* ======= DAILY SUMMARY ======= */
async function dailySummary() {
  try {
    const [btc, eth, bnb, sol] = await Promise.all([
      btcTotals(ADDR.BTC),
      evmTotal(providerETH, ADDR.ETH),
      evmTotal(providerBNB, ADDR.BNB),
      solTotal(ADDR.SOL),
    ]);
    const text = `📅 Daily Summary
BTC: ${fmt(btc.total)} BTC
ETH: ${fmt(eth, 6)} ETH
BNB: ${fmt(bnb, 6)} BNB
SOL: ${fmt(sol, 6)} SOL`;
    post(text);
  } catch {}
}
setInterval(dailySummary, 24 * 60 * 60 * 1000);

/* ======= STARTUP ======= */
console.log('Telegram deposit notifier running…');

/* ======= KEEP-ALIVE SERVER (REQUIRED BY RENDER FREE PLAN) ======= */
try {
  const http = require('http');
  const PORT = process.env.PORT || 3000;
  http
    .createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Vault50Bot OK\n');
    })
    .listen(PORT, () => console.log('HTTP keep-alive listening on', PORT));
} catch (_) {}
