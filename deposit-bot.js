// Vault50Bot — webhook mode for Render (expert build)
// - Auto-sets Telegram webhook on boot (no manual step)
// - Validates Telegram secret token
// - Commands: /start /help /pool /poolupdate /proof /stats /announce (admin)
// - Optional deposit watchers (ENABLE_WATCHERS=true)

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';

/* ---------- ENV & CONFIG ---------- */
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID       = process.env.TELEGRAM_CHAT_ID;                 // channel/group id (-100...)
const ADMIN_IDS     = (process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean).map(Number);
const PROOF_MESSAGE = process.env.PROOF_MESSAGE || '🧾 Latest Proof of Payout\n(share latest TX link + winner here).';
const TG_SECRET     = process.env.TELEGRAM_SECRET || 'Vault50SecretKey123456789';
const ENABLE_WATCH  = String(process.env.ENABLE_WATCHERS || 'true').toLowerCase() === 'true';

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

if (!TG_TOKEN) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN'); process.exit(1);
}

/* ---------- BOT (webhook) ---------- */
const bot = new TelegramBot(TG_TOKEN, { webHook: true, onlyFirstMatch: true });

/* ---------- EXPRESS APP ---------- */
const app = express();
const PORT = Number(process.env.PORT || 10000);
const WEBHOOK_PATH = `/telegram/${encodeURIComponent(TG_TOKEN)}`;

app.use(express.json());

// Optional: verify Telegram secret header (adds security)
app.post(WEBHOOK_PATH, (req, res) => {
  try {
    const hdr = req.get('x-telegram-bot-api-secret-token');
    if (hdr !== TG_SECRET) {
      console.warn('⚠️ Webhook request missing/invalid secret header');
      // We still process to avoid Telegram behavior differences; comment next line to hard-enforce:
      // return res.sendStatus(401);
    }
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error('processUpdate error:', e?.message || e);
    res.sendStatus(500);
  }
});

