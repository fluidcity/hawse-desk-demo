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

More stages are added below as they land.

### 1. Funding arb

The desk goes long the perp on the venue paying the lowest funding and short where it is highest. Rates are normalized to hourly so the model works across intervals (Binance/Bybit 8h or 4h, OKX from `nextFundingTime − fundingTime`, Hyperliquid 1h).

A pair qualifies only if the funding spread over `FUNDING_HOLD_HOURS` beats all of the following costs by `FUNDING_MIN_NET_BPS`:
- 4 taker fills (open and close on both legs; per-venue fees in `server/lib/fees.js`)
- 4 slippage fills (half-spread plus square-root impact against depth)
- a basis-risk buffer (½ of the current mark-price basis plus 2 bp)

While a position is open, funding settles discretely at each venue's next settlement time. Legs are marked to market, so basis moves show up as PnL. The pair closes when the spread flips or after 72h.

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

- From some regions Binance returns HTTP 451 and Bybit returns 403. They then show NO DATA and the arb runs on the venues that answer.
- Funding arb fills are modeled at the observed top of book plus impact. Real queue position, partial fills and venue downtime are not modeled.
