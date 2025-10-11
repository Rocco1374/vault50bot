// deposit-bot.js — Vault50 (Expert Build: Pro Auto-mode + Free Fallback)
try { require('dotenv').config(); } catch (_) {}

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { ethers } = require('ethers');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');

/* ======================
   ENV & Feature flags
   ====================== */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;          // -100...
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean).map(Number);

const ADDR = {
  BTC: process.env.ADDR_BTC,
  ETH: process.env.ADDR_ETH,
  BNB: process.env.ADDR_BNB,
  SOL: process.env.ADDR_SOL,
};

const RPC = {
  // HTTPS RPCs (for commands & summaries)
  ETH_HTTP: process.env.ETH_RPC || 'https://eth.llamarpc.com',
  BNB_HTTP: process.env.BNB_RPC || 'https://bsc-dataseed.binance.org',
  SOL_HTTP: process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com',
  BTC_API : process.env.BTC_MEMPOOL_API || 'https://mempool.space/api',

  // WebSocket RPCs (turn on auto mode if provided)
  ETH_WSS: process.env.ETH_WSS || '',
  BNB_WSS: process.env.BNB_WSS || '',
  SOL_WSS: process.env.SOL_WSS || '', // optional, falls back to HTTP polling if missing
};

const CONF = {
  BTC: Number(process.env.CONFIRMS_BTC || 1),
  EVM: Number(process.env.CONFIRMS_EVM || 1),
  SOL: Number(process.env.CONFIRMS_SOL || 1),
};

const DEFAULT_PROOF = process.env.PROOF_MESSAGE
  || '🧾 Proof posted after each draw.\n✅ Verified on-chain.';

// Auto-mode turns on when at least one WSS is present
const AUTO_MODE = Boolean(RPC.ETH_WSS || RPC.BNB_WSS || RPC.SOL_WSS);

// Telegram webhook (for pro hosting) or polling (Render Free fine)
const WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || ''; // e.g. https://your-service.onrender.com/bot

if (!TG_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN'); process.exit(1);
}

/* ======================
   Telegram wiring
   ====================== */
let bot;
if (WEBHOOK_URL) {
  bot = new TelegramBot(TG_TOKEN, { webHook: { port: process.env.PORT || 3000 } });
  // set webhook
  bot.setWebHook(`${WEBHOOK_URL}/${TG_TOKEN}`).catch(() => {});
} else {
  // polling works great on Render Free
  bot = new TelegramBot(TG_TOKEN, { polling: true });
}

const post = async (text) => {
  if (!CHAT_ID) return;
  try { await bot.sendMessage(CHAT_ID, text, { disable_web_page_preview: true }); }
  catch (e) { console.error('Telegram send error:', e?.message); }
};

/* ======================
   Providers (HTTP)
   ====================== */
const ethHttp = new ethers.JsonRpcProvider(RPC.ETH_HTTP);
const bnbHttp = new ethers.JsonRpcProvider(RPC.BNB_HTTP);
const solHttp = new Connection(RPC.SOL_HTTP || clusterApiUrl('mainnet-beta'), 'confirmed');

/* ======================
   Helpers
   ====================== */
const seen = new Set(); // de-dup tx announcements
const fmt = (n, d=8) => String(Number(n).toFixed(d)).replace(/\.?0+$/,'');

async function btcTotals(addr) {
  if (!addr) return { confirmed: 0, total: 0 };
  const { data } = await axios.get(`${RPC.BTC_API}/address/${addr}`, { timeout: 15000 });
  const cs = data.chain_stats || {funded_txo_sum:0, spent_txo_sum:0};
  const ms = data.mempool_stats || {funded_txo_sum:0, spent_txo_sum:0};
  const confirmed = (cs.funded_txo_sum - cs.spent_txo_sum) / 1e8;
  const total = confirmed + (ms.funded_txo_sum - ms.spent_txo_sum) / 1e8;
  return { confirmed, total };
}

async function evmTotal(provider, addr) {
  if (!addr) return 0;
  const wei = await provider.getBalance(addr);
  return Number(ethers.formatEther(wei));
}

async function solTotal(addr) {
  if (!addr) return 0;
  const lam = await solHttp.getBalance(new PublicKey(addr), 'confirmed');
  return lam / 1e9;
}

function depositMsg(symbol, amountStr, totalStr) {
  return `💸 New Deposit
Token: ${symbol}
Amount: ${amountStr}
Total Wallet: ${totalStr}`;
}

/* ======================
   Commands (work in all modes)
   ====================== */
bot.onText(/^\/start(?:@\w+)?$/, msg => {
  bot.sendMessage(msg.chat.id,
    '🤖 Vault50Bot online.\n- /help for commands\n- Auto-mode enabled: ' + (AUTO_MODE ? 'YES' : 'NO'));
});

