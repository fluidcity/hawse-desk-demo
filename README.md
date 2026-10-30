# HAWSE Desk — real-data paper trading terminal

A dark trading-terminal desk that runs strategies against **real public market data**, books every trade into a **paper** ledger with modeled fees and slippage, and gates it all behind a portfolio risk gate.

> **Paper only.** No code path sends a real order. `LiveBroker.placeOrder/cancelOrder` throw `LiveTradingDisabledError`, `POST /api/live-order` returns 403, and the server refuses to start unless `TRADING_MODE=paper`.

The original slider simulator is still here, behind the **Demo mode** toggle in the top bar (`public/demo/`). It produces random PnL, so it is shown in its own iframe under a "NOT real data" banner and never touches the paper ledger.

## Start

```bash
cp .env.example .env    # optional; every key is optional
npm start               # http://127.0.0.1:8787
npm test                # node:test, no dependencies
```

You need Node ≥ 22. There are no npm dependencies. One Node process proxies every upstream feed, runs the strategy engine and serves the UI. The browser only renders the `/api/stream` (SSE) snapshot, so secrets never reach it.

## Honesty rules built into the code

- **Real and simulated books are separate.** `Ledger.close()` requires an explicit `simulated` boolean. A strategy running on mock or simulated inputs books into the SIM book, the dashed cyan line. It never touches the real-data equity, the solid line. Each book has its own risk gate.
- **Costs are charged up front.** Entry fees are charged at the open, and unrealized PnL already subtracts the modeled exit fees and slippage. Open positions never flatter equity.
- **No profit injection.** PnL comes only from fills against observed prices and funding settlements.
- **Skips are logged.** When nothing clears the hurdle, the strategy records a skip reason (visible on its card and in the tape) instead of forcing a trade.
- **The health panel shows every source** as LIVE, MOCK or NO DATA, with latency and the age of its last update.

## Strategies and data sources

| # | Strategy | Real source (no key) | Keyed source | Fallback |
|---|---|---|---|---|
| 1 | Cross-venue perp funding arb | OKX, Hyperliquid, Binance, Bybit public REST | — | A venue that fails shows **NO DATA** and is excluded. Nothing is faked. |
| 2 | Whale flow (large-tx monitor) | EVM via public RPC (publicnode) for Ethereum, Base and Arbitrum | `HELIUS_API_KEY` (Solana), `EVM_RPC_URL_*` / `ALCHEMY_API_KEY` / `INFURA_API_KEY` | With no key, Solana runs labeled **MOCK**. With `EVM_PUBLIC_RPC_FALLBACK=false` and no key, EVM runs MOCK. Trades on mock signals book to the SIM book. |
| 3 | 1% mode | OKX spot candles (15m) and spot top-of-book | — | Coinbase, then Binance data-api candles. With no candles the strategy shows NO DATA and does not trade. |
| 4 | DEX gap scanner | Jupiter lite-api per-DEX quotes (Solana), DexScreener pool prices, ParaSwap quotes, `eth_gasPrice` via public RPC (Ethereum, Base, Arbitrum) | optional `JUPITER_API_BASE`, EVM RPC vars | If Jupiter is down, Solana falls back to DexScreener mid prices, labeled **INDICATIVE**, which are never traded. EVM mid-price gaps are always indicative. |
| 5 | ORB · MES/MNQ | Tradovate **demo** API (auth + md websocket), used only when all `TRADOVATE_*` vars are set | `TRADOVATE_USERNAME`, `TRADOVATE_PASSWORD`, `TRADOVATE_APP_ID`, `TRADOVATE_CID`, `TRADOVATE_SECRET` | The default is a **SIMULATED** accelerated session replay, labeled in the UI. All of its PnL goes to the SIM book. |
| 6 | Perp momentum | OKX swap candles (REST, closed bars only); execution on the freshest perp quote (Hyperliquid / Binance / Bybit / OKX websockets, REST fallback) | — | With no closed bars or no fresh quote it skips and logs why. It never trades on mock data. |
| 7 | Perp basis (cash and carry) | Spot books from OKX, Binance and Bybit spot websockets, plus perp books from all four venues | — | It needs a fresh spot book **and** a fresh perp book (15 s or less), otherwise it skips. |

More stages are added below as they land.

### 1. Funding arb

The desk goes long the perp on the venue paying the lowest funding and short where it is highest. Rates are normalized to hourly so the model works across intervals (Binance/Bybit 8h or 4h, OKX from `nextFundingTime − fundingTime`, Hyperliquid 1h).

