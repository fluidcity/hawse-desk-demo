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
| 8–10 | Sports betting: +EV line shopping, spread signal, arbs (middles are alerts only) | — (there is no free keyless odds feed) | `ODDS_API_KEY` (The Odds API) | With no key, or if the first request fails, a labeled **MOCK** odds market runs (synthetic teams and books named `mockbook_*`). Every bet on it is tagged SIMULATED and booked to the SIM book. |

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

### 8–10. Sports betting (paper only, alerts only)

> **Real-money bet placement does not exist in this app.** `server/betting/live.js` is a stub whose `placeBet` / `cancelBet` / `login` always throw `LIVE_BETTING_DISABLED`, and a test checks that. The desk only shows opportunities and records **paper** bets.
>
> **Sportsbook terms of service and state laws vary.** Sports betting is not legal everywhere, and many books restrict or close accounts that line-shop, arb or consistently beat the close. Check your jurisdiction and each book's terms yourself.
>
> **Paper results are optimistic.** They ignore stake limits, account restrictions or bans, bet rejections, and line movement between the quote and placement (odds are polled, so a quoted price may already be gone). Treat paper PnL as an upper bound, and judge the strategies mainly by closing-line value (CLV).

**Data.** The Odds API (`ODDS_API_KEY`, https://the-odds-api.com) gives `/v4/sports/{sport}/odds` for `ODDS_SPORTS` × `ODDS_REGIONS` × `ODDS_MARKETS` (h2h, spreads, totals), plus `/scores` for settlement. The provider's docs say a live odds request costs **markets × regions** credits, and the remaining quota comes back in `x-requests-remaining` / `x-requests-used` / `x-requests-last` headers, which the panel shows. So the default poll is slow (`ODDS_POLL_SEC=900`); check current plan quotas and pricing with the provider before shortening it. The key is read only on the server and is redacted from every error message and log line. With no key, a **MOCK** market runs instead. It has 6 synthetic books with 4–6.5% vig, about 12% stale or lagging quotes, a random walk before kickoff and a simulated final score. It is there to exercise the pipeline, and its arb and +EV frequency is **much higher than in real markets**.

**Math** (`server/betting/math.js`, unit tested):
- **No-vig fair price:** multiplicative (divide each implied probability by the overround) or power (`BET_FAIR_METHOD=power`, which shifts more of the margin onto longshots).
- **Consensus:** the median no-vig probability across books. For +EV, each book's price is compared with the consensus of the **other** books, so a book never confirms its own price. At least `BET_MIN_BOOKS` books are required.
- **EV** per unit = p·(d−1) − (1−p). A bet is taken when EV ≥ `BET_MIN_EDGE_PCT` (and odds ≤ `BET_MAX_ODDS_DEC`).
- **Fractional Kelly:** f* = (p·d − 1)/(d − 1), times `BET_KELLY_FRACTION` (¼ by default), capped at `BET_MAX_STAKE_PCT` of the sleeve bankroll.
- **Exposure caps:** per bet `BET_MAX_STAKE_PCT`, per event `BET_MAX_EVENT_PCT`, and total open `BET_MAX_OPEN_PCT`. Every refusal is logged as a skip with its reason.
- **Arbs:** take the best price per outcome across ≥2 different books. If Σ 1/dᵢ < 1 and the margin is ≥ `BET_MIN_ARB_PCT`, the legs are staked for an equal payout (`BET_ARB_STAKE_PCT` of the bankroll in total) and booked as **one** grouped ledger entry once every leg settles.
- **Middles:** Over L at one book plus Under H > L at another, or opposite spreads whose lines overlap. They are shown as **alerts only and never staked**, with "cost if only one side wins" and "profit if both win".
- **Spread signal:** a book hanging a number ≥ `BET_MIN_POINT_EDGE` points better than the most-quoted line. Its win probability is assumed to be the consensus fair probability plus `BET_POINT_VALUE_PCT` percentage points per point. **That is an assumption, not a measured value** (real values depend on the sport and on key numbers), and the UI says so.
- **CLV:** at kickoff the last quote of the same book, market and line is de-vigged across books. CLV % = taken decimal / closing fair decimal − 1. If the line moved and no close was quoted, the bet shows "n/a". Average CLV and the share of bets that beat the close are reported separately for real and simulated bets.

**Ledger.** Bets are graded from scores (pushes return the stake) and booked to the strategy's own PnL, the attribution table and the unified equity curve, with real and simulated bets in separate books. No commissions are charged; the vig is already in the prices.

**Lab.** There are templates for +EV, spread signal and arb (each with ToS, limits and line-movement risk notes). The JSON schema has `betting_ev`, `betting_spread` and `betting_arb` kinds with `market.sport`, `betMarkets`, `regions`, `kellyFraction`, `maxStakePct`, `maxEventPct` and `maxOpenPct`. Text import recognizes "+EV", "line shopping", "no-vig", "sure bets", "middles", "stale spreads", sport names, "quarter Kelly" / "N% Kelly", edge %, min books and per-bet / per-game caps. It reports parlays, teasers, props, live betting, futures, bonuses and automated real-money betting as **not mappable**. Betting configs **cannot be backtested here**: The Odds API documents historical odds snapshots as paid-plan only (check current pricing with the provider), and no free source exists. So they stay `unverified`, and you should judge them by live paper CLV on the desk.

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
| The Odds API | `ODDS_API_KEY` (`ODDS_SPORTS`, `ODDS_REGIONS` optional) | https://the-odds-api.com | live multi-book odds + scores for the betting strategies |
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
| Sports betting | Odds that are current when the bet is placed | The Odds API REST, polled every 15 min by default to save quota | **No for stale-line or arb edges.** Those windows often last seconds to minutes, so a 15-min poll mostly sees lines that already moved. Paper results overstate them. +EV vs consensus and CLV tracking are fine at this cadence. A faster or streaming odds feed is a paid upgrade (check current pricing with the provider). |

**What you would need to upgrade** (check current pricing with each provider; prices change, so none are listed here):

- **Solana:** a paid Helius plan (higher rate limits; enhanced WebSockets / LaserStream gRPC), or a dedicated node from Helius, Triton or QuickNode.
- **EVM:** a paid Alchemy, Infura or QuickNode plan for reliable WS subscriptions, or your own Ethereum / Base / Arbitrum node. Public publicnode endpoints are best-effort.
- **CEX perps:**
  - Public WS is already real time.
  - Serious execution would mean API keys (not supported here: paper only), maker fee tiers, and hosting close to the matching engines. Binance and Bybit run on AWS Tokyo / Singapore; check each venue's docs for current locations.
- **Gap / MEV-style arb:** co-located or bare-metal nodes, private relays / bundles (Jito on Solana, Flashbots-style builders on Ethereum), and a latency model in the backtest. Without those, treat scanner output as research only.
- **Oracle prices:** Pyth Hermes now needs `PYTH_API_KEY`; see pyth.network.

## Strategy lab: editor, templates, backtests, side-by-side paper runs

The **Strategy lab** card (below the desk) lets you write strategies as data, test them on real public history, and paper-run several next to each other. **Lab results live in their own books.** They are never added to the desk's equity curve or attribution.

**Schema.** Every strategy is one JSON object that follows [`schema/strategy.schema.json`](schema/strategy.schema.json) (JSON Schema draft 2020-12). The running server also serves it at `/schema/strategy.schema.json`. Unknown fields are rejected.

| field | meaning |
|---|---|
| `schemaVersion` | always `1` |
| `name`, `description` | free text |
| `kind` | `funding_arb`, `basis_carry`, `ma_cross`, `bollinger_revert`, `orb`, `dca_grid`, `volatility_breakout`, or the paper-only betting kinds `betting_ev`, `betting_spread`, `betting_arb` |
| `market` | trading: `{symbol, bar: 1m\|5m\|15m\|1H\|4H\|1D, venue: okx, instrument: swap\|spot}`; betting: `{sport, betMarkets: [h2h\|spreads\|totals], regions, books}` |
| `params` | per-kind fields; the schema's `$defs` list them (for example `ma_cross`: `fast`, `slow`, `maType`) |
| `entry` | `{allowShort}` |
| `exit` | `{stopPct, takePct, maxHoldBars}` |
| `risk` | trading: `{positionPct, capitalUsd, maxDrawdownPct}`; betting: `{kellyFraction, maxStakePct, maxEventPct, maxOpenPct, capitalUsd}` (no `exit` / `costs`) |
| `costs` | `{feeRate, slippageBps}`, charged on every fill |
| `riskNotes`, `source`, `status`, `id`, `version` | managed by the lab; `status` is `unverified` or `backtested` |

The validator (`server/lab/validate.js`) has zero dependencies. It implements only the schema keywords the file uses and refuses to load if the schema starts using one it doesn't know. On top of the schema it runs semantic checks: `fast < slow`, ORB needs an intraday bar, a grid is spot-only, and basis is long-carry only.

**Versioning.** Saving an existing id creates the next version, and every earlier version is kept. Any edit resets the status to `unverified`. *Duplicate* forks a version into a new id. Configs are stored in `data/lab/strategies.json`, which is gitignored and written atomically.

**Templates (10).** Funding-rate arbitrage, cash-and-carry basis, MA crossover, Bollinger mean reversion, opening-range breakout, DCA/grid, volatility breakout, and the betting templates +EV line shopping, spread signal and sports arb. Each comes with a plain-language description and risk notes. None of them makes a performance claim.

**Backtest semantics** (`server/lab/backtest.js`, deterministic):
- Data is public OKX candles: `history-candles`, about 1000 closed bars.
- Perps also replay OKX funding-rate history; if none is available, the result says "funding not modeled".
- A signal is taken on a bar's close and filled at the next bar's open, with slippage applied.
- Each fill pays the configured fee.
- If one bar touches both the stop and the target, the **stop wins**.
- The report shows net, return, max drawdown, trades (W/L), fees, slippage, funding, exposure, buy-and-hold over the same window and an equity curve.

Limits:
- No order book, partial fills, liquidation or funding-interval changes.
- Grid lots are equal-sized spot buys.
- Betting kinds return **"not supported"** (no free historical odds) and cannot start a lab paper run; the desk's live betting strategies are their paper run.
- `funding_arb` returns **"not supported"**, because there is no single public multi-venue funding history. Evaluate it as a live paper run on the desk instead.
- Past bars are not a forecast.

**Forward paper runs.** *Start paper run* replays the same rules on fresh closed OKX bars every 60 s, with entries allowed only after the start time. Several runs show side by side in the *Paper runs* tab.

**Import, which is always `unverified` until you backtest it here:**
- **JSON:** paste or upload a strategy object. `id`, `version`, `status`, `source` and any `performance`, `results`, `pnl`, `winRate` or `returns` fields are dropped, and the drop is reported as a warning. A missing `schemaVersion` is assumed to be 1, also with a warning. Invalid input returns every validation error.
- **Plain text:** `server/lab/text-import.js` maps a description to a config with **deterministic keyword rules**, not an LLM.
  - Recognized: strategy type, symbol or alias, timeframe, MA periods and type, Bollinger period and std, ORB minutes and HH:MM UTC, grid spacing and levels, ATR multiple, stop, target, max hold, position %, capital $.
  - Not mappable: RSI, MACD, leverage, trailing stops, sentiment and similar. These are listed under "could not map" and left at the template defaults.
  - Performance claims ("made 300% last year", "guaranteed") are ignored with a warning.
  - If no strategy type is found, the import fails and lists the supported types.

**ReelRipper → candidate JSON.** A transcript from ReelRipper (or any video or post about a strategy) can be turned into candidate JSON by an LLM outside this app: give the LLM the schema file and the transcript and ask for one object. Then paste that object into *Import → Import JSON*. It still lands `unverified`, any performance numbers in it are discarded, and the validator shows exactly what doesn't fit. You can also paste the transcript as-is into *Import text*, and the deterministic mapper will show what it understood.

**API:**
- `GET /api/lab` returns templates, configs and runs.
- `GET /api/lab/configs/:id[?v=N]`
- `GET /api/lab/configs/:id/export[?v=N]`
- `POST /api/lab/configs` with `{config}` or `{fromTemplate}`
- `POST /api/lab/configs/:id/duplicate|backtest|run|delete` (`backtest` takes `{version, limit<=1500}`; `run` takes `{on:false}` to stop)
- `POST /api/lab/import` with `{json}` or `{text}`

## Betting module: rules → signals → printable slips (Stage 10)

> **Paper / manual only.** The desk never places a bet. A rule raises a **signal**. You review it, and if you want to act on it you print or export a **slip** and place the bet yourself on Kalshi, Polymarket or a sportsbook. The direct venue links are **disabled interfaces**.

**Module boundary.** Everything for sports betting lives in `server/betting/` (data layer, rules engine, signals, slips, venue adapters, strategies) and `public/betting/` (UI + CSS). It is written so it can be split out as its own app later.
- Server files require only Node built-ins and other files inside `server/betting/`. A test (`module boundary`) fails if anything reaches outside.
- The host (`server/modules.js`) calls `mount(host, { Strategy })` with a small contract: `host.cfg.betting`, `addFeed`, `addStrategy`, `health`, `tape`, `ledger`. The module adds:
  - `host.routes[]`: `{ prefix, handle(method, path, readBody) }`. `server/server.js` loops over these.
  - `host.importers[]`: `{ id, canImport, importJson, importText }`. The strategy lab's import endpoint hands betting JSON/text to these.
  - `host.placeLiveBet`: always throws.
- The client module talks to the app only through `window.HAWSE.onState` (an array of callbacks that receive each SSE state) and its own `/api/betting/*` endpoints. Its data is `state.feeds.betdesk`.

**Flow.**
1. **Rules** (`hawse.betRule/1`). A rule has a name, `match: all|any`, `cooldownMin`, `enabled` and `conditions: [{ type, params, negate? }]`. You can add one from 6 templates (all start **disabled**), write it as JSON, or import it. Rules are saved to `BET_RULES_FILE` (default `data/betting/rules.json`, gitignored; `''` = in-memory only). Fields that would mean auto-placing (`autoPlace`, `autoBet`, `placeOrders`, `live`, `execute`, `venue`, `orderSize`) are **rejected**. Performance claims (`winRate`, `roi`, `record`, `pnl`, …) are **dropped** with a warning.
2. **Scanner.** Every `BET_SCAN_MS` (5 s) each enabled rule is checked against every upcoming game and every quoted line (live lines from the odds feed and the line history since first seen). Games that already started are skipped.
3. **Signals.** When a rule matches, a signal is raised with the price, book, no-vig fair price, EV and a "why it matched" list. Statuses are `new → reviewed | slipped | dismissed`, and signals expire at kickoff. There is **no "placed" status**. A rule + side + line can't re-signal inside its cooldown. Signals also go to the tape as `SIGNAL`. A signal built from MOCK odds or MOCK stats is tagged **SIM**, with the reasons listed.
4. **Slip** (`hawse.betSlip/1`). This is a printable paper slip with: pick, game, start time, the price seen and book, fair price, edge, **worst price that still has edge**, the prediction-market equivalent (YES ≤ N¢ before fees), a stake idea (quarter-Kelly capped at the rule's `maxStakePct`, as a % of `BET_SLIP_BANKROLL_USD` paper bankroll), a checklist and a disclaimer. You can Print (print CSS shows only the slip), Copy text, or Download .txt / .json. Simulated slips carry a red **SIMULATED** watermark.

**Signal types (registry).** There are 17 built-ins: `sport_in, team_matches, starts_within, market_is, side_is, odds_between, line_between, ev_at_least, books_at_least, line_moved, off_consensus_line, key_number, arb_available, back_to_back, rest_advantage, key_player_out, player_form`. Every type declares typed params (number/integer/string/enum/list/bool, min/max), and every rule is validated against them. `GET /api/betting/registry` lists them.
- **Custom types** are pure data, so no code is ever loaded. A custom type is a named composition of existing types with `"$param"` placeholders, and it can nest up to a depth limit. They come in a pack:
  ```json
  { "schema": "hawse.signalTypes/1", "source": { "type": "reelripper", "note": "…" },
    "types": [ { "id": "fade_tired_favorite", "label": "…", "params": { "minRestDiff": { "type": "integer", "default": 1 } },
                 "conditions": [ { "type": "back_to_back", "params": { "team": "opponent" } },
                                 { "type": "rest_advantage", "params": { "minDays": "$minRestDiff" } } ] } ] }
  ```
- **ReelRipper path.** Extract types/rules from transcripts into `hawse.signalTypes/1` or `hawse.betRule(s)/1` JSON, then POST them to `/api/betting/import`, paste them into the desk's Import tab, or paste them into the **strategy lab import** box (the lab sends betting schemas to the module and says "Routed to the betting module"). Plain text also works: the lab's *Import text as betting rule* button, or `{ text }` on `/api/betting/import`, maps phrases with a fixed table into a **disabled draft** and lists mapped and unmapped phrases. Built-in types can't be replaced.

**Stats are MOCK.** No real team/player stats provider is wired up (`BET_STATS_MOCK=true`). The stats-based types (`back_to_back`, `rest_advantage`, `key_player_out`, `player_form`) use labeled synthetic schedules/injuries, so **every signal that uses them is SIM-tagged**. With no `ODDS_API_KEY` the odds are MOCK too.

**Venue adapters (disabled).** `server/betting/venues/index.js` defines `VenueAdapter` with `connect, getBalance, getPositions, findMarkets, previewOrder, placeOrder, cancelOrder` for **Kalshi** and **Polymarket**. Every method throws `VenueLinkDisabledError` (`VENUE_LINK_DISABLED`), and `POST /api/betting/venues/:venue/:method` returns 403. A test checks every method, and that the adapter source reads no `process.env` and makes no network calls. A future enabled version must use your own account, read credentials only from server env vars, and need a **per-order approval** (`checkApproval` requires an approval from the user, tied to the exact order hash, expiring within 2 minutes; single-use tracking is left to that future change). The env var names are documented here only (no values, unused today):
- Kalshi: `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, `KALSHI_ENV`
- Polymarket: `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`

**Endpoints.**
- `GET /api/betting` (desk snapshot + full rules), `/api/betting/registry`, `/api/betting/templates`, `/api/betting/signal-types/export`, `/api/betting/venues`
- `POST /api/betting/rules` `{rule}` or `{fromTemplate}`; `GET|POST /api/betting/rules/:id`; `POST /api/betting/rules/:id/enable` `{on}`; `POST /api/betting/rules/:id/delete`; `GET /api/betting/rules/:id/export`
- `POST /api/betting/import` `{json}` or `{text}`; `POST /api/betting/scan`
- `POST /api/betting/signals/:id/status` `{status}`; `GET /api/betting/signals/:id/slip|slip.txt|slip.json`
- `POST /api/betting/venues/:venue/:method` → always 403

**Tests.** `test/betting-rules.test.js` (15 suites) covers: registry, pack import (placeholders, nesting, invalid packs), validation (forbidden fields, bad params, dropped claims), scanning (SIM tagging, upcoming only, disabled rules), stats reasons, line movement, signal lifecycle and cooldown, slip math (+130, cents, 2% cap) and watermark, venue refusal, text import, persistence, routes, host/lab wiring and the module boundary.

Screenshots: `docs/screenshots/stage10-{signals,rules,import,venues,slip}-{desktop,mobile}.png` and `stage10-slip-print-preview.png` (print media). For the element crops the sticky top bar was unpinned so it doesn't cover the panel.

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
server/betting/           self-contained betting module: data/ (odds, MOCK stats, line history), rules/ (registry,
                          engine, templates, text), signals, slip, venues/ (disabled), strategies, routes, index (mount)
public/betting/           betting desk UI (rules, signals, import, venue links, printable slip)
server/lab/               strategy lab: schema validator, templates, backtester, text import
public/                   terminal UI (vanilla JS, canvas charts)
public/demo/              original simulator (Demo mode only)
test/                     node:test suites
```

## Known limits

- Betting rules desk: team/player stats are MOCK (no provider wired), so stats-based signals are always SIM. Kalshi/Polymarket adapters are interface-only and refuse. Print and clipboard were checked only in headless Chromium (print media emulation); a real print dialog was not exercised.
- Sports betting: The Odds API live path has been written against the documented v4 API and unit tested with fixtures, but it has **not** been exercised against the live API: no `ODDS_API_KEY` was set on the build box. Mock-market arb and +EV frequency is unrealistically high.

- Binance perp funding interval is assumed to be 8 h because REST `fundingInfo` is geo-blocked from the test box. Symbols with 4 h intervals would show a halved hourly rate.
- Pyth Hermes requires an API key (since 2026-08). The Pyth adapter is idle without `PYTH_API_KEY`, and it has not been tested with a key.

- From some regions Binance returns HTTP 451 and Bybit returns 403. They then show NO DATA and the arb runs on the venues that answer.
- Funding arb fills are modeled at the observed top of book plus impact. Real queue position, partial fills and venue downtime are not modeled.
- Gap scanner: public Jupiter and ParaSwap quotes are rate-limited, so some cells can be blank (·) on a given scan. Mid prices from thinly traded or stale DexScreener pools can show large gaps that are not executable, which is why they are indicative only.