bot.onText(/^\/help(?:@\w+)?$/, msg => {
  bot.sendMessage(msg.chat.id, `🧭 Vault50Bot Commands

/pool — show current totals
/pool update — refresh totals
/poolupdate — same as above
/proof — latest payout proof
/stats — uptime & mode
/announce <text> — admin-only broadcast`);
});

bot.onText(/^\/pool(?:\s+update)?(?:@\w+)?$/, async (msg) => {
  try {
    const [btc, eth, bnb, sol] = await Promise.all([
      btcTotals(ADDR.BTC),
      evmTotal(ethHttp, ADDR.ETH),
      evmTotal(bnbHttp, ADDR.BNB),
      solTotal(ADDR.SOL),
    ]);
    const text = `📊 Pool Totals
BTC: ${fmt(btc.total)} BTC (confirmed ${fmt(btc.confirmed)})
ETH: ${fmt(eth,6)} ETH
BNB: ${fmt(bnb,6)} BNB
SOL: ${fmt(sol,6)} SOL`;
    bot.sendMessage(msg.chat.id, text, { disable_web_page_preview: true });
  } catch (e) {
    bot.sendMessage(msg.chat.id, '⚠️ Could not fetch totals. Try again shortly.');
  }
});
bot.onText(/^\/poolupdate(?:@\w+)?$/, (msg) => bot.emit('text', { ...msg, text: '/pool update' }));

bot.onText(/^\/proof(?:@\w+)?$/, (msg) => bot.sendMessage(msg.chat.id, DEFAULT_PROOF));

bot.onText(/^\/stats(?:@\w+)?$/, (msg) => {
  const uptimeH = Math.floor(process.uptime()/3600);
  bot.sendMessage(msg.chat.id, `📈 Vault50 Stats
Mode: ${AUTO_MODE ? 'Auto (watchers on)' : 'Light (free-friendly)'}
Uptime: ${uptimeH}h
Now: ${new Date().toLocaleString()}`);
});

bot.onText(/^\/announce (.+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const text = match[1].trim();
  if (text) await post(`📢 Announcement\n${text}`);
});

bot.on('new_chat_members', async (msg) => {
  for (const u of msg.new_chat_members) {
    await bot.sendMessage(msg.chat.id, `👋 Welcome ${u.first_name || 'there'} to Vault50!\nType /help for commands.`);
  }
});

/* ======================
   Daily summary (both modes)
   ====================== */
async function dailySummary() {
  try {
    const [btc, eth, bnb, sol] = await Promise.all([
      btcTotals(ADDR.BTC),
      evmTotal(ethHttp, ADDR.ETH),
      evmTotal(bnbHttp, ADDR.BNB),
      solTotal(ADDR.SOL),
    ]);
    await post(`📅 Daily Pool Summary
BTC: ${fmt(btc.total)} BTC
ETH: ${fmt(eth,6)} ETH
BNB: ${fmt(bnb,6)} BNB
SOL: ${fmt(sol,6)} SOL`);
  } catch (_) {}
}
setInterval(dailySummary, 24 * 60 * 60 * 1000);

/* ======================
   Auto-mode watchers
   ====================== */
// ETH / BNB (WebSocket block tailing)
async function startEvmWatcher(label, wssUrl, addr, httpProvider, confirms = 1) {
  if (!wssUrl || !addr) return;
  const provider = new ethers.WebSocketProvider(wssUrl);
  console.log(`EVM watcher for ${label} starting…`);

  provider.on('block', async (bn) => {
    try {
      // Confirmations guard
      const tip = await httpProvider.getBlockNumber();
      if (bn > tip - confirms + 1) return;

      const block = await httpProvider.getBlock(bn, true);
      if (!block?.transactions) return;

      for (const tx of block.transactions) {
        if (!tx.to) continue;
        if (tx.to.toLowerCase() !== addr.toLowerCase()) continue;
        if (seen.has(tx.hash)) continue;

        // Amount & total
        const val = Number(ethers.formatEther(tx.value));
        const total = Number(ethers.formatEther(await httpProvider.getBalance(addr)));

        seen.add(tx.hash);
        await post(depositMsg(label, `${fmt(val,6)} ${label}`, `${fmt(total,6)} ${label}`));
      }
    } catch (e) {}
  });

  provider.on('error', () => console.warn(`${label} WSS error (will auto-reconnect)`));
  provider._websocket?.on?.('close', () => console.warn(`${label} WSS closed (provider will reconnect if supported)`));
}

