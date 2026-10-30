'use strict';
// Server-side configuration. Secrets are read from process.env (optionally
// populated from a local, gitignored .env file). Nothing in this module is
// ever serialized to the browser except the booleans in publicFlags().
const fs = require('fs');
const path = require('path');

function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}

const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

function build(env = process.env) {
  const c = {
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 8787),
    paperStartEquity: num(env.PAPER_START_EQUITY, 10000),
    // Hard-coded: this build has no live trading. Setting this env var to
    // anything other than "paper" makes the server refuse to start.
    tradingMode: env.TRADING_MODE || 'paper',
    risk: {
      dailyLossPct: num(env.RISK_DAILY_LOSS_PCT, 3),
      maxDrawdownPct: num(env.RISK_MAX_DRAWDOWN_PCT, 10),
    },
    ws: { enabled: bool(env.WS_ENABLED, true), spotSymbols: list(env.WS_SPOT_SYMBOLS, ['BTC', 'ETH', 'SOL']) },
  funding: {
      symbols: list(env.FUNDING_SYMBOLS, ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'ARB', 'AVAX']),
      pollMs: num(env.FUNDING_POLL_MS, 30000),
      holdHours: num(env.FUNDING_HOLD_HOURS, 24),
      minNetBps: num(env.FUNDING_MIN_NET_BPS, 8),
    },
    helius: { apiKey: env.HELIUS_API_KEY || '', watch: list(env.HELIUS_WATCH_ADDRESSES, null), minUsd: num(env.WHALE_MIN_USD, 250000) },
    evm: {
      alchemyKey: env.ALCHEMY_API_KEY || '',
      infuraKey: env.INFURA_API_KEY || '',
      rpc: { ethereum: env.EVM_RPC_URL_ETHEREUM || env.EVM_RPC_URL || '', base: env.EVM_RPC_URL_BASE || '', arbitrum: env.EVM_RPC_URL_ARBITRUM || '' },
      ws: { ethereum: env.EVM_WS_URL_ETHEREUM || '', base: env.EVM_WS_URL_BASE || '', arbitrum: env.EVM_WS_URL_ARBITRUM || '' },
      publicFallback: bool(env.EVM_PUBLIC_RPC_FALLBACK, true),
      chains: list(env.EVM_CHAINS, ['ethereum', 'base', 'arbitrum']),
    },
    tradovate: {
      username: env.TRADOVATE_USERNAME || '', password: env.TRADOVATE_PASSWORD || '',
      appId: env.TRADOVATE_APP_ID || '', cid: env.TRADOVATE_CID || '', secret: env.TRADOVATE_SECRET || '',
      appVersion: env.TRADOVATE_APP_VERSION || '1.0', symbols: list(env.TRADOVATE_SYMBOLS, null), simBarMs: num(env.TRADOVATE_SIM_BAR_MS, 1500),
    },
    perps: {
      symbols: list(env.PERP_SYMBOLS, ['BTC', 'ETH', 'SOL']),
      momentum: { bar: env.PERP_MOM_BAR || '5m', lookback: num(env.PERP_MOM_LOOKBACK, 20), slAtr: num(env.PERP_MOM_SL_ATR, 1.5), tpAtr: num(env.PERP_MOM_TP_ATR, 3),
        riskPct: num(env.PERP_MOM_RISK_PCT, 0.01), sizePct: num(env.PERP_MOM_SIZE_PCT, 0.5), maxHoldH: num(env.PERP_MOM_MAX_HOLD_H, 6) },
      basis: { minNetBps: num(env.BASIS_MIN_NET_BPS, 5), exitBps: num(env.BASIS_EXIT_BPS, 2), holdH: num(env.BASIS_HOLD_H, 24), maxHoldH: num(env.BASIS_MAX_HOLD_H, 72), sizePct: num(env.BASIS_SIZE_PCT, 0.45), maxPositions: num(env.BASIS_MAX_POSITIONS, 2) },
    },
    onepct: { symbols: list(env.ONEPCT_SYMBOLS, ['BTC', 'ETH', 'SOL']), targetNetPct: num(env.ONEPCT_TARGET_NET_PCT, 1), minScore: num(env.ONEPCT_MIN_SCORE, 80) },
    jupiter: { base: env.JUPITER_API_BASE || 'https://lite-api.jup.ag' },
    orb: { minutes: num(env.ORB_MINUTES, 15), targetR: num(env.ORB_TARGET_R, 1.5), feePerSide: num(env.ORB_FEE_PER_SIDE, 0.72), maxRiskPct: num(env.ORB_MAX_RISK_PCT, 8),
      minWidthPct: num(env.ORB_MIN_WIDTH_PCT, 0.1), maxWidthPct: num(env.ORB_MAX_WIDTH_PCT, 0.8), lastEntryMinute: 240, flatMinute: 385 },
    gaps: { notionalUsd: num(env.GAP_NOTIONAL_USD, 1000), pSuccess: num(env.GAP_P_SUCCESS, 0.35), solTipLamports: num(env.GAP_SOL_TIP_LAMPORTS, 100000),
      solPriorityMicroLamports: num(env.GAP_SOL_PRIORITY_MICROLAMPORTS, 50000), evmGasUnits: num(env.GAP_EVM_GAS_PER_SWAP, 180000), evmPoolFeeBps: num(env.GAP_EVM_POOL_FEE_BPS, 5),
      minEvUsd: num(env.GAP_MIN_EV_USD, 0.5), solPollMs: num(env.GAP_SOL_POLL_MS, 30000), evmPollMs: num(env.GAP_EVM_POLL_MS, 60000) },
  };
  c.tradovate.configured = !!(c.tradovate.username && c.tradovate.password && c.tradovate.appId && c.tradovate.cid && c.tradovate.secret);
  return c;
}

function publicFlags(c) {
  // Only booleans / non-secret settings leave the server.
  return {
    tradingMode: 'paper',
    heliusConfigured: !!c.helius.apiKey,
    evmKeyConfigured: !!(c.evm.alchemyKey || c.evm.infuraKey || c.evm.rpc.ethereum || c.evm.rpc.base || c.evm.rpc.arbitrum),
    evmPublicFallback: c.evm.publicFallback,
    tradovateConfigured: c.tradovate.configured,
    paperStartEquity: c.paperStartEquity,
  };
}

module.exports = { loadDotEnv, build, publicFlags };