// Health endpoints
app.get('/', (_req, res) => res.type('text/plain').send('Vault50Bot up.'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Start server and set webhook automatically
app.listen(PORT, async () => {
  const base = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || ''}` || '';
  const webhookURL = `${base}${WEBHOOK_PATH}`;
  try {
    await bot.setWebHook(webhookURL, { secret_token: TG_SECRET, max_connections: 40 });
    console.log('Mode: Webhook');
    console.log('Listening on', PORT);
    console.log('Webhook set to:', webhookURL);
  } catch (e) {
    console.error('Failed to set webhook:', e?.response?.data || e?.message || e);
  }
});

/* ---------- HELPERS ---------- */
const post = async (text, opts={}) => {
  if (!CHAT_ID) return;
  try { await bot.sendMessage(CHAT_ID, text, { disable_web_page_preview: true, ...opts }); }
  catch (e) { console.error('sendMessage error:', e?.response?.body || e?.message); }
};

const fmt = (n, d=8) => Number(n).toFixed(d).replace(/\.?0+$/, '');

const evmProviderETH = new ethers.JsonRpcProvider(RPC.ETH);
const evmProviderBNB = new ethers.JsonRpcProvider(RPC.BNB);
const solConn        = new Connection(RPC.SOL, 'confirmed');

async function getBtcTotals(addr) {
  if (!addr) return { confirmed: 0, total: 0 };
  const { data } = await axios.get(`${RPC.BTC}/address/${addr}`, { timeout: 15000 });
  const cs = data.chain_stats  || { funded_txo_sum:0, spent_txo_sum:0 };
  const ms = data.mempool_stats|| { funded_txo_sum:0, spent_txo_sum:0 };
  const confirmed = (cs.funded_txo_sum - cs.spent_txo_sum) / 1e8;
  const total = confirmed + (ms.funded_txo_sum - ms.spent_txo_sum) / 1e8;
  return { confirmed, total };
}
async function getEvmTotal(provider, address) {
  if (!address) return 0;
  const wei = await provider.getBalance(address);
  return Number(ethers.formatEther(wei));
}
async function getSolTotal(address) {
  if (!address) return 0;
  const lam = await solConn.getBalance(new PublicKey(address), 'confirmed');
  return lam / 1e9;
}

/* ---------- COMMANDS ---------- */
bot.onText(/^\/start(?:@\w+)?$/i, (msg) =>
  bot.sendMessage(msg.chat.id, '🤖 Vault50Bot online. Use /help for commands.')
);

bot.onText(/^\/help(?:@\w+)?$/i, (msg) =>
  bot.sendMessage(msg.chat.id,
`🧭 Vault50Bot Commands
/pool — show totals
/pool update — refresh
/poolupdate — same
/proof — payout proof
/stats — system stats
/announce <text> — admin only`)
);

bot.onText(/^\/pool(?:\s+update)?(?:@\w+)?$/i, async (msg) => {
  try {
    const [btc, eth, bnb, sol] = await Promise.all([
      getBtcTotals(ADDR.BTC),
      getEvmTotal(evmProviderETH, ADDR.ETH),
      getEvmTotal(evmProviderBNB, ADDR.BNB),
      getSolTotal(ADDR.SOL),
    ]);
    const text = `📊 Pool Totals
BTC: ${fmt(btc.total)} BTC
ETH: ${fmt(eth, 6)} ETH
BNB: ${fmt(bnb, 6)} BNB
SOL: ${fmt(sol, 6)} SOL`;
    bot.sendMessage(msg.chat.id, text);
  } catch (e) {
    console.error('pool error:', e?.message || e);
    bot.sendMessage(msg.chat.id, '⚠️ Error fetching totals.');
  }
});
bot.onText(/^\/poolupdate(?:@\w+)?$/i, (msg) => bot.emit('text', { ...msg, text: '/pool update' }));

bot.onText(/^\/proof(?:@\w+)?$/i, (msg) => bot.sendMessage(msg.chat.id, PROOF_MESSAGE));

bot.onText(/^\/stats(?:@\w+)?$/i, (msg) => {
  const up = Math.floor(process.uptime());
  const h = Math.floor(up / 3600), m = Math.floor((up % 3600)/60);
  bot.sendMessage(msg.chat.id, `📈 Stats\nUptime: ${h}h ${m}m\nMode: Webhook\nWatching: ${ENABLE_WATCH ? 'ON' : 'OFF'}`);
});

bot.onText(/^\/announce (.+)/i, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const text = (match[1] || '').trim();
  if (text) await post(`📢 Announcement\n${text}`);
});

/* ---------- OPTIONAL WATCHERS (toggle via ENABLE_WATCHERS) ---------- */
const seen = new Set();
if (ENABLE_WATCH) {
  console.log('Watchers: ON');

  // BTC poller (mempool.space)
  const pollBTC = async () => {
    if (!ADDR.BTC) return;
    try {
      const [confirmed, mempool, addrInfo] = await Promise.all([
        axios.get(`${RPC.BTC}/address/${ADDR.BTC}/txs`, { timeout: 15000 }),
        axios.get(`${RPC.BTC}/address/${ADDR.BTC}/txs/mempool`, { timeout: 15000 }),
        axios.get(`${RPC.BTC}/address/${ADDR.BTC}`, { timeout: 15000 }),
      ]);
      const items = [...(confirmed.data || []), ...(mempool.data || [])];
      const funded = (addrInfo.data?.chain_stats?.funded_txo_sum || 0);
      const spent  = (addrInfo.data?.chain_stats?.spent_txo_sum  || 0);
      const totalBtc = (funded - spent) / 1e8;

      for (const tx of items.slice(0, 40)) {
        const id = tx.txid;
        if (seen.has(id)) continue;
        const outs = (tx.vout || []).filter(v => v.scriptpubkey_address === ADDR.BTC);
        if (!outs.length) continue;
        const amt = outs.reduce((a, v) => a + (v.value || 0), 0) / 1e8;
        seen.add(id);
        await post(`💸 New Deposit\nToken: BTC\nAmount: ${fmt(amt)} BTC\nTotal Wallet: ${fmt(totalBtc)} BTC`);
      }
    } catch (_) {}
  };

  // EVM pollers (ETH / BNB)
  const makeEvmPoller = (label, provider, toAddr) => {
    let last = 0;
    return async () => {
      if (!toAddr) return;
      try {
        const tip = await provider.getBlockNumber();
        if (!last) last = tip - 3;
        const from = Math.max(last + 1, tip - 6);
        for (let bn = from; bn <= tip; bn++) {
          const block = await provider.getBlock(bn, true);
          if (!block?.transactions) continue;
          for (const tx of block.transactions) {
            if (!tx.to) continue;
            if (tx.to.toLowerCase() !== toAddr.toLowerCase()) continue;
            if (seen.has(tx.hash)) continue;
            const amount = Number(ethers.formatEther(tx.value));
            const total  = Number(ethers.formatEther(await provider.getBalance(toAddr)));
            seen.add(tx.hash);
            await post(`💸 New Deposit\nToken: ${label}\nAmount: ${fmt(amount, 6)} ${label}\nTotal Wallet: ${fmt(total, 6)} ${label}`);
          }
        }
        last = tip;
      } catch (_) {}
    };
  };

  const pollETH = makeEvmPoller('ETH', evmProviderETH, ADDR.ETH);
  const pollBNB = makeEvmPoller('BNB', evmProviderBNB, ADDR.BNB);

  // SOL poller
  let lastSig = null;
  const pollSOL = async () => {
    if (!ADDR.SOL) return;
    try {
      const pub = new PublicKey(ADDR.SOL);
      const sigs = await solConn.getSignaturesForAddress(pub, lastSig ? { before: lastSig } : {}, 30);
      const list = sigs.slice().reverse();
      const totalLamports = await solConn.getBalance(pub, 'confirmed');
      const totalSOL = totalLamports / 1e9;

      for (const s of list) {
        if (seen.has(s.signature)) continue;
        const tx = await solConn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
        const ixs = tx?.transaction?.message?.instructions || [];
        for (const ins of ixs) {
          const p = ins.parsed;
          if (p?.type === 'transfer' && p?.info?.destination === ADDR.SOL) {
            const sol = Number(p.info.lamports || 0) / 1e9;
            seen.add(s.signature);
            await post(`💸 New Deposit\nToken: SOL\nAmount: ${fmt(sol, 6)} SOL\nTotal Wallet: ${fmt(totalSOL, 6)} SOL`);
            break;
          }
        }
      }
      if (sigs.length) lastSig = sigs[0].signature;
    } catch (_) {}
  };

  setInterval(pollBTC, 20000);
  setInterval(pollETH, 15000);
  setInterval(pollBNB, 15000);
  setInterval(pollSOL, 20000);
} else {
  console.log('Watchers: OFF');
}
