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
| 4 | DEX gap scanner | Jupiter per-DEX quotes (`api.jup.ag`, keyless 0.5 rps or optional free `JUPITER_API_KEY` at 1 rps) (Solana), DexScreener pool prices, ParaSwap quotes, `eth_gasPrice` via public RPC (Ethereum, Base, Arbitrum) | optional `JUPITER_API_KEY` / `JUPITER_API_BASE`, EVM RPC vars | If Jupiter is down, Solana falls back to DexScreener mid prices, labeled **INDICATIVE**, which are never traded. EVM mid-price gaps are always indicative. |
| 5 | ORB · MES/MNQ | Tradovate **demo** API (auth + md websocket), used only when all `TRADOVATE_*` vars are set | `TRADOVATE_USERNAME`, `TRADOVATE_PASSWORD`, `TRADOVATE_APP_ID`, `TRADOVATE_CID`, `TRADOVATE_SECRET` | The default is a **SIMULATED** accelerated session replay, labeled in the UI. All of its PnL goes to the SIM book. |
| 6 | Perp momentum | OKX swap candles (REST, closed bars only); execution on the freshest perp quote (Hyperliquid / Binance / Bybit / OKX websockets, REST fallback) | — | With no closed bars or no fresh quote it skips and logs why. It never trades on mock data. |
| 7 | Perp basis (cash and carry) | Spot books from OKX, Binance and Bybit spot websockets, plus perp books from all four venues | — | It needs a fresh spot book **and** a fresh perp book (15 s or less), otherwise it skips. |
| 8–10 | Sports betting: +EV line shopping, spread signal, arbs (middles are alerts only) | — (there is no free keyless odds feed) | `ODDS_API_KEY` (The Odds API) | With no key, or if the first request fails, a labeled **MOCK** odds market runs (synthetic teams and books named `mockbook_*`). Every bet on it is tagged SIMULATED and booked to the SIM book. |

More stages are added below as they land.

### 1. Funding arb

The desk goes long the perp on the venue paying the lowest funding and short where it is highest. Rates are normalized to hourly so the model works across intervals (Binance/Bybit 8h or 4h, OKX from `nextFundingTime − fundingTime`, Hyperliquid 1h).