A pair qualifies only if the funding spread over `FUNDING_HOLD_HOURS` beats all of the following costs by `FUNDING_MIN_NET_BPS`:
- 4 taker fills (open and close on both legs; per-venue fees in `server/lib/fees.js`)
- 4 slippage fills (half-spread plus square-root impact against depth)
- a basis-risk buffer (½ of the current mark-price basis plus 2 bp)

While a position is open, funding settles discretely at each venue's next settlement time. Legs are marked to market, so basis moves show up as PnL. The pair closes when the spread flips or after 72h.

### 2. Whale flow

- **Solana:** the Helius enhanced-transactions API polls the watched accounts every 15s. The defaults are the Raydium and Orca SOL-USDC pools, or set `HELIUS_WATCH_ADDRESSES`. Each transaction is classified from the fee payer's side: stables out and SOL in is a buy, the reverse is a sell, and anything else is a transfer sized by the larger leg. This samples the most recent 50 transactions per account per poll, so it is **not** a complete feed.
- **EVM (Ethereum, Base, Arbitrum):** `eth_getLogs` over each new block range collects USDC, USDT and WETH `Transfer` logs plus directional Uniswap v3 WETH/USDC `Swap` logs. The pool's `token0` is read on chain to orient the swap.
- **Signal:** this uses directional swaps only, never plain transfers. If net flow over 15 minutes reaches at least 2× `WHALE_MIN_USD` across at least 3 swaps, and at least 60% of it is one-sided, the desk opens a paper perp (SOL or ETH) on the freshest real quote. It uses 50% of the sleeve, a 1.2% take-profit, a 0.6% stop and a 90-minute time stop, with a 30-minute cooldown. Taker fee and slippage apply on both sides.
- Whale-follow edge is speculative. The tape logs every skip with its numbers.

### 3. 1% mode

This mode aims for about **1% net per completed cycle**, long spot only. It holds one position at a time on the full sleeve, so cycles compound, and it only trades top-quality trend pullbacks on **closed** 15m bars. Every gate below must pass:

| Gate | Rule |
|---|---|
| trend | EMA20 > EMA50, and EMA50 is rising over 8 bars |
| pullback | Price is within 0.6 ATR of EMA20, a recent low tagged EMA20, and price is above EMA50 |
| momentum | RSI14 is between 45 and 65 and rising |
| volatility | ATR is 0.25–1.5% of price |
| volume | The last 3 bars run at least 0.8× the 20-bar average |
| reward:risk | At least 1.5, with the stop below the 10-bar swing low |

The take-profit is set from `grossMoveForNet()`, so that after a 0.1% taker fee and modeled slippage on **both** sides the fill nets exactly `ONEPCT_TARGET_NET_PCT`. Exits are the stop or a 24h time stop, both of which can lose money. When nothing qualifies, it logs which gates failed and waits. Nothing forces a profit.

### 4. DEX gap scanner

The scanner checks three kinds of gap:

* **Solana cross-DEX.** Jupiter direct-route quotes for a `GAP_NOTIONAL_USD` buy (USDC→SOL) and sell (SOL→USDC) on Raydium, Raydium CLMM, Whirlpool and Meteora DLMM. Each quote returns the executable output amount with pool fees and price impact already included. The heatmap shows buying on the row DEX and selling on the column DEX, in bps. The diagonal is the round-trip cost on one DEX.
* **Solana triangular.** USDC→SOL→USDT→USDC on chained Jupiter quotes.
* **EVM (Ethereum, Base, Arbitrum).**
  * DexScreener WETH/USD-stable pool mid prices form an **indicative** matrix. It excludes pool fees and price impact, and an assumed `GAP_EVM_POOL_FEE_BPS` per leg is deducted.
  * A ParaSwap best-route round trip uses executable quote amounts.
  * Gas is `GAP_EVM_GAS_PER_SWAP × eth_gasPrice` per leg. On L2s the L1 data fee is **not** included, and the row says so.

The cost model is `EV = p·(gross − exec − tip) − (1−p)·exec`, with `p = GAP_P_SUCCESS` (default 0.35):

* Failed attempts still pay execution cost (base and priority fee, or gas).
* The Solana tip (`GAP_SOL_TIP_LAMPORTS`) is paid only when the attempt lands.
* A paper attempt happens only when a row is built from executable quotes, its EV is above `GAP_MIN_EV_USD`, and the gap persists for 2 consecutive scans.
* The landed or failed outcome is drawn with probability `p` and logged as *modeled*.

In practice, gaps between public quotes almost never survive costs. Expect skip logs, not fills.

### 5. Opening-range breakout (MES / MNQ)

