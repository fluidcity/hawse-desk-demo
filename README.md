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

## Where it runs

The live paper desk runs on Bryan's Windows PC (`BoucherGamingPC`), not on the agent box.

- Code and data: `C:\HAWSE\hawse-desk-demo` (this repo, with `data\` copied over from the box at cutover).
- Keys: `C:\HAWSE\hawse.env`, readable only by the Windows user. They are loaded into the process environment by the launcher and never written to the repo or logs. The paid Odds key is not included.
- Launcher: `C:\HAWSE\hawse-run.ps1 -What desk|proxy` sets `PORT=8788 KALSHI_ENV=prod KALSHI_WS=true KALSHI_WS_CF_INDEX=true HAWSE_PROXY_ALLOW_POST=arm,halt,resume`. It refuses to start a second copy if the port is already in use, restarts the process 5 s after any exit, and logs to `C:\HAWSE\desk.log` / `C:\HAWSE\proxy.log`. On Node 20 it adds `--experimental-websocket`, because Node 20 has no global `WebSocket`.
- Scheduled Tasks `HAWSE Desk` and `HAWSE Proxy` start at logon. They run hidden with no time limit, start when available, and restart every 1 min, up to 99 times.
- Desk on the PC: http://localhost:8788 (bound to 127.0.0.1, no login).
- Phone (tailnet only, token required): https://bouchergamingpc.taile2f96e.ts.net. This is `tailscale serve --bg --https=443 http://127.0.0.1:8789` in front of `scripts/auth-proxy.js`.

PowerShell on the PC:

```powershell
Start-ScheduledTask 'HAWSE Desk'; Start-ScheduledTask 'HAWSE Proxy'    # start
powershell -NoProfile -ExecutionPolicy Bypass -File C:\HAWSE\stop-hawse.ps1   # stop both
# restart = stop, then start
Get-Content C:\HAWSE\desk.log -Tail 50                                  # log
```

The box copy at `/workspace/hawse-desk-demo` is **stopped**. Its `data/` stays as the rollback copy. Never run the box desk and the PC desk at the same time, or Kalshi, Helius and Odds get polled twice. To roll back, first stop the PC desk (see above). Then start the box desk from its secrets env files with the same `PORT/KALSHI_*` variables: `setsid nohup node server/server.js >> /workspace/hawse-server.log 2>&1 &`.

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
| Cloudflare recorder (H7 L) | `CF_RECORDER_URL`, `CF_RECORDER_READ_TOKEN` (desk, from `/home/box/secrets/hawse-cf-recorder.env`) | docs/cloudflare-recorder.md | status + chunk sync of the always-on recorder; missing = "not configured" |
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

## Remote viewing: token auth proxy (Stage Q)

`scripts/auth-proxy.js` is a zero-dependency Node reverse proxy that puts a login in front of the **single** desk on `:8788`. Your PC and phone only *view* that desk. There is no second desk, recorder, Worker or webhook, and the proxy makes no API calls of its own. The desk itself is unchanged, so **starting or stopping the proxy never needs a desk restart**.

```bash
# Keep the token in a secrets file, not on the command line (it would show in `ps`):
#   /home/box/secrets/hawse-proxy.env  ->  HAWSE_ACCESS_TOKEN=<at least 24 random chars>
# Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
set -a; . /home/box/secrets/hawse-proxy.env; set +a
node scripts/auth-proxy.js          # http://127.0.0.1:8789 -> http://127.0.0.1:8788
```

| Env var | Default | Meaning |
|---|---|---|
| `HAWSE_ACCESS_TOKEN` | (required) | At least 24 characters, no whitespace. If it is missing or weak the proxy refuses to start, and the token is never printed. |
| `HAWSE_PROXY_PORT` | `8789` | Port the proxy listens on. |
| `HAWSE_PROXY_HOST` | `127.0.0.1` | Bind address. Keep it on loopback and reach it through an HTTPS tunnel. |
| `HAWSE_PROXY_UPSTREAM` | `http://127.0.0.1:8788` | Must be a plain-http loopback origin. Anything else is refused. |
| `HAWSE_PROXY_ALLOW_POST` | (empty = read-only) | Comma list taken from `halt, resume, reset-breaker, risk, arm, pilot-halt`. Unknown names are refused at startup. **Recommended for the phone: `arm,halt,resume`** (strategy arm toggles plus HALT / Resume). Leave `reset-breaker` and `risk` desk-only. |
| `HAWSE_PROXY_INSECURE_COOKIE` | off | `1` drops the `Secure` flag. Use it only for plain-http testing; see below. |

- **Login.** `GET /login` serves a form. A correct token gets a random session id in an `HttpOnly; Secure; SameSite=Strict` cookie (7 days). `Authorization: Bearer <token>` also works for scripts. Comparison is constant-time (sha256 + `timingSafeEqual`). The login POST refuses cross-origin `Origin` / `sec-fetch-site`. `POST /logout` ends the session.
- **Rate limit.** After 5 failed attempts in 15 minutes from one remote address, that address gets `429` until the window passes, even with the right token. Behind a tunnel all clients share the tunnel's address, so one bad actor can lock you out for 15 minutes. That is deliberate (fail closed); restarting the proxy clears it.
- **Read-only by default.** GET and HEAD are forwarded. POST is forwarded only for routes named in `HAWSE_PROXY_ALLOW_POST`, matched by exact path. `/api/live-order` (which always refuses anyway), `/api/storage/recorder-cap`, lab writes and betting writes are **never** forwarded. PUT, PATCH, DELETE and OPTIONS return 405. The desk's mutating UI routes are `/api/halt`, `/api/resume`, `/api/reset-breaker`, `/api/risk` and `/api/strategy/:id/arm` (gates for the paper strategies only; the H2 forward tests have their own fail-stop), plus recorder-cap (loopback-only in the desk itself), lab and betting POSTs.
- **CSRF / same-origin on every forwarded POST.** Besides the allowlist and the token (cookie or Bearer), a forwarded POST must be `Content-Type: application/json` (else `415`) and carry an `Origin` whose host equals the request `Host`, or, when the browser sends no `Origin`, `Sec-Fetch-Site: same-origin`. A cross-origin, `null` or missing Origin on a cookie session gets `403` before it reaches the desk. A Bearer client that sends neither header (curl, scripts) is accepted; a Bearer request with a foreign `Origin` is not. This is the same Origin-vs-Host rule the login form uses, so it works through Tailscale Serve and `cloudflared`, which keep the public `Host`. The dashboard's buttons send exactly this (same-origin `fetch`, JSON body, cookie), and a refused POST now shows a red toast ("…/arm refused: read-only proxy: this POST is not on HAWSE_PROXY_ALLOW_POST") instead of silently flipping the toggle.
- **Phone controls (arm, halt, resume).**

  ```bash
  set -a; . /home/box/secrets/hawse-proxy.env; set +a
  HAWSE_PROXY_ALLOW_POST=arm,halt,resume node scripts/auth-proxy.js   # :8789 -> :8788, Tailscale Serve already points at :8789
  ```

  With that, `POST /api/strategy/:id/arm`, `/api/halt` and `/api/resume` work from the phone. `/api/reset-breaker`, `/api/risk`, `/api/storage/recorder-cap`, `/api/live-order`, lab and betting writes stay `403`. Everything is paper: arming only lets a paper strategy open paper positions under the same risk gates.
- **Streams.** SSE (`/api/stream`) is passed through unbuffered. WebSocket upgrades are authenticated, refused cross-origin, then piped both ways (the desk serves none today).
- **Headers and logs.** The session cookie and `Authorization` are stripped before forwarding, so the desk never sees them. Every response gets `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP same-origin, a Permissions-Policy and `frame-ancestors 'none'`. The log has the startup line (allowlist and cookie mode) and `lockout active for <ip>`. It never logs tokens, cookies, headers or bodies.
- **HTTPS.** Browsers keep a `Secure` cookie over `https://` and `http://localhost` only. From a PC or phone, reach the proxy through an HTTPS tunnel (for example `cloudflared tunnel --url http://127.0.0.1:8789` or Tailscale Serve). Do not bind `0.0.0.0` over plain http; if you must test that way, `HAWSE_PROXY_INSECURE_COOKIE=1` sends the cookie, and the token, in clear text.
- Tests: `test/auth-proxy.test.js` runs against a scratch desk (temp dirs, engine not started) plus fake upstreams for header and WebSocket checks.

## Armed state survives restarts (Stage S)

Each strategy's armed on/off is saved to `data/state/armed.json` (gitignored under `/data/`) on every arm or disarm call, by an atomic write (temp file in the same directory, fsync, rename). On `start()` the desk loads it right after "Desk online" and re-arms the saved strategies through each strategy's own `arm()`, the same path as the dashboard toggle. Nothing else is armed, and there is no order path; it is paper only. The tape shows one line:

- `Restored armed state: armed funding_arb, … · N disarmed (paper)` when the file is good;
- `Restored armed state: no saved state (… missing) · all strategies disarmed` on first run;
- `Restored armed state: saved state unusable (…) · all strategies disarmed · kept as armed.json.corrupt-<ts>` when the file is corrupt (the bad file is renamed, never deleted, and replaced on the next arm/disarm).

Saved ids for strategies that are not loaded this run (a module toggled off) are kept in the file. HALT, resume and the drawdown breaker are **not** persisted and behave as before (a restart comes up un-halted, as it always has). `ARMED_STATE_FILE=` (empty) turns persistence off; a path moves the file. An engine that was never started (tests, tools) never writes the file. If a save fails, the arm still applies, the API returns `persisted:false`, and the tape logs `armed state not saved`. Tests: `test/armed-state.test.js`.

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
The `ref` median is a BRTI-*like* median of last trades from 6 of the 7 CF constituents (Bullish added in H7; LMAX Digital has no free public feed — see [docs/reference-price-sources.md](docs/reference-price-sources.md)).
It is **not** the CF Benchmarks index and not Kalshi's settlement source.

**Files.** Output goes to `data/recorder/<UTC day>/<stream>.<HHMMSS>-<pid>.jsonl`. Files are append-only
(opened with `O_APPEND`, never rewritten). They rotate hourly or at `RECORDER_MAX_FILE_MB` (default 64), and are then
gzipped to `.jsonl.gz`. `RECORDER_CAP_GB` (default **12**, about 8 weeks at the measured ~210 MiB/day gzipped; it can also be changed live, see
*Storage panel* below) caps the whole folder: the **oldest closed** files are deleted
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

### Storage panel (H7)

The "Storage · disk & memory" card has one fill bar per consumer, coloured ok / warn ≥ 70% / crit ≥ 90%
(`STORAGE_WARN_PCT`, `STORAGE_CRIT_PCT`):

| Bar | Measured | Against |
|---|---|---|
| Recorder data | `data/recorder` (or `RECORDER_DIR`) | the recorder cap |
| Paper ledgers | `data/paper` | host disk (no cap; never pruned) |
| Odds cache + credits | `data/odds-cache.json`, `data/credits.json` | host disk |
| Logs | `*.log` under `data/` plus `DESK_LOG_FILE` | host disk |
| Total data/ dir | everything under `data/` | host disk |
| Host disk | `statfs` of the data filesystem | its size |
| Process memory (RSS) | `process.memoryUsage().rss` | host RAM |
| V8 heap | heap used | V8 heap limit |

**Live cap.** The card's "Recorder cap (GiB)" box calls `POST /api/storage/recorder-cap {"capGb": n}`
(`GET /api/storage` returns the same view). The change:
- is validated against `RECORDER_CAP_MIN_GB` (1) up to the lower of `RECORDER_CAP_MAX_GB` (500) and 95% of free disk plus
  what the recorder already uses;
- is applied to the running store at once, with no restart;
- is saved to `data/runtime/recorder-cap.json` (gitignored), which wins over `RECORDER_CAP_GB` at the next start
  (`RECORDER_RUNTIME_CAP=false` ignores it);
- is logged to the console, `data/runtime/cap-changes.jsonl` and a `meta` `cap_change` row.

A smaller cap prunes at once: the **oldest closed** recorder `.jsonl(.gz)` files go first, as whole files. Rows are never
cut, and the file being written is never touched. `data/paper`, `config/` and `data/runtime` are on a protect list that
eviction skips even if `RECORDER_DIR` were pointed above them. The POST is accepted only from a loopback address, with
a localhost `Host`, a matching `Origin` (if sent), no cross-site `Sec-Fetch-Site`, and `content-type: application/json`.
Anything else gets 403. `test/storage.test.js` covers the bars, validation, pruning order, protection, persistence and
the guard.

### Optional Kalshi WebSocket recorder (H7, off by default)
`KALSHI_WS=true` plus a Kalshi key (`KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH` or `_PEM`; read-only scope recommended, used for the handshake only either way) adds an
authenticated market-data socket next to the REST poller. It subscribes `orderbook_delta` (snapshot, then deltas,
with seq-gap detection and a fresh snapshot after a gap) and `trade` for the live 15m markets, and with
`KALSHI_WS_CF_INDEX=true` also `cfbenchmarks_value`, the CF Benchmarks RTI values Kalshi settles on.
Kalshi needs a signed handshake even for public channels. That signing lives **only** in
`server/kalshi-auth/ws-sign.js`, which signs exactly `ts + GET + /trade-api/ws/v2` and nothing else. The recorder
allowlists every outgoing frame. Tests enforce both. With no key, the card says so and no socket is opened.
**Live on prod since 2026-10-30.** `KALSHI_ENV` is `prod` (default) or `demo`. The PEM loads from a file or inline
(real newlines, CRLF, literal `\n`, or flattened to spaces). In a 13-minute run the WS and REST recorders had the same
64,947 trade ids with 0 field mismatches, and the WS got them about 1.2 s sooner (receive − exchange time p50 75 ms vs
1,304 ms). A killed socket was back in 1.4 s with a `ws-down` gap row. The WS runs on the box only: box pauses leave WS
gaps, and the Cloudflare REST recorder (no Kalshi key) covers trades through them. Details and setup:
[docs/kalshi-api-key.md](docs/kalshi-api-key.md).

**Series are config, not code (miro a).** `RECORDER_KALSHI_SERIES` (default `KXBTC15M,KXETH15M,KXSOL15M,KXXRP15M`) and
`RECORDER_KALSHI_EXTRA_SERIES` (default `KXNFLGAME,KXNBAGAME,KXNHLGAME,KXBTCD`) are comma lists. Add a series there and
restart; no code change is needed.

### Rebuilt index vs Kalshi official outcomes (H7, miro c)
`server/recorder/agreement.js` averages each reference source (the rebuilt BRTI-style index from the free spot venues
and, if enabled, Kalshi's `cfbenchmarks_value`) over the last 60 s before each 15m close. It then checks whether
"average above strike" matches Kalshi's **official** result. The recorder card shows the agreement rate per source
against the **> 99.5%** target. It stays "pending" until ≥ 200 settled markets, each with ≥ 50 samples in the window,
exist. Rows go to the `agree` recorder stream. This is measurement only: nothing settles on it.

### Reference price sources (H7)
Short version, details in [docs/reference-price-sources.md](docs/reference-price-sources.md): no paid feed is needed.
The free path is Kalshi's own `cfbenchmarks_value` channel over the read-only key (`KALSHI_WS_CF_INDEX=true`, opt-in,
off by default) next to the rebuilt index from free spot websockets. Paid options checked: CF Benchmarks direct
(enterprise), LMAX Digital (not free), CoinAPI (from about $79/mo) and Kaiko (about $1k+/mo). None is worth it for this
test.

### Cloudflare recorder (H7 Stage L, DEPLOYED as `hawse-recorder`)
`cloudflare/recorder/` runs at https://hawse-recorder.leadpathqa.workers.dev. It is a Durable Object whose alarm
re-arms every 1 s, and it is **record-only**: allowlisted public HTTPS GETs, no order path, no exchange key.

It records:
- Kalshi 15m BTC/ETH/SOL/XRP books (1 s) and trades (2 s, cursor-paged, deduped);
- the extra-series books;
- Polymarket books and trades for the same assets;
- gap rows for restarts, 429s and full trade pages.

Rows are stored as gzipped JSONL chunks in the DO's SQLite, pruned at 14 days or 2 GiB. R2 isn't enabled on the
account; an optional mirror is ready if you enable it.

| Endpoint | Auth |
|---|---|
| `GET /health` | public |
| `GET /status`, `/pull/*` | READ token |
| `POST /start`, `/stop`, `/restart` | ADMIN token |

The Worker stores only SHA-256 digests of the tokens. The tokens themselves live in
`/home/box/secrets/hawse-cf-recorder.env` (mode 600).

The desk (`CF_RECORDER_URL` + `CF_RECORDER_READ_TOKEN`, server-side) does two things:
- it polls `/status` and syncs chunks into `data/recorder/cf/` every 10 min (`scripts/cf-recorder-sync.js` does the
  same by hand);
- it shows a **Cloudflare recorder (remote)** line and Storage bar that turns **STALE** with a reason when writes stop or
  the desk can't reach it.

Projected cost is about $5.26/mo on Workers Paid, or $0 inside the Free limits. Live evidence, cost table, limits and
teardown/rollback: [docs/cloudflare-recorder.md](docs/cloudflare-recorder.md).

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

**miro's pass criteria (display only).** The H2 card also shows miro's criteria as pending / met / not met. They do
not change the frozen v1 rule or its hash, and the frozen verdict logic is untouched:
- mean net per contract after the 1-contract fee > 0;
- ≥ 6 of 8 weeks positive. This can be decided early: met at 6, not met once 6 is out of reach. A complete week with
  no settled fills counts as not positive;
- ≥ 10 contracts at the ask in ≥ 80% of signals (best-ask size is logged at signal time).

**Live P&L (H7 Stage K, display only).** Paper fills from the v1 ledger only, with the 1-contract fee:
- a cumulative **realized** net P&L curve, by official settle time;
- realized **today** (box-local day), **this test week** and **total**;
- **open positions**, marked to the latest YES bid from the recorder books as **UNREALIZED**. The mark is net of the
  entry fee and of the exit fee for selling at that bid. It is never added to realized. An open fill with no book seen
  since entry shows "no book yet" rather than a guessed mark;
- a **per-week table** (signals, settled, win rate, net, complete / positive). The same table drives the 6-of-8
  criterion.

The UNVERIFIED label stays until 8 weeks and 2,500 signals. Tests: `test/h2-pnl.test.js`.

### H2 v2 arm: `fav93_98_v2_nojump` (paper only, frozen, UNPROVEN)

v2 runs **alongside** v1 and does not change it. The v1 config, hash (`2f0053c4…9675c`), rules and ledger are
untouched, and a test checks that the v1 ledger is byte-identical with and without v2 running.

**Rule.** The v1 entry, plus one filter: **skip** the signal if the max YES ask at the **earlier** minutes of that
market is below **87¢**. Each earlier minute counts with its YES-ask close, which is the last recorded ask in that
minute. If there is no earlier quote, v2 takes the trade. The 0.87 threshold comes from miro's Dec–May autopsy and is
never retuned.
- Config: `config/frozen/kalshi-h2-v2.json`, sha256 `ee5185f8e059a8995c557b474b873f47dae867be5f02fb021368c83cf0294a4c`,
  pinned in `server/kalshi-h2/index.js` (`FROZEN`) and in `test/kalshi-h2-v2.test.js`. The loader refuses to start v2
  in four cases: the file was edited, the v1 hash does not match, v1 is not running, or the v2 file was handed to the
  v1 loader. No ledger is written when it refuses.
- Ledger: `data/paper/kalshi-h2/v2/ledger.jsonl` (gitignored). It is separate from v1's.
- Toggle: `KALSHI_H2_V2` (on by default, `false` turns it off). The engine feed is `kalshiH2v2`.
- Fills and results: v2 has **no order path** and no fill model of its own. It reuses v1's paper fill (price, size and
  fee charged) and Kalshi's official result one-to-one, so both arms are compared on exactly the same signals.

