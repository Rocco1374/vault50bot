// Vault50Bot — webhook-only (Render-safe), lean + reliable
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';

// --------- ENV ----------
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;               // REQUIRED
const NOTIFY_ID  = process.env.TELEGRAM_CHAT_ID;                 // channel/group/chat id
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/,''); // https://<yoursvc>.onrender.com (no trailing /)
const ADMIN_IDS  = (process.env.ADMIN_IDS || '')
  .split(',').map(s=>s.trim()).filter(Boolean).map(Number);

// Wallets (paste real ones in Render)
const ADDR = {
  BTC: process.env.ADDR_BTC || '',
  ETH: process.env.ADDR_ETH || '',
  BNB: process.env.ADDR_BNB || '',
  SOL: process.env.ADDR_SOL || ''
};

// Optional RPC & confirmations
const RPC = {
  ETH: process.env.ETH_RPC || 'https://eth.llamarpc.com',
  BNB: process.env.BNB_RPC || 'https://bsc-dataseed.binance.org',
  SOL: process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com',
  BTC_API: process.env.BTC_MEMPOOL_API || 'https://mempool.space/api'
};
const CONF = {
  BTC: Number(process.env.CONFIRMS_BTC || 1),
  EVM: Number(process.env.CONFIRMS_EVM || 1),
  SOL: Number(process.env.CONFIRMS_SOL || 1)
};
const PROOF_MESSAGE = process.env.PROOF_MESSAGE ||
  '🧾 Latest Proof of Payout\n(Share latest TX link + winner here)\n✅ Verified on-chain.';

// --------- GUARDS ----------
if (!TG_TOKEN) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN env.');
  process.exit(1);
}

// --------- BOT (no polling!) ----------
const bot = new TelegramBot(TG_TOKEN, { webHook: true });

// HTTP server for webhook + health
const app = express();
app.use(express.json());

// Health for Render
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Webhook handler: use token in path for simple secret
const hookPath = `/telegram/${encodeURIComponent(TG_TOKEN)}`;
app.post(hookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Start HTTP
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`Listening on ${PORT}`);

  // Auto set webhook if PUBLIC_URL provided
  try {
    if (!PUBLIC_URL) {
      console.warn(
        '⚠️ PUBLIC_URL not set. Set it to your Render URL to auto-configure webhook.\n' +
        'You can also set the webhook manually with BotFather or the HTTP API.'
      );
    } else {
      const url = `${PUBLIC_URL}${hookPath}`;
      await bot.setWebHook(url, { max_connections: 40 });
      console.log(`Webhook set → ${url}`);
    }
  } catch (e) {
    console.error('Failed to set webhook:', e?.message || e);
  }
});

// --------- Helpers ----------
async function postToChannel(text) {
  if (!NOTIFY_ID) return;
  try { await bot.sendMessage(NOTIFY_ID, text, { disable_web_page_preview: true }); }
  catch (e) { console.error('Telegram send error:', e?.message || e); }
}
const fmt = (n, d=8)=> String(Number(n).toFixed(d)).replace(/\.?0+$/,'');
const msgDeposit = (sym, amt, tot) => `💸 New Deposit\nToken: ${sym}\nAmount: ${amt}\nTotal Wallet: ${tot}`;

// Totals (used by /pool)
const providerETH = new ethers.JsonRpcProvider(RPC.ETH);
const providerBNB = new ethers.JsonRpcProvider(RPC.BNB);
const solConn     = new Connection(RPC.SOL, 'confirmed');

async function btcTotals(addr) {
  const { data } = await axios.get(`${RPC.BTC_API}/address/${addr}`, { timeout: 15000 });
  const cs = data.chain_stats || { funded_txo_sum:0, spent_txo_sum:0 };
  const ms = data.mempool_stats || { funded_txo_sum:0, spent_txo_sum:0 };
  const confirmed = (cs.funded_txo_sum - cs.spent_txo_sum) / 1e8;
  const pending   = (ms.funded_txo_sum - ms.spent_txo_sum) / 1e8;
  return { confirmed, total: confirmed + pending };
}
async function evmTotal(provider, addr) {
  if (!addr) return 0;
  const wei = await provider.getBalance(addr);
  return Number(ethers.formatEther(wei));
}
async function solTotal(addr) {
  if (!addr) return 0;
  const lamports = await solConn.getBalance(new PublicKey(addr), 'confirmed');
  return lamports / 1e9;
}

// --------- Commands ----------
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🤖 Vault50Bot online.\nUse /help for commands.');
});

bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
  const t = `🧭 Vault50Bot Commands
/pool — show totals
/proof — payout proof
/stats — system stats
/announce <text> — admin only`;
  await bot.sendMessage(msg.chat.id, t);
});

bot.onText(/^\/pool(?:@\w+)?$/, async (msg) => {
  try {
    const [btc, eth, bnb, sol] = await Promise.all([
      ADDR.BTC ? btcTotals(ADDR.BTC) : { confirmed: 0, total: 0 },
      evmTotal(providerETH, ADDR.ETH),
      evmTotal(providerBNB, ADDR.BNB),
      solTotal(ADDR.SOL)
    ]);
    const t = `📊 Pool Totals
BTC: ${fmt(btc.total)} BTC
ETH: ${fmt(eth,6)} ETH
BNB: ${fmt(bnb,6)} BNB
SOL: ${fmt(sol,6)} SOL`;
    await bot.sendMessage(msg.chat.id, t);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, '⚠️ Error fetching totals.');
    console.error('pool error:', e?.message || e);
  }
});

bot.onText(/^\/proof(?:@\w+)?$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, PROOF_MESSAGE);
});

bot.onText(/^\/stats(?:@\w+)?$/, async (msg) => {
  const upMin = Math.floor(process.uptime()/60);
  const t = `📈 Vault50 Stats
Uptime: ${upMin} min
Mode: Webhook`;
  await bot.sendMessage(msg.chat.id, t);
});

// simple announce (channel broadcast)
bot.onText(/^\/announce (.+)/, async (msg, m) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  await postToChannel(`📢 ${m[1]}`);
});

// welcome in groups (optional)
bot.on('new_chat_members', async (msg) => {
  for (const u of msg.new_chat_members || []) {
    await bot.sendMessage(msg.chat.id, `👋 Welcome ${u.first_name || 'there'} to Vault50! Type /help.`);
  }
});

console.log('Watchers: OFF (webhook-only). Use /pool to view totals.');
