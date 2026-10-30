'use strict';
// Provider registry: ONE entry per data provider. The client only ever receives the derived status,
// latency, env-var NAMES (plus a set/unset boolean) and public signup URLs; never a value.
//
// Entry fields
//   id, name, category        identity + grouping in the Data Sources panel
//   env: [{ name, required }]  env var NAMES this provider reads (server-side only)
//   anyOf: true                any one of the env vars enables it (e.g. QuickNode endpoint per chain)
//   keyless: true              works without a key (public endpoint)
//   adapter: 'file'            optional: server/providers/adapters/<file>.js implementing { create(ctx) } (see README)
//   placeholder: true          listed for planning; no adapter yet
//   health: [ids or prefixes*] health rows that measure this provider (status + latency come from here)
//   unlocks: [...]             strategies / features this provider powers
//   signup                     public signup / docs URL
//   fallback                   what runs when it is missing
module.exports = [
  // ---- exchange websockets (keyless) ----
  { id: 'hyperliquid', name: 'Hyperliquid', category: 'exchange', keyless: true, health: ['ws.hyperliquid', 'funding.hyperliquid'], signup: 'https://hyperliquid.xyz',
    unlocks: ['Funding arb', 'Perp momentum', 'Perp basis', 'Whale-follow pricing'], fallback: 'REST info endpoint polling' },
  { id: 'binance', name: 'Binance (USD-M perps + spot)', category: 'exchange', keyless: true, health: ['ws.binance', 'ws.binance-spot', 'funding.binance', 'candles.binance'], signup: 'https://www.binance.com',
    unlocks: ['Funding arb', 'Perp momentum', 'Perp basis'], fallback: 'REST (geo-blocked from some regions; WS often still works)' },
  { id: 'bybit', name: 'Bybit (linear perps + spot)', category: 'exchange', keyless: true, health: ['ws.bybit', 'ws.bybit-spot', 'funding.bybit'], signup: 'https://www.bybit.com',
    unlocks: ['Funding arb', 'Perp momentum', 'Perp basis'], fallback: 'REST (geo-blocked from some regions)' },
  { id: 'okx', name: 'OKX (swaps + spot)', category: 'exchange', keyless: true, health: ['ws.okx', 'funding.okx', 'candles.okx', 'spot.okx'], signup: 'https://www.okx.com',
    unlocks: ['Funding arb', '1% mode candles', 'Perp momentum', 'Perp basis', 'Strategy backtests'], fallback: 'REST polling' },
  { id: 'coinbase', name: 'Coinbase Exchange', category: 'exchange', keyless: true, health: ['candles.coinbase'], signup: 'https://www.coinbase.com', unlocks: ['1% mode candles (fallback)'] },
  // ---- Solana ----
  { id: 'helius', name: 'Helius (Solana webhook → HAWSE inbox)', category: 'solana', feed: 'whale.solana',
    env: [{ name: 'WHALES_ENABLED' }, { name: 'HAWSE_WEBHOOK_URL', required: true }, { name: 'HAWSE_READ_TOKEN', required: true }, { name: 'HELIUS_API_KEY' }, { name: 'HELIUS_WEBHOOK_AUTH' },
      { name: 'HELIUS_MODE' }, { name: 'HELIUS_WATCH_ADDRESSES' }, { name: 'HELIUS_WEBHOOK_ADDRESSES' }, { name: 'INBOX_POLL_SEC' }, { name: 'HELIUS_CREDIT_BUDGET' }, { name: 'HELIUS_DAILY_CREDIT_BUDGET' }, { name: 'HELIUS_PAUSE_AT_PCT' }, { name: 'HELIUS_AUTO_PAUSE_WEBHOOK' }],
    health: ['whale.solana', 'whale.inbox'], signup: 'https://www.helius.dev',
    unlocks: ['Whale monitor (Solana): Helius enhanced webhook (1 credit/event) → Cloudflare inbox, polled every 15–60 s (no credits)'],
    fallback: 'DEMO/MOCK Solana whale feed (labelled). OFF unless WHALES_ENABLED=true; "inbox not configured" without HAWSE_WEBHOOK_URL + HAWSE_READ_TOKEN; hard daily credit cap with auto-pause' },
  { id: 'jupiter', name: 'Jupiter quotes', category: 'solana', keyless: true, env: [{ name: 'JUPITER_API_BASE' }, { name: 'JUPITER_API_KEY', optional: true }], health: ['dex.jupiter'], signup: 'https://jup.ag',
    unlocks: ['Gap scanner (Solana per-DEX + triangular)'], fallback: 'DexScreener indicative mids (not executable)' },
  // ---- EVM RPC ----
  { id: 'alchemy', name: 'Alchemy (EVM RPC + WS)', category: 'evm', env: [{ name: 'ALCHEMY_API_KEY', required: true }], health: ['whale.ethereum', 'whale.base', 'whale.arbitrum', 'ws.ethereum', 'ws.base', 'ws.arbitrum'],
    signup: 'https://www.alchemy.com', unlocks: ['Whale monitor (ETH/Base/Arbitrum) on a keyed RPC', 'newHeads push triggers'], fallback: 'public RPC (publicnode) if EVM_PUBLIC_RPC_FALLBACK=true, else MOCK' },
  { id: 'infura', name: 'Infura (EVM RPC + WS)', category: 'evm', env: [{ name: 'INFURA_API_KEY', required: true }], health: ['whale.ethereum', 'whale.base', 'whale.arbitrum', 'ws.ethereum', 'ws.base', 'ws.arbitrum'],
    signup: 'https://www.infura.io', unlocks: ['Whale monitor (ETH/Base/Arbitrum) on a keyed RPC'], fallback: 'used only if ALCHEMY_API_KEY is unset' },
  { id: 'quicknode', name: 'QuickNode (paste endpoint URLs)', category: 'evm', anyOf: true,
    env: ['EVM_RPC_URL_ETHEREUM', 'EVM_RPC_URL_BASE', 'EVM_RPC_URL_ARBITRUM', 'EVM_WS_URL_ETHEREUM', 'EVM_WS_URL_BASE', 'EVM_WS_URL_ARBITRUM'].map((name) => ({ name, required: true })),
    health: ['whale.ethereum', 'whale.base', 'whale.arbitrum', 'ws.ethereum', 'ws.base', 'ws.arbitrum'], signup: 'https://www.quicknode.com',
    unlocks: ['Any EVM RPC/WS endpoint (QuickNode or another provider) per chain; highest priority'], fallback: 'Alchemy > Infura > publicnode' },
  { id: 'publicnode', name: 'publicnode (keyless EVM RPC + WS)', category: 'evm', keyless: true, env: [{ name: 'EVM_PUBLIC_RPC_FALLBACK' }],
    health: ['whale.ethereum', 'whale.base', 'whale.arbitrum', 'ws.ethereum', 'ws.base', 'ws.arbitrum', 'dex.gas.*'], signup: 'https://www.publicnode.com',
    unlocks: ['Whale monitor + gas on ETH/Base/Arbitrum without keys (rate-limited, best effort)'] },
  { id: 'dexscreener', name: 'DexScreener', category: 'dex', keyless: true, health: ['dex.dexscreener'], signup: 'https://dexscreener.com', unlocks: ['Gap scanner (EVM pool mids, indicative)'] },
  { id: 'paraswap', name: 'ParaSwap quotes', category: 'dex', keyless: true, health: ['dex.paraswap'], signup: 'https://www.paraswap.io', unlocks: ['Gap scanner (EVM executable round-trip)'] },
  // ---- oracle ----
  { id: 'pyth', name: 'Pyth Network (Hermes stream)', category: 'oracle', adapter: 'pyth', env: [{ name: 'PYTH_API_KEY', required: true }, { name: 'PYTH_HERMES_URL' }], health: ['pyth.hermes'], signup: 'https://pyth.network',
    unlocks: ['Oracle cross-check of venue marks (deviation shown in Data Sources)'], fallback: 'SSE stream, REST polling if the stream drops; without a key the cross-check is off' },
  // ---- futures ----
  { id: 'tradovate', name: 'Tradovate (CME micro futures)', category: 'futures',
    env: ['TRADOVATE_USERNAME', 'TRADOVATE_PASSWORD', 'TRADOVATE_APP_ID', 'TRADOVATE_CID', 'TRADOVATE_SECRET'].map((name) => ({ name, required: true })),
    health: ['tradovate.auth', 'tradovate.md', 'futures.sim'], signup: 'https://www.tradovate.com', unlocks: ['ORB on real MES/MNQ bars'], fallback: 'SIMULATED MES/MNQ session (labelled; PnL booked as simulated)' },
  // ---- sports ----
  { id: 'theoddsapi', name: 'The Odds API (sportsbook odds + scores)', category: 'sports',
    feed: 'odds', env: [{ name: 'ODDS_API_KEY', required: true }, { name: 'ODDS_SPORTS' }, { name: 'ODDS_MARKETS' }, { name: 'ODDS_BOOKMAKERS' }, { name: 'BET_SNAPSHOTS_MIN' }, { name: 'ODDS_MONTHLY_BUDGET' }],
    health: ['odds.theoddsapi', 'odds.scores', 'odds.mock'], signup: 'https://the-odds-api.com',
    unlocks: ['Real multi-book odds for +EV line shopping, spread signals, arb/middle alerts', 'Final scores to grade paper bets', 'Closing-line value on real lines'],
    fallback: 'MOCK odds (synthetic books, labelled; bets booked as SIMULATED)' },
  // ---- premium vendors: placeholders (no adapter yet) ----
  { id: 'kaiko', name: 'Kaiko (institutional market data)', category: 'premium', placeholder: true, env: [{ name: 'KAIKO_API_KEY', required: true }], signup: 'https://www.kaiko.com',
    unlocks: ['Consolidated order books / trades across venues (future adapter)'] },
  { id: 'amberdata', name: 'Amberdata', category: 'premium', placeholder: true, env: [{ name: 'AMBERDATA_API_KEY', required: true }], signup: 'https://www.amberdata.io',
    unlocks: ['Derivatives funding / order-book history (future adapter)'] },
  { id: 'coinapi', name: 'CoinAPI', category: 'premium', placeholder: true, env: [{ name: 'COINAPI_KEY', required: true }], signup: 'https://www.coinapi.io',
    unlocks: ['Normalized multi-venue quotes / order books (future adapter)'] },
  { id: 'tardis', name: 'Tardis.dev (historical tick data)', category: 'premium', placeholder: true, env: [{ name: 'TARDIS_API_KEY', required: true }], signup: 'https://tardis.dev',
    unlocks: ['Tick-level replay for backtests (future adapter)'] },
];