* The opening range is the first `ORB_MINUTES` (15) one-minute bars after 09:30 ET.
* A 1-minute close outside the range enters long or short, at most one trade per symbol per session and none after 13:30 ET.
* The stop is the opposite side of the range and the target is `ORB_TARGET_R` × risk. Positions go flat at 15:55 ET.
* If the stop and the target both touch in one bar, the **stop** is assumed.
* Costs per contract are `ORB_FEE_PER_SIDE` (default $0.72) on each side plus 1 tick of slippage each way. MES is $5/pt and MNQ is $2/pt, with a 0.25 tick.
* The trade is skipped when one contract risks more than `ORB_MAX_RISK_PCT` of the sleeve, or when the range width is outside the configured band.
* **Default is SIMULATED.** The Tradovate adapter (`server/feeds/tradovate.js`) only authenticates against the *demo* environment, and only when username, password, app ID, CID and secret are all set. It has no order endpoint.
* Without those vars, or if demo auth or market data fails within 60s, the module runs an accelerated random-walk session (one bar every `TRADOVATE_SIM_BAR_MS`). It is labeled **SIMULATED** everywhere and books only to the SIM book.

### 6. Perp momentum (crypto-perp paper trading)

- **Signal:** on each new closed OKX swap bar (5m by default), the strategy goes long when the close breaks the prior 20-bar high and EMA20 is above EMA50. The short side is the mirror image.
- **Volatility band:** ATR% must sit between 0.10% and 2.5%. Outside that band it skips and logs `volatility too low` or `volatility too high`.
- **Exits:** stop at 1.5×ATR, target at 3×ATR, time stop after 6 h.
- **Cost check before entry:**
  - Round-trip cost = taker fee ×2 at the executing venue + modeled slippage ×2 (half spread + size impact).
  - The target must be at least **3× round-trip cost**, otherwise it skips and logs `target … < 3× round-trip cost`.
  - Expected funding over the max hold is also subtracted. When funding erases the edge it skips.
- **Funding while a position is open** is settled discretely at each venue's funding timestamp (`ledger.cashflow`), the same as the funding arb. It shows on the strategy's own PnL line.
- **Sizing:** risk-based. Notional = min(50% of sleeve, 1% of sleeve ÷ stop distance).
- **Execution:** on the venue the engine's best-quote picker returns, normally Hyperliquid over WS. The `via ws|rest` tag is logged on every fill.

### 7. Perp basis (cash and carry)

- **Trade:** buy spot at the ask and short the perp at the bid, choosing the best of spot ∈ {OKX, Binance, Bybit} × perp ∈ {HL, Binance, Bybit, OKX}.
- **Expected net (bps):** basis − exit target + expected funding over `BASIS_HOLD_H` − (spot fee + perp fee)×2 − 4×slippage.
  - Spot taker fee is 0.10%; perp fees are per venue.
- **Entry threshold:** `BASIS_MIN_NET_BPS` (5bp by default).
- **Exit:** when the basis is back at or under `BASIS_EXIT_BPS`, or at the time stop `BASIS_MAX_HOLD_H`. Funding is settled while the position is open.
- **What to expect:** on a normal day the majors trade within a few bp of spot. Four taker fees are about 30 to 35bp. So the strategy mostly **skips**, and it logs exactly by how much it missed (e.g. `best net −36.7bp < 5bp`). That outcome is correct, not a bug. Carry pays when funding and basis are elevated, or with maker or VIP fees, which this paper model does not assume.
- **Limits:**
  - Long spot / short perp only. No spot shorting or borrow is modeled.
  - Cross-venue carry is shown, but it ignores transfer time and the fact that collateral sits on two venues.

## Data path: websockets first, REST as the labelled fallback

| Venue / source | Transport | What it carries | Health row |
|---|---|---|---|
| Binance USD-M | WS `fstream.binance.com/public` + `/market` | book ticker, mark price, funding rate | `ws.binance` |
| Bybit linear | WS `stream.bybit.com/v5/public/linear` | tickers incl. bid/ask, mark, funding | `ws.bybit` |
| OKX | WS `ws.okx.com/ws/v5/public` | swap tickers, mark, funding, spot tickers | `ws.okx` |
| Hyperliquid | WS `api.hyperliquid.xyz/ws` | `bbo` + `activeAssetCtx` (mark, funding) | `ws.hyperliquid` |
| Binance / Bybit spot | WS (`data-stream.binance.vision`, `stream.bybit.com/v5/public/spot`) | top of book | `ws.binance-spot`, `ws.bybit-spot` |
| Helius (Solana) | WS `logsSubscribe` on watched pools → triggers enhanced-tx fetch | push trigger | `ws.helius` |
| EVM (ETH/Base/Arbitrum) | WS `newHeads` (env URL > Alchemy > Infura > publicnode) → triggers log scan | push trigger | `ws.<chain>` |
| Funding / candles / DEX quotes | REST polling | fallback + data with no public stream | `funding.*`, `candles.*`, `dex.*` |