A pair qualifies only if the funding spread over `FUNDING_HOLD_HOURS` beats all of the following costs by `FUNDING_MIN_NET_BPS`:
- 4 taker fills (open and close on both legs; per-venue fees in `server/lib/fees.js`, base tier, **re-verified 2026-10-29** against each venue's fee page: Hyperliquid 0.045% perp / 0.07% spot, Bybit 0.055% / 0.10%, Binance 0.05% / 0.10%, OKX 0.05% / 0.10%. `FEES_VERIFIED` and `FEE_SOURCES` in that file carry the date and URLs, and every fee-dependent explainer prints the date)
- 4 slippage fills (half-spread plus square-root impact against depth)
- a basis-risk buffer (½ of the current mark-price basis plus 2 bp)

While a position is open, funding settles discretely at each venue's next settlement time. Legs are marked to market, so basis moves show up as PnL. 

**v2 rules (batch-1 H2).** On top of the cost check above, v2 adds:
- **Persistence.** A "funding observation" is one sampled rate per venue, at most one per `FUNDING_OBS_SEC` (default 900 s), fed from both REST polls and websockets. The spread must have been positive for the last `FUNDING_PERSIST_PRINTS` (3) observations.
- **Forecast.** Hyperliquid's public `predictedFundings` endpoint (one POST per poll, no key) gives the next predicted rate for Hyperliquid, Binance and Bybit. OKX uses its current (next-period) rate. A predicted spread ≤ 0 blocks entry; a missing forecast fails closed when `FUNDING_USE_PREDICTED=true`.
- **APR and basis gates.** Net APR (after all costs, on 2× notional capital) must be ≥ `FUNDING_MIN_APR` (10%). The entry mark-price basis between the legs must be ≤ `FUNDING_MAX_ENTRY_BASIS_BPS` (15 bp).
- **Liquidity cap.** Size per leg ≤ 0.05% of the thinner venue's 24h notional volume, split over two legs.
- **Universe.** The configured symbols plus the top `FUNDING_HL_TOP_OI` (20) Hyperliquid perps by open interest × mark (delisted and wrapped names skipped).
- **Cash & carry mode** (`CARRY_ENABLED`, default on). Long spot / short perp on the same venue (OKX, Binance, Bybit; Hyperliquid spot is skipped because of its wrapped names). Spot books come from the spot websockets, else public REST (`server/feeds/spot.js`, every `SPOT_POLL_MS`). Spot taker fees apply. It must clear `CARRY_MIN_NET_BPS` (15) over `CARRY_HOLD_HOURS` (72). No entry-basis gate, but the basis stop applies.
- **Exits.** Spread negative for `FUNDING_FLIP_PRINTS` (2) consecutive observations; predicted next spread negative; mark-basis move beyond `FUNDING_BASIS_STOP_BPS` (40) against the pair (counted as a stop); max hold 72 h (carry: `CARRY_HOLD_HOURS`). A pair whose quotes stay stale for 30 min is force-closed at the last mark with 2× slippage.
- **One owner per symbol.** Funding Arb and Perp Basis never hold the same symbol at the same time.
- **Scoreboard.** Every closed pair records expected vs realized net. The card shows realized/expected ratio, time-weighted net APR, max drawdown, worst pair loss, stop rate and the batch-1 verdict (pass after ≥ 30 pairs and ≥ 21 days if ratio ≥ 0.6, APR ≥ 8%, worst pair ≤ 0.5%, DD < 1.5%; fail if ratio < 0.3 or APR < 3%). It persists in `data/funding/scoreboard.json` (gitignored).
- **Shadows (not booked).** A v2 shadow and a naive v1 control (`FUNDING_SHADOW_V1`) run on the same real quotes whether or not the strategy is armed. They accrue funding continuously (an approximation, labeled as such) and never touch desk equity.

Real-data run (2026-10-29, public endpoints only): 22 symbols, OKX + Hyperliquid by REST and Binance + Bybit by websocket (their REST hosts return 451/403 from the build box). No pair or carry candidate cleared costs; the best perp pair was −21.9 bp over 24 h. The scoreboard is empty until real paper pairs close. Screenshots: `docs/screenshots/h2-funding-*.png`.

### 2. Whale flow

- **Solana (Helius): OFF by default.** Unless `WHALES_ENABLED=true`, the Solana feed is labelled **DEMO/MOCK** and no Helius or inbox call is made. When enabled, live data arrives through the **HAWSE webhook inbox**: one Helius *enhanced* webhook (1 credit per delivered event) pushes to a Cloudflare Worker (`<HAWSE_WEBHOOK_URL>/helius`), and the desk **polls** the Worker's `GET /events` every `INBOX_POLL_SEC` (15–60 s, default 30; polling costs no Helius credits). If `HAWSE_WEBHOOK_URL` / `HAWSE_READ_TOKEN` are missing, the feed falls back to labelled MOCK with the note **"inbox not configured"**. The desk watches only the webhook's accounts (`HELIUS_WATCH_ADDRESSES`, else `FOLLOW_WALLETS_SOL`, else the verified proposed list in `server/feeds/helius-watch.js`). The local `/hooks/helius` receiver, its tunnel, the Parsed Events poll and the old 15 s Enhanced-Tx loop (about 1.15M credits/day) were all removed. Each transaction is classified from the fee payer's side: stables out and SOL in is a buy, the reverse is a sell, and anything else is a transfer sized by the larger leg. See **Helius credits and the HAWSE inbox** below.
- **EVM (Ethereum, Base, Arbitrum):** `eth_getLogs` over each new block range collects USDC, USDT and WETH `Transfer` logs plus directional Uniswap v3 WETH/USDC `Swap` logs. The pool's `token0` is read on chain to orient the swap.
- **Signal:** this uses directional swaps only, never plain transfers. If net flow over 15 minutes reaches at least 2× `WHALE_MIN_USD` across at least 3 swaps, and at least 60% of it is one-sided, the desk opens a paper perp (SOL or ETH) on the freshest real quote. It uses 50% of the sleeve, a 1.2% take-profit, a 0.6% stop and a 90-minute time stop, with a 30-minute cooldown. Taker fee and slippage apply on both sides.
- Whale-follow edge is speculative. The tape logs every skip with its numbers.

#### Wallet follow v2 (batch-1 H3): tracked wallets vs controls

This replaces the "any big transaction" idea with specific wallets that have a track record, and it scores the follow against two controls.

- **Watchlist.** `scripts/score-wallets.js` is run by hand, roughly weekly. It scores Hyperliquid wallets from public `userFillsByTime` data (free, no key) over 30 days. To be kept, a wallet needs at least 20 closed trades, positive realized PnL after fees, no single trade above 40% of the PnL, and a median hold above 30 minutes, which keeps out HFT and market makers. Wallets are ranked by PnL ÷ σ(daily PnL) and the top 20 are kept in `data/watchlist.json` (gitignored). Each wallet keeps the date it was first added, and **fills before that add date never count**, so there is no look-ahead. You can also add addresses directly with `FOLLOW_WALLETS_HL`; these are dated "now". Solana wallets (`FOLLOW_WALLETS_SOL`) ride the existing Helius whale feed, which is off by default. The script does **not** score Solana wallets, because that would spend Helius credits.
- **Feed.** Hyperliquid `userFills` is polled one wallet per slot, so each wallet is polled once per `FOLLOW_HL_POLL_MS` (30 s by default, minimum 10 s). It is public and free. The feed groups fills by order and labels each one open, increase, reduce or flip from `startPosition`. With no wallets it makes no calls and shows NO DATA. There is no mock generator.
- **Entry.** The minimum is ≥ $50k on Hyperliquid or ≥ $25k on Solana (SOL↔stable swaps only). The desk waits a realistic latency delay first: 20 s on Hyperliquid, 10 s on Solana. It then fills at the quote *at that time*, plus taker fee and slippage. It skips the trade if the price already moved > 0.5% in the wallet's direction. Limits: at most 3 follows at once and 1 per asset. Size is min(25% of the sleeve, 0.05% of the 24 h volume).
- **Exit.** A mirror exit fires when the wallet cuts ≥ 50%, and a fill on the opposite side also closes. Otherwise TP 2% / SL 1% / time stop 6 h (Hyperliquid) or 2 h (Solana).
- **Controls (SIM-booked).** Every follow also opens a **random-direction** trade with the same TP and SL, and a **buy-and-hold** trade on the same asset and window. Both are booked to the SIM book only and never mixed with real results. A random *short* on Solana spot is skipped and recorded as missing.
- **Scoreboard.** This is per wallet and overall. It shows net % per follow, a bootstrap 95% CI, hit rate, the random and hold controls, and counterfactual delays of 0 s, the configured delay and 60 s. **Pass** after ≥ 100 signals needs the CI above 0 and ≥ 0.3%/trade over random. **Fail** comes after 200 signals with the CI touching 0, or when the edge disappears at a 60 s delay. The data is saved to `data/follow/scoreboard.json`.

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

**Data.** The Odds API (`ODDS_API_KEY`, https://the-odds-api.com). A live `/odds` request costs **markets × regions** credits, and an explicit `bookmakers=` list of up to 10 books counts as one region. `/events` and `/sports` are free, and `/scores` with `daysFrom` costs 2. Defaults are sized for the **free 500-credit plan**: `basketball_nba`, `h2h`, 10 books including Pinnacle (1 credit/snapshot). Odds are fetched on a **scheduled snapshot** plan, not an interval: the free `/events` slate is refreshed every 3 h, and snapshots run at T-360/60/10 min before each game. Targets within 15 min are merged into one call, and nothing is scheduled after kickoff. Results are cached on disk (`data/odds-cache.json`, TTL 900 s, key never stored). A hard monthly guard (`ODDS_MONTHLY_BUDGET`, default 450) paces spend per day. Under 15% left, only closing snapshots run. The remaining quota is read from the `x-requests-remaining` / `x-requests-used` / `x-requests-last` headers and shown in the desk. At 0 (or on a quota 401/429), polling **stops** and the desk shows **QUOTA EXHAUSTED**. There is never an automatic key switch: `ODDS_API_KEY_PAID` is only used when `ODDS_USE_PAID_KEY=true` is set by hand.

**Math** (`server/betting/math.js`, unit tested):
- **No-vig fair price:** multiplicative (divide each implied probability by the overround) or power (`BET_FAIR_METHOD=power`, which shifts more of the margin onto longshots).
- **Pinnacle anchor (H1, default `BET_ANCHOR=pinnacle`):** +EV compares each soft book with **Pinnacle's own no-vig price** (power method, `BET_ANCHOR_METHOD`), not with the other soft books. Pinnacle has to quote every side at the same line. If Pinnacle has no prices for a game at all, the strategy falls back to the consensus below, and those rows and bets are marked `consensus`. Named gates, each logged as a skip with its reason: EV ≥ `BET_MIN_EDGE_PCT` (2%) on moneylines, ≥ `BET_MIN_EDGE_SPREADS_PCT` (2.5%) on spreads/totals, and ≥ `BET_MIN_EDGE_LONGSHOT_PCT` (4%) above `BET_LONGSHOT_DEC` (4.0). Pinnacle hold must be ≤ `BET_MAX_HOLD_PCT` (5%). Both prices must be ≤ `BET_MAX_PRICE_AGE_SEC` (600 s) old, using The Odds API's per-market `last_update`, and ≤ `BET_MAX_AGE_GAP_SEC` (300 s) apart. Start time must be `BET_MIN_MINUTES_TO_START` (20 min) to `BET_MAX_HOURS_TO_START` (36 h) away. On the MOCK feed the anchor is a labeled Pinnacle-like `mock_sharp` book (low vig, low noise), and the time gate is `BET_MOCK_MIN_MINUTES_TO_START` (2 min) because mock games start 3–25 min out. `BET_ANCHOR=consensus` restores the old behavior.
- **CLV scoreboard (H1, the primary metric):** the close is the last Pinnacle snapshot taken ≤ `BET_CLOSE_WITHIN_MIN` (10) min before start. With the default snapshot plan, that is the T-10 snapshot. CLV % = taken decimal / Pinnacle no-vig closing decimal − 1, and "beat close" means the taken price beat the same book's own closing price. The scoreboard shows mean CLV with a seeded bootstrap 95% CI, beat-close %, results by sport and by book, CLV for prices ≤ 3 min old vs older ones (edge decay), and ROI as a secondary number. Closes captured more than 10 min early are excluded and counted as "approximate". Verdict, per the batch-1 paper-test plan: no verdict before 300 bets with a valid close. **Pass** needs mean CLV ≥ 1%, CI above 0 and beat-close ≥ 52%. **Fail** is mean ≤ 0, or a CI that straddles 0 after 600 bets. ROI is not judged before 1,500 bets. Real and simulated bets have separate scoreboards. The MOCK scoreboard is labeled as not evidence of edge, because the mock's stale books are built to be beatable.
- **Consensus:** the median no-vig probability across books. For +EV, each book's price is compared with the consensus of the **other** books, so a book never confirms its own price. At least `BET_MIN_BOOKS` books are required.
- **EV** per unit = p·(d−1) − (1−p). A bet is taken when EV ≥ `BET_MIN_EDGE_PCT` (and odds ≤ `BET_MAX_ODDS_DEC`).
- **Fractional Kelly:** f* = (p·d − 1)/(d − 1), times `BET_KELLY_FRACTION` (¼ by default), capped at `BET_MAX_STAKE_PCT` of the sleeve bankroll.
- **Exposure caps:** per bet `BET_MAX_STAKE_PCT`, per event `BET_MAX_EVENT_PCT`, and total open `BET_MAX_OPEN_PCT`. Every refusal is logged as a skip with its reason.
- **Arbs:** take the best price per outcome across ≥2 different books. If Σ 1/dᵢ < 1 and the margin is ≥ `BET_MIN_ARB_PCT`, the legs are staked for an equal payout (`BET_ARB_STAKE_PCT` of the bankroll in total) and booked as **one** grouped ledger entry once every leg settles.
- **Middles:** Over L at one book plus Under H > L at another, or opposite spreads whose lines overlap. They are shown as **alerts only and never staked**, with "cost if only one side wins" and "profit if both win".
- **Spread signal:** a book hanging a number ≥ `BET_MIN_POINT_EDGE` points better than the most-quoted line. Its win probability is assumed to be the consensus fair probability plus `BET_POINT_VALUE_PCT` percentage points per point. **That is an assumption, not a measured value** (real values depend on the sport and on key numbers), and the UI says so.
- **CLV (spread signal, arbs, and consensus-fallback +EV bets):** at kickoff the last quote of the same book, market and line is de-vigged across books. CLV % = taken decimal / closing fair decimal − 1. If the line moved and no close was quoted, the bet shows "n/a". Average CLV and the share of bets that beat the close are reported separately for real and simulated bets.

**Ledger.** Bets are graded from scores (pushes return the stake) and booked to the strategy's own PnL, the attribution table and the unified equity curve, with real and simulated bets in separate books. No commissions are charged; the vig is already in the prices.

**Lab.** There are templates for +EV, spread signal and arb (each with ToS, limits and line-movement risk notes). The JSON schema has `betting_ev`, `betting_spread` and `betting_arb` kinds with `market.sport`, `betMarkets`, `regions`, `kellyFraction`, `maxStakePct`, `maxEventPct` and `maxOpenPct`. Text import recognizes "+EV", "line shopping", "no-vig", "sure bets", "middles", "stale spreads", sport names, "quarter Kelly" / "N% Kelly", edge %, min books and per-bet / per-game caps. It reports parlays, teasers, props, live betting, futures, bonuses and automated real-money betting as **not mappable**. Betting configs **cannot be backtested here**: The Odds API documents historical odds snapshots as paid-plan only (check current pricing with the provider), and no free source exists. So they stay `unverified`, and you should judge them by live paper CLV on the desk.

### 11. Mempool lab (H4): measurement and simulation only

**What it is.** A research tool, not a strategy that trades. It watches public Ethereum pending swaps sent to the Uniswap V2 Router02, SwapRouter02 and Universal Router, and decodes exact-in single-hop swaps. For each one at or above `MEMPOOL_MIN_USD` it reads pool state with `eth_call` and models what a sandwich (front-run plus back-run) and a plain back-run could have earned:
- **Ceiling:** the gross before gas.
- **Realistic:** gross minus gas (`MEV_GAS_UNITS_*` × (base fee + 1 gwei)), minus a builder bid of `MEV_BID_SHARE` of the gross.

It then checks the real chain:
- whether the tx was included, replaced (same nonce, different hash) or dropped;
- whether the block holds a same-sender front/back pair around it (the heuristic sandwich truth). When it does, the attacker's gross is taken from the Swap logs in the receipts.
- Optionally, a Dune CSV you exported yourself can be imported offline with `node scripts/mev-import-dune.js file.csv`.

The card reports coverage (the share of heuristic victims and block txs that were seen pending), precision and recall of "model says profitable" against the truth, and a median error histogram. No verdict is shown before 500 large swaps have been observed and 50 confirmed sandwiches matched.

**Safety.**
- `MEMPOOL_ENABLED=false` by default. When it is off, no socket is opened and no call is made.
- The feed's RPC is an allowlist of six read methods. Anything else, `eth_sendRawTransaction` included, throws before any network call.
- There is no wallet, key, signing, bundle building or submission code anywhere. `test/mev-lab.test.js` scans the source and the exports to assert this.
- When the lab is armed, positive realistic values are booked to the **SIM** book only, with zero real allocation.

**Sources.** The public publicnode WS and HTTP endpoints are used by default; `ALCHEMY_API_KEY` is used when it is set; or set `MEMPOOL_WS_URL` / `MEMPOOL_RPC_URL`.

**First real run** (Oct 30 2026, about 4.5 min, public node, `MEMPOOL_MIN_USD=5000`):
- 2,110 pending txs were seen, 36 of them to the routers, and 35 of those were Uniswap **v4** Universal Router commands. v4 is not decoded, so 1 swap was decoded (a multi-hop) and 0 were simulated.
- Of the heuristic victims in 21 blocks, 13 of 30 (43%) had been seen pending, against 37% of all block txs.
- There were 21 RPC calls and 0 errors.

So on today's public flow **the lab cannot yet produce a verdict**: most retail Uniswap flow is v4, and a large share of sandwiched flow never appears in the public mempool.

## Data path: websockets first, REST as the labelled fallback

| Venue / source | Transport | What it carries | Health row |
|---|---|---|---|
| Binance USD-M | WS `fstream.binance.com/public` + `/market` | book ticker, mark price, funding rate | `ws.binance` |
| Bybit linear | WS `stream.bybit.com/v5/public/linear` | tickers incl. bid/ask, mark, funding | `ws.bybit` |
| OKX | WS `ws.okx.com/ws/v5/public` | swap tickers, mark, funding, spot tickers | `ws.okx` |
| Hyperliquid | WS `api.hyperliquid.xyz/ws` | `bbo` + `activeAssetCtx` (mark, funding) | `ws.hyperliquid` |
| Binance / Bybit spot | WS (`data-stream.binance.vision`, `stream.bybit.com/v5/public/spot`) | top of book | `ws.binance-spot`, `ws.bybit-spot` |
| Helius (Solana) | enhanced webhook → HAWSE inbox (Cloudflare Worker), polled every 15–60 s | push → poll | `whale.solana`, `whale.inbox` |
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
| Helius + HAWSE inbox | `HAWSE_WEBHOOK_URL`, `HAWSE_READ_TOKEN` (desk); `HELIUS_API_KEY`, `HELIUS_WEBHOOK_AUTH` (admin script) | https://www.helius.dev | live Solana whale flow (needs `WHALES_ENABLED=true`) |
| Alchemy / Infura | `ALCHEMY_API_KEY` / `INFURA_API_KEY` | https://www.alchemy.com / https://www.infura.io | keyed EVM RPC + WS |
| QuickNode (or any RPC) | `EVM_RPC_URL_<CHAIN>`, `EVM_WS_URL_<CHAIN>` | https://www.quicknode.com | per-chain endpoint, highest priority |
| publicnode | none | https://www.publicnode.com | keyless EVM fallback (best effort) |
| Pyth (Hermes) | `PYTH_API_KEY` | https://pyth.network | oracle cross-check of venue marks (Hermes requires a key since 2026-08-26) |
| Jupiter | none (optional free `JUPITER_API_KEY`; `JUPITER_API_BASE` defaults to `https://api.jup.ag`) | https://jup.ag | Solana executable quotes for the gap scanner |
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
| Whale flow | Sees transactions soon after they land | Helius webhook → HAWSE inbox poll (Solana, 15–60 s) and EVM `newHeads` WS, with REST/RPC polling as fallback | **WS is needed.** Polling public RPC is seconds late, and public endpoints rate-limit. |
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

## Strategy explainers: "How it works" boxes (Stage 11)

Every strategy has an expandable **How it works** box. That covers all ten desk cards (funding arb, whale flow, 1% mode, DEX gap scanner, ORB, perp momentum, perp basis, and the three sports-betting strategies), every strategy-lab template, every saved or imported lab config (one box per version), and every betting rule card. Opened, the box shows a short plain-English paragraph first, then a compact rules list: **Markets, Signal, Entry, Exit, Risk, Costs, Data**.

- **Generated, not hand-written.** The text is built at request time from the same values the logic reads. Literals that used to be inline are now frozen `RULES` / `SETUP` / `*_DEFAULTS` objects in each strategy file, and both the code and `explain()` use them. Configurable values come from the live config (e.g. `FUNDING_MIN_NET_BPS`, `ORB_TARGET_R`), and the risk-gate line comes from the current gate settings. Change a parameter and the description changes with it.
  - Generators: `server/lib/explain.js` (shared helpers), `explain()` on each strategy class, `server/lab/explain.js` (`explainConfig`, any lab config by `kind`) and `server/betting/explain.js`. The betting generator is kept inside the betting module boundary and covers strategies plus `explainRule` for rule cards.
- **Honest about limits.** For example, a lab config's `risk.maxDrawdownPct` is labelled *declared, not enforced* (the backtest reports drawdown but does not stop on it). Lab betting configs are labelled *spec only*, because the desk's betting strategies run on the server betting config. MOCK and SIM data paths say so.
- **No secrets.** Explainers only read non-secret parameters. A test injects fake secret env values (Helius, Alchemy, Infura, RPC URL, Tradovate, Odds API) and asserts that none of them appear in any explainer output.
- **Serving.** `GET /api/explain` returns the desk strategies. It is fetched once by the client and refreshed every 5 min or after a risk-gate change, and is kept out of the 1.5 s SSE payload. Lab explainers ride on `GET /api/lab`, and rule explainers on the betting snapshot.
- **Accessibility.** Native `<details>`/`<summary>`: Tab to focus; Enter or Space toggles; touch works; visible `:focus-visible` ring; 44 px tap target on small screens; reduced-motion respected. The desk re-renders every tick, so cards are now keyed: an open box stays open and keeps keyboard focus across re-renders. A headless check verified this over 4 s of live SSE ticks on desktop and mobile viewports.
- Tests: `test/explain.test.js` (coverage of every strategy/template/rule, section order, config-change propagation, constants shared with logic, ET clock helper, NOT/any/cooldown rule text, secret absence).
- Screenshots: `docs/screenshots/stage11-*.png` (desk ORB / funding / sports-arb cards and full grid, a lab template, a saved lab config, and a betting rule; desktop and mobile).

## Risk gate

- **Daily loss halt** (`RISK_DAILY_LOSS_PCT`) blocks new entries until the next UTC day.
- **Drawdown breaker** (`RISK_MAX_DRAWDOWN_PCT`, measured from peak equity) latches until you press *Reset breaker*.
- **Manual HALT** is in the top bar.

You can edit the limits live. When the gate is closed, strategies keep managing their open positions but log `risk gate: …` skips instead of opening new ones.

## Security boundaries

- **Bind and auth.** The desk binds to `127.0.0.1` and has no auth, so do not expose it. It has no inbound webhook route any more (no tunnel): Helius delivers to the Cloudflare Worker, and the desk only makes outbound `GET /events` calls with `Authorization: Bearer $HAWSE_READ_TOKEN`. The inbox URL and token are read server-side only, never logged (errors are scrubbed) and never sent to the browser (the UI gets counters and times only).
- **Static files** (`server/static.js`). Only `public/` is served. The path is decoded once, and the request is refused if it contains malformed escapes, double-encoding, NUL, backslashes, `..`/dot segments, dotfiles (`.env`), or the names `data`, `node_modules`, `server`, `scripts`, `test`, `docs` or `package*.json`. Symlinks are resolved with `realpath`, and the target must be inside the public root by `path.relative`, not a prefix match, so `/public-evil` is refused. Only `.html/.js/.css/.svg/.png/.json/.ico` regular files are served, and only via GET/HEAD. Tests: `test/static-boundary.test.js`.
- **No env values in responses.** API responses expose only booleans (`publicFlags()`). A test boots the server with sentinel values for every secret env var and checks that no GET endpoint ever echoes them (including `HAWSE_WEBHOOK_URL` and `HAWSE_READ_TOKEN`), and that `/hooks/helius` no longer exists. `GET /api/health` returns `{ok, mode:'paper', uptimeSec}`.

- **Secret scanning.** `gitleaks git .` and `gitleaks dir .` (8.28, default rules plus `.gitleaks.toml`) and `trufflehog git file://.` (3.90) report no findings over the full history. The only flags were deliberately fake values in leak-assertion tests, which are allowlisted by exact value, not by path, so a real-looking key in `test/` is still flagged. Pyth feed ids, token mints, contract and pool addresses, and EVM event topics are public identifiers and are commented as such. `scripts/check-secret-presence.sh` checks whether the value of each secret env var set in your shell appears anywhere in history, the working tree (including `data/`) or stashes. It prints only match/no-match and never prints a value.

## Environment variables

See [`.env.example`](.env.example). Every variable is listed there with its default. Secrets are read in `server/config.js`. `publicFlags()` exposes only booleans such as `heliusConfigured`, and a test asserts that no secret value leaks into the client payload. `.env` is gitignored.

## Screenshots

`docs/screenshots/`: desktop at 1440 wide and mobile at 390 wide, captured with headless Chromium.

## Layout

```
server/server.js          HTTP + SSE + static, binds 127.0.0.1
server/static.js          static-file boundary (realpath + path.relative, allowlist)
scripts/check-secret-presence.sh  presence-only check that no env secret value is in git/tree
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

- Fee table: base-tier taker fees only (no maker, VIP, or token discounts); verified 2026-10-29, re-check before relying on a paper test. No Blocknative dependency exists (the service shut down 2026-06-19); a test asserts no references creep back in.

- Betting rules desk: team/player stats are MOCK (no provider wired), so stats-based signals are always SIM. Kalshi/Polymarket adapters are interface-only and refuse. Print and clipboard were checked only in headless Chromium (print media emulation); a real print dialog was not exercised.
- Sports betting: The Odds API live path was smoke-tested once against the real API on 2026-10-29 (1 `/events` call = 0 credits, 1 `/odds` snapshot = 1 credit; headers parsed, 10 NBA games, Pinnacle on all). H1 real-data check on 2026-10-29: NBA + NFL, h2h/spreads/totals, 3 credits each (6 total). That returned 41 events, Pinnacle on 23, and 10 inside the 20 min–36 h window. **0 prices passed the gates**: the best was −0.75% EV vs Pinnacle fair. Pinnacle usually hangs different spread/total numbers than the soft books, so most spread/total quotes skip as "anchor has no price at this line". Per-market `last_update` ages were 20–66 s. No real bet has reached a close yet, so the real CLV scoreboard is empty: CLV capture and the verdict are tested with fixtures and on the MOCK feed only. The scheduler and budget logic are unit-tested with fixtures. Mock-market arb and +EV frequency is unrealistically high.

- Mempool lab (H4):
  - Uniswap v4 (Universal Router command 0x10) is detected but not decoded or simulated, and on the first real run that was 35 of 36 router txs.
  - V3 is a single-tick virtual-reserve approximation that ignores tick crossings, so it is optimistic for large swaps.
  - The sandwich truth is a same-block same-sender heuristic: it misses multi-address bots and can mislabel arbitrage loops.
  - Only the public mempool is visible. Private orderflow (MEV-Share, private RPCs) never shows up, which caps recall.
  - There is no Dune API integration; only an offline CSV import.
  - No verdict has been reached yet (0/500 simulated, 0/50 confirmed).
  - The precision/recall/error pipeline is tested with a scripted node only.

- Binance perp funding interval is assumed to be 8 h because REST `fundingInfo` is geo-blocked from the test box. Symbols with 4 h intervals would show a halved hourly rate.
- Pyth Hermes requires an API key (since 2026-08). The Pyth adapter is idle without `PYTH_API_KEY`, and it has not been tested with a key.

- From some regions Binance returns HTTP 451 and Bybit returns 403. They then show NO DATA and the arb runs on the venues that answer.
- Funding arb fills are modeled at the observed top of book plus impact. Real queue position, partial fills and venue downtime are not modeled.
- Gap scanner: public Jupiter and ParaSwap quotes are rate-limited, so some cells can be blank (·) on a given scan. Mid prices from thinly traded or stale DexScreener pools can show large gaps that are not executable, which is why they are indicative only.

## Helius credits and the HAWSE inbox

Helius credit costs (helius.dev, checked 2026-10-29): webhook event = 1 credit (charged per delivery, retries included),
webhook create/edit/delete = 100. The free plan has 1,000,000 credits/month and 5 webhooks. Polling the HAWSE inbox costs no Helius credits.

- **Off by default.** `WHALES_ENABLED=false` means DEMO/MOCK with zero Helius and zero inbox calls.
- **Inbox contract** (Cloudflare Worker, free tier): Helius `POST /helius` with the raw `Authorization: <HELIUS_WEBHOOK_AUTH>` header (max 1 MB, 20k stored POSTs per UTC day, ~24 h retention); the desk reads `GET /events?since=<cursor>&limit=<1-200>` with `Authorization: Bearer <HAWSE_READ_TOKEN>`.
- **Poller** (`server/feeds/inbox.js`): every `INBOX_POLL_SEC` (15–60 s), looping immediately while `more=true` (up to 50 pages per cycle). The cursor starts at 0 and is persisted atomically in `INBOX_STATE_FILE` (default `data/inbox-state.json`, runtime state, gitignored) together with the last ~5,000 signatures, so restarts neither replay nor re-deliver. Helius retries are deduped by tx signature. Backoff: 401/403 → 5 min doubling to 30 min ("check HAWSE_READ_TOKEN"); 429 → `Retry-After` (else 60 s doubling to 15 min); 5xx/network → interval × 2ⁿ up to 5 min. Offline for more than the 24 h retention is recorded as a **gap** (persisted, shown in Data Sources). Deliveries whose block time is older than `INBOX_MAX_SIGNAL_AGE_SEC` (600) are shown as *backfill* but never trigger strategies.
- **Data Sources panel** shows the inbox row (`whale.inbox`): OK / STALE (no successful poll for 4 intervals) / not configured, last poll, cursor, round trip, deliveries / txs / dupes, last delivery, chain→inbox lag, backoff, last error and gaps. Never the URL or token.
- **Credits are driven by delivered events**: every tx in a delivery is charged 1 credit (dupes included, because Helius bills each delivery). Txs with a signature starting `HAWSE-TEST` (our own verification POSTs, which never went through Helius) are labelled TEST/MOCK, not billed and never reach strategies. The day is the ingestion day (approximate for backlog after downtime).
- **Hard caps, both enforced.** `HELIUS_DAILY_CREDIT_BUDGET` (default 30,000 per UTC day) and `HELIUS_CREDIT_BUDGET` (default 300,000 per month). Spend is tracked in `data/credits.json` and shown in **Data Sources** with a monthly and a daily bar.
- **Auto-pause** at `HELIUS_PAUSE_AT_PCT` (default 90%) of either cap: events are ignored, and because Helius bills every delivery anyway, the desk also PATCHes our webhook (matched by `<HAWSE_WEBHOOK_URL>/helius`) to `active:false` once (100 credits; needs `HELIUS_API_KEY`; disable with `HELIUS_AUTO_PAUSE_WEBHOOK=false`). Resume with `node scripts/helius-webhook.js resume --apply`.
- **Register / manage ONE webhook.** `node scripts/helius-webhook.js` (= `plan`) is a dry run with no network calls: it prints the accounts (label, measured tx/day, Solscan source), the request body (URL, auth and key redacted) and the expected credits/day with its assumption. `create --apply` POSTs `https://api-mainnet.helius-rpc.com/v0/webhooks?api-key=…` (override with `HELIUS_WEBHOOKS_API`; older docs show `mainnet.helius-rpc.com`) with `webhookURL=<HAWSE_WEBHOOK_URL>/helius`, `authHeader=<HELIUS_WEBHOOK_AUTH>`, `webhookType: "enhanced"`, `transactionTypes` `SWAP,TRANSFER` (`HELIUS_WEBHOOK_TX_TYPES`) and `txnStatus: "success"`; it refuses if a webhook already points there (use `update`). `update|pause|resume|delete|list --apply` manage it. The script refuses http/localhost URLs, invalid addresses, a `Bearer`-prefixed auth value and busy AMM pools.
- **Proposed accounts** (`server/feeds/helius-watch.js`, labels verified on Solscan, rates measured 2026-10-30 from public Solana RPC `getSignaturesForAddress`, no Helius calls): Binance 2 (~1,662 tx/day), Bybit hot wallet (~1,264), OKX hot wallet (~6), Kraken hot wallet (~4). Expected ≈ 2,936 credits/day ≈ 88k/month (≈ 9% of the free plan); with ×2 headroom ≈ 5.9k/day (≈ 20% of the daily cap). Coinbase 1 (~7,580 tx/day) was left out to stay well inside the budget. Override with `HELIUS_WEBHOOK_ADDRESSES`.

## Feed watchdog and stale warnings (H5.1)
Every polling or streaming feed declares `watchSpec()` (its health ids, expected interval and a `restart()`). `server/lib/watchdog.js` checks every 15 s. A loop with no activity (ok or error) for longer than max(3× interval, 45 s) is restarted with exponential backoff, and a log line is written: `[watchdog] <feed> stale: … -> restarting loop`. When the wall clock jumps more than 30 s ahead of the monotonic clock (VM paused/resumed, laptop sleep), every loop is kicked at once. WebSockets reconnect when idle longer than max(60 s, 3× ping) and when a connect does not open within 15 s. All fetches carry a hard timeout. The UI shows a top-bar `⚠ N STALE` chip and marks STALE rows with their age. `/api/state` exposes `stale`, `watchdog` and `monoUptimeMs`. Set `cfg.watchdog = { enabled: false }` to disable it in embedded/test use.

## Geo-blocked venues (Stage A)
From some hosts (this box egresses from the US), `fapi.binance.com`/`dapi.binance.com` answer HTTP 451 "restricted location", and `api.bybit.com`/`api.bytick.com` answer a CloudFront 403 "block access from your country". Such responses mark the row **BLOCKED (HTTP xxx)**, not a bare DOWN. The row names where the data actually comes from, and the REST endpoint is probed again only every 30 min. The same venues' public WebSockets (`fstream.binance.com`, `stream.bybit.com`, `data-stream.binance.vision`) are not blocked and already carry funding rates, marks and books. Binance spot REST uses `data-api.binance.vision`, which Binance documents as its public market-data-only host (override with `BINANCE_SPOT_REST`). The undocumented website proxy paths are deliberately not used.

## Market-data recorder (H6 Stage B)

Record only. There is no strategy, no order code and no authentication. It implements miro's §7A recorder spec
(`hawse-research/kalshi-15m-study.md`) on free public endpoints, and is on by default (`RECORDER_ENABLED=false` turns it off).

| Stream (file prefix) | Source (public, GET only) | Cadence | Timestamps |
|---|---|---|---|
| `kalshi.market` | Kalshi `/markets?series_ticker=` (strike, open/close, rules), `/markets/{t}` (official result), `/series/{s}` (fee terms) | 20 s discovery, settlement polled after close, fees hourly | rx |
| `kalshi.book` | Kalshi `/markets/{t}/orderbook?depth=10`, KXBTC15M / KXETH15M / KXSOL15M / KXXRP15M | every 1 s per live market, written when changed | rx, `sent`, **ex: null** (REST book has no exchange time) |
| `kalshi.trade` | Kalshi `/markets/trades?ticker=` | every 2 s, deduped by trade_id | ex = Kalshi `created_time`, rx |
| `kalshi.extra` | books for the top 12 open markets by 24 h volume across `KXNFLGAME, KXNBAGAME, KXNHLGAME, KXBTCD` | ~30 s each (round-robin) | rx |
| `poly.market` / `poly.book` / `poly.trade` | Polymarket Gamma `/markets?slug={asset}-updown-15m-{start}`, CLOB `/book`, data-api `/trades` | books 2 s (written on hash change), trades 5 s | ex = CLOB book timestamp / trade time, rx |
| `poly.top` | CLOB books for the top 10 Polymarket markets by 24 h volume | 60 s | ex, rx |
| `ref` | Coinbase, Kraken, Bitstamp, Gemini and Crypto.com public WebSockets | one row per asset per second | each venue's px + ex + age, `med` over venues fresher than 10 s, `n` |
| `odds` | a tap on the betting module's own The Odds API snapshots | whenever that feed refreshes | rx (**no extra credits**, existing budget guard unchanged; MOCK odds are never recorded) |
| `gaps`, `meta` | the recorder itself | — | session_start/stop, a 10 s heartbeat, gap rows |

**Deviation from the spec:** miro asked for Kalshi's WebSocket (`orderbook_delta`). That WebSocket requires API-key
request signing, and this job forbids auth-signing code, so books are polled over public REST instead. That gives
1 s resolution, not every delta, and no exchange timestamp on books (trades do carry one).
The `ref` median is a BRTI-*like* median of last trades from 5 of the 7 CF constituents (LMAX and Bullish are not wired).
It is **not** the CF Benchmarks index and not Kalshi's settlement source.

**Files.** Output goes to `data/recorder/<UTC day>/<stream>.<HHMMSS>-<pid>.jsonl`. Files are append-only
(opened with `O_APPEND`, never rewritten). They rotate hourly or at `RECORDER_MAX_FILE_MB` (default 64), and are then
gzipped to `.jsonl.gz`. `RECORDER_CAP_GB` (default 5) caps the whole folder: the **oldest closed** files are deleted
first, down to 90% of the cap, and each deletion is logged as a `meta` `evict` row. If only open files remain over the
cap, new rows are dropped and counted, and the panel shows CAPPED. `data/` is gitignored.

**Gaps and pauses.** This box is a VM that is paused between sessions. The recorder writes explicit `gap` rows rather
than pretending to be continuous:

| Reason | What it means |
|---|---|
| `offline` | The time from the previous process's last heartbeat to this start (desk stopped or box asleep). |
| `vm-pause` | The wall clock jumped ahead of the monotonic clock (VM paused). |
| `stall` | The 1 s tick fired more than 5 s late (event loop blocked or VM froze). |
| `clock-jump` | The H5.1 watchdog saw the jump. It then also restarts the feed loops. |
| `box-pause` | A stream's gap that overlaps one of the pauses above. |
| `poll-gap` | More than 5 s (Kalshi 15m books) without a good response, with no pause behind it: a venue or network problem. |
| `trade-page-limit` | A full trade page with no overlap was returned, so prints may be missing. |

**Network.** All HTTP goes through `server/recorder/public-get.js`: GET only, no headers, and a host + path allowlist
(Kalshi `/markets*`, `/series/*`, `/exchange/status`; Polymarket `/markets`, `/events`, `/book`, `/trades`). It has token
buckets (Kalshi ≤ 10 rps). Kalshi trades are polled at the API's max page (`limit=1000`; 1001 is rejected); an HTTP 429
pauses the Kalshi client for 2 s (Stage E: the first live run at `limit=200` drew 245 × 429 in ~10 min). Each poll loop
runs one cycle at a time (a slow cycle skips its next tick instead of stacking, Stage D). Errors are counted by kind
(HTTP status / timeout / network, no URLs or bodies) and shown on the card with rate-, cooldown- and busy-loop skips. `test/recorder.test.js` checks that portfolio, order and auth URLs are refused before any
network call, and source-scans `server/recorder` + `server/kalshi-h2` for signing, POST, order or key code.

**UI.** The "Market-data recorder" card shows markets tracked, rows/min, bytes, last write, disk vs cap, the per-day
projection, gaps by reason and live 15m markets. Health rows appear in group `recorder` (Settings → Feeds) and as
providers `kalshi-public`, `polymarket-public` and `ref-venues`.

## Kalshi H2 frozen forward paper test (H6 Stage C)

This is miro's one surviving hypothesis (`kalshi-15m-payout-sweep.md` §7): on KXBTC15M / KXETH15M / KXSOL15M, at the
first moment with 6–10 minutes left where the YES ask is in [0.93, 0.979], buy 1 YES at the ask and hold it to
settlement. Only one entry per market, and no other filters. It is **paper only**: there is no order code. The test
listens to the recorder's public book and settlement events and appends to its own ledger. It never touches desk equity
or strategies.

**Freeze.** The rules live in `config/frozen/kalshi-h2-v1.json`. The SHA-256 of that file is pinned twice: in
`server/kalshi-h2/index.js` (`FROZEN`) and separately in `test/kalshi-h2.test.js`. If the file is edited, the test fails
and the module refuses to run. To change a rule, write `kalshi-h2-v2.json`, pin its new hash, and it gets its own ledger
folder (`data/paper/kalshi-h2/v2/`), so v1 results stay separate. The file is marked `-text` in `.gitattributes` so line
endings cannot change the hash.

| Frozen choice | v1 |
|---|---|
| Entry | Uses Kalshi's own ask from the recorder's ~1 s book polls; the first book in the window wins. The spec says "first minute" (from minute candles); 1 s books are finer, never coarser. |
| Coverage | A touch counts as a signal only if books were seen before 600 s left and never more than 5 s apart through the signal. Otherwise it is logged as a skip (`joined_late` / `incomplete_coverage`), never a signal. The VM pauses between sessions, so expect many of these. |
| Fill (conservative) | Takes the ask on the **next** snapshot after the signal (≤ 5 s, else `fill_snapshot_too_late`). Walks the ask ladder up to signal ask + 1¢ (else `no_fill_within_limit`). The fill price is the worse of the signal ask and that VWAP. The spec-literal P&L at the signal ask is logged as a shadow column only. |
| Fees | 1-lot `ceil(0.07·P·(1−P)·100)/100`; large-order `0.07·P·(1−P)`. Checks that the series still reports `quadratic ×1`. |
| Ticks | Expects `tapered_deci_cent` (0.001 steps above 0.90). Any change is a fail-stop. |
| Settlement | Kalshi's official `result` from `/markets/{t}`, with a 6 h timeout (logged). Our own reference index is never used. |
| Sizing | 1 contract (P&L in cents), plus a shadow 1%-of-bankroll curve for reporting only. |

**Ledger.** `data/paper/kalshi-h2/v1/ledger.jsonl` is append-only, and every row carries `v`. Row types are `session`
(with the hash), `signal`, `fill`, `skip` (with a reason), `observed` (no touch), `settle` (with pnl1 / pnlL / pnlSpec),
`settle_timeout` and `flag`. It is replayed on start.

**Stats** (`server/kalshi-h2/stats.js`, read-only):
- counts, and win rate with a Wilson 95% CI against the mean implied probability (fill price);
- mean net with the 1-lot and the large-order fee, with a seeded day-block bootstrap 95% CI and a normal CI;
- results per asset and per week; the share of signals with ask size ≥ 10; the worst rolling 4-week loss per 100 signals;
- the shadow bankroll.

The verdict reads **"UNVERIFIED — not enough data"** until **both** ≥ 8 weeks and ≥ 2,500 signals are reached. Only then
are the 5 pass criteria applied. Fail-stops (mean ≤ 0 after 2,500, a 4-week loss > 60¢ per 100 signals, a fee or tick
change) halt new signals and are written as `flag` rows. Weeks are calendar weeks since the first session. Box downtime
counts as elapsed time but produces no signals.
