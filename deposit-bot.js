// Vault50Bot — stable webhook version
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';

// --- Environment ---
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUBLIC_URL = process.env.PUBLIC_URL;

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
  BTC_API: process.env.BTC_MEMPOOL_API || 'https://mempool.space/api'
};

if (!TG_TOKEN || !PUBLIC_URL) {
  console.error('Missing TELEGRAM_BOT_TOKEN or PUBLIC_URL');
  process.exit(1);
}

const bot = new TelegramBot(TG_TOKEN, { webHook: { port: false } });
const webhookPath = `/bot${TG_TOKEN}`;
await bot.setWebHook(`${PUBLIC_URL}${webhookPath}`);

const app = express();
app.use(express.json());
app.get('/healthz', (_, res) => res.send('ok'));
app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
app.get('/', (_, res) => res.send('Vault50Bot active'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

// Blockchain connections
const providerETH = new ethers.JsonRpcProvider(RPC.ETH);
const providerBNB = new ethers.JsonRpcProvider(RPC.BNB);
const solConn = new Connection(RPC.SOL, 'confirmed');

function fmt(n, d = 6) { return Number(n).toFixed(d).replace(/\.?0+$/, ''); }
async function getBtc(addr) {
  const { data } = await axios.get(`${RPC.BTC_API}/address/${addr}`);
  const cs = data.chain_stats;
  return (cs.funded_txo_sum - cs.spent_txo_sum) / 1e8;
}
async function getEvm(p, a) { return Number(ethers.formatEther(await p.getBalance(a))); }
async function getSol(a) { return (await solConn.getBalance(new PublicKey(a))) / 1e9; }

async function post(msg) {
  if (!CHAT_ID) return;
  try { await bot.sendMessage(CHAT_ID, msg, { disable_web_page_preview: true }); }
  catch (e) { console.error(e.message); }
}

// Commands
bot.onText(/^\/start/, msg => bot.sendMessage(msg.chat.id, '🤖 Vault50Bot online. Use /pool or /help.'));
bot.onText(/^\/help/, msg => bot.sendMessage(msg.chat.id,
`Commands:
/pool — totals
/proof — payout proof
/stats — uptime info`));
bot.onText(/^\/pool/, async msg => {
  const [b, e, n, s] = await Promise.all([
    ADDR.BTC ? getBtc(ADDR.BTC) : 0,
    ADDR.ETH ? getEvm(providerETH, ADDR.ETH) : 0,
    ADDR.BNB ? getEvm(providerBNB, ADDR.BNB) : 0,
    ADDR.SOL ? getSol(ADDR.SOL) : 0
  ]);
  bot.sendMessage(msg.chat.id, `📊 Pool Totals
BTC: ${fmt(b)} BTC
ETH: ${fmt(e)} ETH
BNB: ${fmt(n)} BNB
SOL: ${fmt(s)} SOL`);
});
bot.onText(/^\/proof/, msg => bot.sendMessage(msg.chat.id, '🧾 Proofs will appear in this channel.'));
bot.onText(/^\/stats/, msg => bot.sendMessage(msg.chat.id, `⏱️ Uptime: ${Math.floor(process.uptime() / 60)} min`));

console.log('Mode: Webhook (Light)');