Perp rows from websockets are merged into the same store as REST rows and tagged `transport: "ws"`; a REST poll never
overwrites a WS row younger than 15 s. Every feed reports **latency** (exchange event time → this box when the venue
stamps it, otherwise request round-trip) and **staleness**: a row with no update inside its `staleMs` turns `STALE`.
The server fans everything out to the browser over SSE (`/api/stream`).

## Providers: Settings → Data sources

The **⚙ Sources** button jumps to the Settings · Data sources panel. Each provider shows status
(`live`, `stale`, `mocked`, `missing key`, `down`, `not implemented`), median measured latency, what it unlocks, and a
**Connect** action listing the env var *names* to set (server-side `.env`) and the provider's signup page. The client gets
only names, a set/unset boolean, status and latency (`GET /api/providers`); values never leave the server process.

| Provider | Env var(s) | Signup | Unlocks |
|---|---|---|---|
| Helius | `HELIUS_API_KEY` | https://www.helius.dev | live Solana whale flow + WS triggers |
| Alchemy / Infura | `ALCHEMY_API_KEY` / `INFURA_API_KEY` | https://www.alchemy.com / https://www.infura.io | keyed EVM RPC + WS |
| QuickNode (or any RPC) | `EVM_RPC_URL_<CHAIN>`, `EVM_WS_URL_<CHAIN>` | https://www.quicknode.com | per-chain endpoint, highest priority |
| publicnode | none | https://www.publicnode.com | keyless EVM fallback (best effort) |
| Pyth (Hermes) | `PYTH_API_KEY` | https://pyth.network | oracle cross-check of venue marks (Hermes requires a key since 2026-08-26) |
| Jupiter | none (`JUPITER_API_BASE` optional) | https://jup.ag | Solana executable quotes for the gap scanner |
| Binance / Bybit / OKX / Hyperliquid | none | exchange sites | perps, funding, spot books |
| Tradovate | `TRADOVATE_USERNAME`, `_PASSWORD`, `_APP_ID`, `_CID`, `_SECRET` | https://www.tradovate.com | real MES/MNQ bars for ORB |
| Kaiko / Amberdata / CoinAPI / Tardis.dev | `KAIKO_API_KEY` / `AMBERDATA_API_KEY` / `COINAPI_KEY` / `TARDIS_API_KEY` | vendor sites | placeholders (no adapter yet) |

Pricing for paid tiers is not listed here: check current pricing on each provider's site.

### Adding a provider = one adapter file + one registry entry

1. Create `server/providers/adapters/<id>.js` that exports `create({ env, health, engine, entry })` and returns
   `{ start(), stop(), snapshot(), publicInfo?() }` (or `null`). Read keys from `env` here, register a health row, and call
   `health.ok(id, latencyMs)` / `health.fail(id, err)`.
2. Add one object to `server/providers/registry.js`.

```js
// server/providers/adapters/acme.js
module.exports.create = ({ env, health }) => {
  const key = env.ACME_API_KEY; health.register('acme.book', { label: 'Acme order books', group: 'premium', transport: 'ws', staleMs: 15000 });
  let ws;
  return {
    start() { if (!key) return; ws = new (require('../../lib/ws').WsClient)({ url: 'wss://stream.acme.example/v1?key=' + key, health, id: 'acme.book', onMessage: (t) => JSON.parse(t).ts }); ws.start(); },
    stop() { ws && ws.stop(); },
    snapshot: () => ({}),
  };
};
// server/providers/registry.js
{ id: 'acme', name: 'Acme Data', category: 'premium', adapter: 'acme', env: [{ name: 'ACME_API_KEY', required: true }],
  health: ['acme.book'], signup: 'https://acme.example', unlocks: ['Consolidated books'] },
```

The engine starts the adapter as feed `provider.acme`; the Data sources panel picks it up automatically. `npm test` checks
every registry entry (unique id, https signup URL, adapter file loads) and that no env value appears in the client view.

## D. Which feeds are fast enough for which strategy (plain language)