**Every v1 signal is logged**, skipped ones included. Each row has `max_earlier_ask`, `v2_skip` (true, false, or
null when unknown), `dask1` (signal ask minus the previous minute's close), `d_bps`, fill price and size, fee, ask
depth and result. `d_bps` is `log(ref / strike) × 1e4` from the desk's 1 s multi-venue **reference median**. It is
**not BRTI** (miro used Coinbase 1-minute data). It is null when there is no reference for the asset. The watch-only
counts (`d_bps < 16`, `dask1 > 9¢`) are shown on the card but are not a rule.

**Honest backfill.** On start, v2 rebuilds the decision for v1 signals from before it was running, using the recorded
books in `data/recorder/` (plain or `.gz`). A decision counts only when the books cover the market from open (within
60 s) and every earlier minute:
- **full** coverage: take or skip, by the rule;
- **partial** coverage with the max already ≥ 87¢: take, because more history can only raise the max;
- **partial** coverage and below 87¢, or no books at all: **unknown**. Unknown signals are not traded, are left out of
  the pass test, and are counted and shown on the card.

Rows are keyed per v1 signal, so a restart never duplicates them.

**Pre-registered pass test (display only).** The card reads **UNPROVEN** and shows each part as pending, met, or retired:
1. ≥ 1,500 settled v1 signals with a known v2 decision;
2. the skipped group loses more often than the kept group (one-sided Fisher exact, p < 0.05);
3. kept trades are positive per contract after the fee charged.

If the test is not met at 1,500, the arm is marked **retired**.

**UI card** (`#h2v2Card`, PAPER and UNPROVEN badges) shows:
- v2 trades taken, win rate (Wilson CI) and net per contract after fee;
- kept vs skipped loss rate, Fisher p and the decision counts;
- the cumulative net equity curve of kept trades;
- the backfill line and the latest 12 signals with their features.

**Live at 17:50 PT on Oct 30, 2026 (after the restart).** v2 reconciled 10 v1 signals from 30 recorded files:
- decisions: **9 take, 1 skip, 0 unknown** (8 full coverage, 2 partial with the max ≥ 87¢);
- taken: 9 settled, all wins, +5.58¢ per contract after fee (+50.2¢ total);
- the one skip (KXBTC15M-26OCT301600-00) had a max earlier ask of 86¢ and then jumped to 93¢. It won, so the
  skipped loss rate is 0/1 and Fisher p = 1.

This is far too little data to say anything. The arm is **UNPROVEN**.

Tests: `test/kalshi-h2-v2.test.js`.

#### v2 audit against miro's autopsy §5 (display/logging only; the frozen rule is unchanged)
`server/kalshi-h2/v2-audit.js` adds everything the autopsy asks the forward test to log, without touching `decide()` or the frozen file:
- Per signal (kept and skipped): `entryM`, `minutesLeft`, asset, month, `nEarlierQuotes` / `expectedEarlier` (= 14 − entry m) and `partialHistory`. It also logs max_earlier_ask, dask1, d_bps, the decision, the fill price, size, fee, depth and result, and the settlement value vs strike in bps (`settle_value` rows, live or from the recorded `kalshi.market` stream).
- **miro-exact shadow** (display only, never re-decides). The as-of YES ask is read at each minute boundary k·60 s for m = 14..entry+1. The entry minute is excluded, there are no intra-minute spikes, and only valid two-sided quotes count (bid > 0, ask < 1, ask > bid). An unchanged (deduped) minute carries forward only when the recorder provably kept watching: same session, no gap row, and ≤ 5 s for live rows. Each signal shows whether the shadow agrees with the frozen decision.
- Watch-only flags (not rules): d_bps < 16 and dask1 > 9¢.
- Fees: per order `roundup_to_cent(0.07·C·P·(1−P))`. Every paper fill is checked against the formula. Kept EV is shown under the actual fee, flat 1¢ and flat 2¢. The pass test uses the actual fee.
- Pass test: **only the first look** at 1,500 settled known-decision signals counts. It is persisted once as a `verdict` row and later rows are ignored. Interim values are display only. Results are shown with and without `partialHistory` signals. Until the first look, the status is UNPROVEN.
- Card: live vs backtest reference lines (skip ~18%; skipped loss 6.3% vs kept 3.0%; kept win 97.0% vs v1 96.4%; OOS EV +0.54¢ → +1.04¢; flat 2¢ +0.04¢; in-sample −0.45¢) with Wilson CIs. It also has kept vs skipped by asset, month and test week, running Fisher p and running kept EV (3 fee models) vs signal count, and equity curves for v1, v2-kept and skipped (labeled HYPOTHETICAL). The card lists these caveats:
  - Jun–Oct was already seen.
  - The spot features were Coinbase proxies.
  - Fills and depth were untested.
  - Do not retune 0.87; any change is a v4 (v3 is the sizing arm below and keeps v2's decisions).
- Old ledger rows get one `annot` row each, recomputed from the recorded books. It adds only the new fields and never a decision.

**Gaps between the frozen text and miro's backtest. Not fixed in v2; v4 proposal (renamed from "v3 proposal", since v3 is now the sizing arm):**
1. The frozen rule has no bid/ask validity filter. miro's panel drops quotes unless bid > 0, ask < 1 and ask > bid.
2. Frozen takes the last ask *recorded inside* each minute; miro takes the as-of close at the boundary, so a null or one-sided ask at minute end can differ.
3. Frozen counts a deduped, unchanged minute as missing, so it can return "unknown" where miro would carry the prior quote.
4. The frozen file does not say that only the first look counts. This is implemented in the verdict logic and display only.
5. v1 samples at minute boundaries, so live entry minutes are 5..9 vs miro's 6..10. This is a v1 sampling property and is unchanged.

On the 10 live signals so far, the shadow agrees with every frozen decision. An independent Python recompute from the recorded books reproduces every max_earlier_ask, decision, entry m, quote count and settle bps exactly. 2 of the 10 signals are partial_history.

### H2 v3 arm: `fav93_98_v2_nojump_sized` (paper only, frozen, UNPROVEN)

v3 trades exactly v2's decisions and adds size caps. v1 and v2 are unchanged (`2f0053c4…9675c`, `ee5185f8…94a4c`). Config: `config/frozen/kalshi-h2-v3.json` (sha256 `5498e1cbea6c45e427876dd2971f041421ef18ad06c103dc7921898f5179ce1c`). The loader refuses an unpinned file, a hash mismatch, or anything that is not paper-only with `liveOrders: false`. Ledgers: `data/paper/kalshi-h2/v3/`. Toggle `KALSHI_H2_V3` (default on; needs v2 on). There is no order path; a static test checks the module's requires, method names and wiring, and the v3 UI code makes no network calls.

- **Entry:** v2 `take` only. `skip` and `unknown` are not traded. v3 never re-decides. Results come from v1's settle row (Kalshi official result).
- **Size**, per line: contracts = min(X% of the line's paper balance, per-asset $ cap, optional overall $ cap, 10% of the traded volume, cash available), each divided by the decision-time ask and floored.
  - Two lines with their own ledger and equity: **3%** and **7%**, each starting at $10,000. The balance compounds from settled P&L only.
  - Per-asset caps (provisional): BTC $5,000 / ETH $400 / SOL $250 / XRP $250. The overall cap defaults to none.
  - Participation volume = Kalshi public trades on that market in the 60 s before the signal book (exchange times, deduped by trade id). It counts both sides, so it is optimistic. If the volume is unknown (a trade-stream gap, or no trade feed), the order is 0 contracts with bound `unknown_volume`. It is never assumed.
  - "Cap bound" = a cap other than the X% line is the smallest (ties count for each cap at the minimum).
- **Fill:** walk the recorded YES ask ladder on the same next book v1 fills on, up to `min(0.99, ask + 1¢)`.
  - The balance uses only what that visible depth supports.
  - The remainder is logged as **unfilled**. A stress line prices it at the worst visible level + 1¢ with the flag `remainder_priced_worst_plus_1c`. It is display only and never booked.
  - Slippage = fill VWAP minus the decision-time ask.
- **Fee:** the actual Kalshi fee, `roundup_to_cent(0.07·C·P·(1−P))`, once per order.
- **Logged per signal:** requested $, the bound cap, final contracts, per-level fills, slippage, the unfilled remainder, fee, result, book depth at the ask (all recorded levels, up to 10 from REST), and 60 s of refill after the fill (13 samples, every 5 s). Each refill sample has depth at the original limit and depth within 1¢ of the then-best ask.
- **Pass gate:** same as v2 for the edge: ≥ 1,500 settled known-decision v1 signals, first look only, one-sided Fisher p < 0.05. The kept net per contract after the fee comes from the 3% line. Until the first look, the status is UNPROVEN.
- **Card:** a two-line equity curve, avg $ per trade, % of trades where a cap bound (by cap), slippage, fill rate, net/contract and stress P&L. It also has a v1/v2/v3 table on the same signals and a **capacity check** panel.
- **Capacity panel:** observed depth within 1¢, depth at the best ask, entry-window volume, fill rate, slippage and refill, vs the backtest reference in `hawse-research/kalshi-15m-capacity-10k.md`:
  - **Fillable:** up to ~$300 per trade on all assets, and BTC to ~$5,000.
  - **Questionable:** ETH/SOL at $300–1,000.
  - **Fiction:** ETH/SOL above ~$1,000–2,000.
  - Sim with the 10% participation cap: 3% line ends at $32.5k (cap bound 50%, avg fill $388, max DD 18.6%); 7% line ends at $66.4k (64%, $888, 36.3%).

**On startup** (a desk restart is needed to run v3 at all):
- It creates `data/paper/kalshi-h2/v3/` and replays every existing v1 signal through v2's decisions.
- It backfills sizing and fills from the recorded books and trades in `data/recorder/` (read-only, about 2 s for ~250 MB today).
- A signal with no recorded book or trades is marked unknown and not traded.
- Live volume needs the recorder's new `trade` event, which also starts on that restart.

**Offline replay of the current recordings** (scratch copy, 11 v1 signals, 9 take / 2 skip):

| Line | Balance | Avg $ per trade | Cap bound | Fill rate | Slippage | Wins | Net per contract |
|---|---|---|---|---|---|---|---|
| 3% | $10,143.35 | $257.70 | 25% | 89.6% | 0.00¢ | 8/8 | +6.47¢ |
| 7% | $10,240.02 | $434.65 | 62.5% | 91.2% | 0.05¢ | 8/8 | +6.43¢ |

- One SOL signal had unknown volume (a recorded trade-stream gap), so it was 0 contracts on both lines.
- Observed median depth within 1¢ was BTC $5,054 / ETH $665 / SOL $867, vs backtest medians $8,822 / $1,118 / $1,170.
- Refill: depth at the original limit usually goes to $0 by 30 s, because the ask moves up. Depth within 1¢ of the new best ask is ~$2,000–2,300.

**Limits:**
- REST books show only 10 levels, so deep BTC books may be under-seen.
- The participation window is the 60 s before the signal, not the backtest's entry candle.
- Live trades are polled every ~2 s, so the last ~2 s can be undercounted (conservative).
- XRP has a cap, but v1 does not trade XRP.
- Few signals so far. UNPROVEN.

## Kalshi LIVE pilot (Stage Z) · REAL MONEY · ships DISABLED

`server/live/kalshi-pilot.js` + `server/live/kalshi-rest.js` (the only file in the repo that names Kalshi order endpoints or builds an order).
Follows frozen paper v3's **7% line** (`decision: take`) with real money: frozen config `config/frozen/kalshi-live-pilot.json`
(version p3, sha256 `0da14a1b0f909942cef51019fb83a3e233b6f36e1a4d6d14f176af91b20c8d31`, pinned in code; any edit refuses to load).
v1/v2/v3 paper code and configs are untouched; the pilot only reads v3's rows after v3 wrote them. The order path is **REST over HTTPS only**
(no websocket; the WS recorder stays read-only market data).

**Rules (frozen, p3):** **bankroll = the FULL live Kalshi balance** + the pilot's own open cost (already out of cash). There is no bankroll cap:
a $400 account counts $400, a $90 account counts $90, and size **compounds** with wins and deposits · per trade 7% of that bankroll (7% of $400 = $28),
also capped by the v3 asset caps (BTC $5,000 / ETH $400 / SOL $250) and 10% of known volume · **total open risk ≤ the live bankroll** · if the balance
can't be read at all: shadow skips the decision, ARMED halts · **Loss limit: $150 realized since start (halts permanently)**: when cumulative realized
pilot P&L (real fills and fees) reaches −$150, the pilot HALTs until `data/live/kalshi-pilot/RESET_TOTAL_STOP` exists *and* `RESET PILOT` is typed on
the desk machine. It is the only fixed guardrail. **It can be overshot:** it is checked after each settlement, and one trade at 7% of a large balance
can lose more than $150 by itself (7% of $3,000 = $210; the per-asset caps bound one trade at about $5,000 BTC / $400 ETH / $250 SOL plus fees). Open
trades also don't count until they settle, so the realized loss at the halt can be well past $150 · **Daily stop: OFF**, shrink OFF (paper arms have none;
`dailyLossStopCents`/`shrinkToDailyBudget` exist, are tested, and default to null/false) · KXBTC15M / KXETH15M / KXSOL15M only · YES BUY only ·
limit ≤ ask+1¢ and ≤ 98¢ · IOC · up to 3 slices 10 s apart · only inside v3's window (360–600 s left) · hold to settlement.

**Sizing follows the current balance (no restart).** Every decision, shadow or live, is 7% of the bankroll *at that moment*. ARMED re-reads the
balance before every slice; DISARMED/shadow does a read-only signed `GET /portfolio/balance` before each decision (only when the key and
`LIVE_PILOT_ENABLED` are present), throttled to once per 20 s with a 4 s timeout. A failed read never halts: the balance is marked **stale** and the
last value is used; with no balance ever read, the decision is skipped (ARMED halts instead). Because the bankroll is the full balance, deposits,
withdrawals and Bryan's other trading change the size of the next decision. Every shadow, compare and live row on the card, and
every `order_intent`/`slice_skip`/`shadow` ledger row, carries `sizing` = bankroll used, 7%, target $, order $ (contracts × limit) and which cap
bound (7% line / asset cap / 10% volume / open-risk / balance).

**Main account (no subaccount).** The pilot trades in Bryan's main Kalshi account. **Other positions and orders in that account are never managed
or cancelled** (the cash balance is counted for sizing) (no cancel-all; HALT cancels only the pilot's own `hp1-…` orders). Because the balance moves with unrelated
activity, the balance check compares only the pilot's **own** fills and fees (fill price ≤ its limit, fills = acks, settlement credit ≥ its own
payout); an unrelated deposit, withdrawal or trade never halts it. Preflight requires the balance to cover the money about to be risked.
(Optional `KALSHI_TRADE_SUBACCOUNT` 0–63 switches back to the strict whole-balance check.)

**States:** `DISABLED` (inert: no client, no listeners, no files) → `DISARMED` (SHADOW: would-be orders logged, no money) → `ARMED` → `HALTED`.
Every start is DISARMED (or HALTED if it was); ARMED is never restored. Auto-HALT on: **permission denied** (401 / 403 / insufficient scope on an
order: halts at once, sends nothing else, not even a cancel; the card and ledger say **"this key can't trade, make a read+trade key"**), any other auth
failure, 3 API errors in a row, a send without a clear answer, fills that do not match the ack or exceed the limit, clock skew > 5 s, an exception
in the order path, the kill file `data/live/KILL`, the $150 realized-loss limit, an unreadable balance before an armed slice.
Safety: intent written to `data/live/kalshi-pilot/ledger.jsonl` before every send; deterministic `client_order_id` per slice; reconcile after every
slice and on startup (by listing orders, matched on `client_order_id`); a market is never traded twice; integer cents / micro-dollars; fees from fills.

**Key (process env only; values never printed, logged, returned or sent to the browser; the card shows only the source and set / not set):**
if **both** `KALSHI_TRADE_KEY_ID` and `KALSHI_TRADE_PRIVATE_KEY_PEM` are set the pilot uses that **dedicated trade key**; otherwise it reuses the
**existing desk key** (`KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY_PEM`, or `KALSHI_PRIVATE_KEY_PATH`, exactly as the desk already loads it). Only the
pilot module can sign an order with it, and only when `LIVE_PILOT_ENABLED=true` (exactly) **and** ARMED; every other live order path is a stub.
If the desk key is read-only, the first armed order gets a 401/403 and the pilot halts with "this key can't trade, make a read+trade key".
`*.pem`, `kalshi_trade_key*` and `hawse.env` are git-ignored.

**Routes:** `POST /api/live/kalshi-pilot/halt` (works from the phone through the proxy when `pilot-halt` is in `HAWSE_PROXY_ALLOW_POST`; the desk
HALT also halts an ARMED pilot). `POST /api/live/kalshi-pilot/arm|disarm|reset|test-key`: loopback socket only, refused if any forwarding header is
present, JSON + same-origin; the proxy hard-blocks them whatever the allowlist says. **Test key (read-only balance check)** (`test-key`, card button
on the desk machine) makes signed GETs only (balance, plus the key list to read scopes), places no orders, writes no ledger rows and works while
DISABLED: it shows the balance and, if Kalshi reveals scopes, whether trade scope is present; otherwise "trade scope can't be verified until the
first armed order". Arming also needs the flag, the key, a read-only preflight (balance, scope if visible, clock) and the typed phrase `ARM LIVE $150 LOSS LIMIT` (derived in code from the frozen `lossLimitCents`, so it can't drift).

**Setup on the desk PC (Bryan):**
1. (a) Confirm the desk's existing Kalshi key is in `C:\HAWSE\hawse.env` (`KALSHI_API_KEY_ID` plus `KALSHI_PRIVATE_KEY_PEM` or `KALSHI_PRIVATE_KEY_PATH`;
   it is already there if the desk shows live Kalshi data). The card should read "Kalshi key: set (existing desk key)".
2. (b) On the desk PC, press **Test key (read-only balance check)** on the LIVE pilot card. It should say OK with your balance. No order is placed.
3. (c) Add `LIVE_PILOT_ENABLED=true` to `C:\HAWSE\hawse.env`, restart the desk, and watch the **SHADOW** rows (would-be orders, no money) for a while.
4. Arming is a separate, deliberate step: type `ARM LIVE $150 LOSS LIMIT` on the desk machine. Every restart comes back DISARMED. HALT is always on the card.