// SOL (WSS logs or HTTP polling fallback)
async function startSolWatcher(wssUrl, addr, confirms = 1) {
  if (!addr) return;
  try {
    const conn = wssUrl ? new Connection(wssUrl, 'confirmed') : solHttp;
    console.log('SOL watcher starting… (', wssUrl ? 'WSS' : 'HTTP poll', ')');

    if (wssUrl) {
      // Subscribe to account changes
      const pub = new PublicKey(addr);
      conn.onLogs(pub, async (log) => {
        // When logs appear, re-read balance (simple & reliable)
        try {
          const lam = await conn.getBalance(pub, 'confirmed');
          const total = lam / 1e9;
          // We don't get exact amount without parsing full tx; post total snapshot.
          await post(depositMsg('SOL', 'received (amount in tx)', `${fmt(total,6)} SOL`));
        } catch (_) {}
      }, 'confirmed');
      return;
    }

    // HTTP fallback: poll recent signatures
    let lastSig = null;
    setInterval(async () => {
      try {
        const pub = new PublicKey(addr);
        const sigs = await solHttp.getSignaturesForAddress(pub, lastSig ? { before: lastSig } : {}, 25);
        const list = sigs.slice().reverse();
        for (const s of list) {
          if (seen.has(s.signature)) continue;
          const tx = await solHttp.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
          const ixs = tx?.transaction?.message?.instructions || [];
          for (const ins of ixs) {
            const p = ins.parsed;
            if (p?.type === 'transfer' && p?.info?.destination === addr) {
              const lam = Number(p.info.lamports || 0);
              const amt = lam / 1e9;
              const bal = await solHttp.getBalance(pub, 'confirmed');
              const total = bal / 1e9;
              seen.add(s.signature);
              await post(depositMsg('SOL', `${fmt(amt,6)} SOL`, `${fmt(total,6)} SOL`));
              break;
            }
          }
        }
        if (sigs.length) lastSig = sigs[0].signature;
      } catch (_) {}
    }, 20000);
  } catch (_) {}
}

// BTC (HTTP poll via mempool.space)
async function startBtcPoller(addr, confirms = 1) {
  if (!addr) return;
  console.log('BTC poller starting…');
  setInterval(async () => {
    try {
      const [confirmed, mempool, addrInfo] = await Promise.all([
        axios.get(`${RPC.BTC_API}/address/${addr}/txs`, { timeout: 15000 }),
        axios.get(`${RPC.BTC_API}/address/${addr}/txs/mempool`, { timeout: 15000 }),
        axios.get(`${RPC.BTC_API}/address/${addr}`, { timeout: 15000 }),
      ]);
      const items = [...(confirmed.data || []), ...(mempool.data || [])];
      const funded = (addrInfo.data?.chain_stats?.funded_txo_sum || 0);
      const spent  = (addrInfo.data?.chain_stats?.spent_txo_sum || 0);
      const totalBtc = (funded - spent) / 1e8;

      for (const tx of items.slice(0, 50)) {
        const txid = tx.txid;
        if (seen.has(txid)) continue;
        const outs = (tx.vout || []).filter(v => v.scriptpubkey_address === addr);
        if (!outs.length) continue;

        const conf = tx.status?.confirmed ? 1 : 0;
        if (conf < confirms) continue;

        const amtBtc = outs.reduce((a, v) => a + (v.value || 0), 0) / 1e8;
        seen.add(txid);
        await post(depositMsg('BTC', `${fmt(amtBtc)} BTC`, `${fmt(totalBtc)} BTC`));
      }
    } catch (_) {}
  }, 20000);
}

/* Start watchers only if any WSS is provided (Auto-mode).
   Free mode keeps them off to avoid Render sleeping issues. */
(async () => {
  if (AUTO_MODE) {
    startEvmWatcher('ETH', RPC.ETH_WSS, ADDR.ETH, ethHttp, CONF.EVM);
    startEvmWatcher('BNB', RPC.BNB_WSS, ADDR.BNB, bnbHttp, CONF.EVM);
  }
  // SOL WSS optional; will fall back to HTTP polling if WSS missing
  startSolWatcher(RPC.SOL_WSS, ADDR.SOL, CONF.SOL);
  // BTC polling OK in both modes (lightweight)
  startBtcPoller(ADDR.BTC, CONF.BTC);
})();

/* ======================
   Keep-alive HTTP server
   ====================== */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (WEBHOOK_URL && req.url === `/${TG_TOKEN}` && req.method === 'POST') {
    // Telegram webhook ingress (if using webhooks)
    let body = '';
    req.on('data', chunk => (body += chunk.toString()));
    req.on('end', () => {
      try { bot.processUpdate(JSON.parse(body)); } catch (_) {}
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, autoMode: AUTO_MODE, uptime: process.uptime() }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Vault50Bot OK\n');
}).listen(PORT, () => {
  console.log('HTTP keep-alive listening on', PORT);
  console.log('Mode:', AUTO_MODE ? 'Auto (watchers ON if WSS set)' : 'Light (commands & daily summary)');
});