| Strategy | What it needs | What this repo uses | Good enough? |
|---|---|---|---|
| Funding arb | Funding rates change slowly (hourly to 8-hourly). Second-level data is plenty. | WS mark/funding plus REST every 30 s | **Yes.** Data speed is not the bottleneck; fees and venue risk are. |
| 1% mode | Decides on closed 15m candles | REST candles plus top of book | **Yes.** |
| Perp momentum | Decides on closed 5m bars and executes on a fresh quote | REST bars plus WS quotes | **Yes for paper.** Live trading would add a few hundred ms of order latency, which the slippage model only approximates. |
| Perp basis | Fresh spot and perp books at the same moment | WS on both, staleness guard of 15 s or less | **Mostly.** Real carry desks quote both legs within milliseconds. Here, a stale leg means a skip. |
| Whale flow | Sees transactions soon after they land | Helius WS `logsSubscribe` (Solana) and EVM `newHeads` WS, with REST/RPC polling as fallback | **WS is needed.** Polling public RPC is seconds late, and public endpoints rate-limit. |
| DEX gap / triangular scanning | Sub-second or same-block data and execution | Public quote APIs polled every ~20 s | **No, not for real edge.** Real gaps close in milliseconds to one block, and competitors run co-located nodes and private order flow. A paper scanner on public data **overstates** the edge. That is why this one models gas, tips and failure risk, and labels mid-price gaps INDICATIVE. Its PnL should be read as an upper bound. |
| ORB (MES/MNQ) | One-minute bars and a market-data WS during the cash open | Tradovate demo WS when configured, otherwise a SIMULATED replay | Real data needs a Tradovate API key (not provided here). |

**What you would need to upgrade** (check current pricing with each provider; prices change, so none are listed here):

- **Solana:** a paid Helius plan (higher rate limits; enhanced WebSockets / LaserStream gRPC), or a dedicated node from Helius, Triton or QuickNode.
- **EVM:** a paid Alchemy, Infura or QuickNode plan for reliable WS subscriptions, or your own Ethereum / Base / Arbitrum node. Public publicnode endpoints are best-effort.
- **CEX perps:**
  - Public WS is already real time.
  - Serious execution would mean API keys (not supported here: paper only), maker fee tiers, and hosting close to the matching engines. Binance and Bybit run on AWS Tokyo / Singapore; check each venue's docs for current locations.
- **Gap / MEV-style arb:** co-located or bare-metal nodes, private relays / bundles (Jito on Solana, Flashbots-style builders on Ethereum), and a latency model in the backtest. Without those, treat scanner output as research only.
- **Oracle prices:** Pyth Hermes now needs `PYTH_API_KEY`; see pyth.network.

## Risk gate

- **Daily loss halt** (`RISK_DAILY_LOSS_PCT`) blocks new entries until the next UTC day.
- **Drawdown breaker** (`RISK_MAX_DRAWDOWN_PCT`, measured from peak equity) latches until you press *Reset breaker*.
- **Manual HALT** is in the top bar.

You can edit the limits live. When the gate is closed, strategies keep managing their open positions but log `risk gate: …` skips instead of opening new ones.

## Environment variables

See [`.env.example`](.env.example). Every variable is listed there with its default. Secrets are read in `server/config.js`. `publicFlags()` exposes only booleans such as `heliusConfigured`, and a test asserts that no secret value leaks into the client payload. `.env` is gitignored.

## Screenshots

`docs/screenshots/`: desktop at 1440 wide and mobile at 390 wide, captured with headless Chromium.

## Layout

```
server/server.js          HTTP + SSE + static, binds 127.0.0.1
server/engine.js          feeds -> strategies -> paper broker -> ledger -> risk gates
server/lib/fees.js        fee / slippage / funding / tx-cost / EV math (unit tested)
server/lib/risk.js        RiskGate (unit tested)
server/lib/broker.js      PaperBroker + disabled LiveBroker stub
server/feeds/*.js         upstream adapters, each reports into the health registry
server/strategies/*.js    one module per strategy (arm/disarm, own PnL, skip log)
public/                   terminal UI (vanilla JS, canvas charts)
public/demo/              original simulator (Demo mode only)
test/                     node:test suites
```

## Known limits

- Binance perp funding interval is assumed to be 8 h because REST `fundingInfo` is geo-blocked from the test box. Symbols with 4 h intervals would show a halved hourly rate.
- Pyth Hermes requires an API key (since 2026-08). The Pyth adapter is idle without `PYTH_API_KEY`, and it has not been tested with a key.

- From some regions Binance returns HTTP 451 and Bybit returns 403. They then show NO DATA and the arb runs on the venues that answer.
- Funding arb fills are modeled at the observed top of book plus impact. Real queue position, partial fills and venue downtime are not modeled.
- Gap scanner: public Jupiter and ParaSwap quotes are rate-limited, so some cells can be blank (·) on a given scan. Mid prices from thinly traded or stale DexScreener pools can show large gaps that are not executable, which is why they are indicative only.
