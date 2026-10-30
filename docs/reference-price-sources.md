# Reference price sources (H7)

What Kalshi settles on, which inputs to that index we can read for free, and what's worth paying for.
Researched 2026-10-30 (PT). Prices and constituent lists change, so recheck the linked sources before relying on them.

## What Kalshi settles on

- KXBTC15M / KXETH15M / KXSOL15M / KXXRP15M use **CF Benchmarks Real Time Indices**: BRTI, ETHUSD_RTI,
  SOLUSD_RTI and XRPUSD_RTI. A 15-minute market compares the **simple average of the 60 one-second index values just
  before close** with the same average just before open. **≥ resolves YES**, so a tie is YES. Missing or incomplete
  data resolves to No. Sources: Kalshi contract terms `CRYPTO15M.pdf` and the help-center article "Crypto Markets".
- BRTI is computed every 200 ms from the consolidated **order books** of its constituents, using a mid-price/volume
  curve with uncrossing and dynamic spacing. It is not a median of last trades (CF RTI methodology v17.0).

## BRTI constituent exchanges (CF list v13.7, 24 Aug 2026)

Bitstamp, **Bullish Exchange**, Coinbase, Crypto.com, Gemini, Kraken, **LMAX Digital**. itBit (Paxos) was suspended
on 27 Jul 2026. The other RTIs (ETH, SOL, XRP) have their own lists in the same PDF. I did not check each of those
one by one.

| venue | free public feed? | status in the desk |
|---|---|---|
| Coinbase | yes, WS `ticker` | wired (H6) |
| Kraken | yes, WS v2 `trade` | wired (H6) |
| Bitstamp | yes, WS `live_trades_*` | wired (H6) |
| Gemini | yes, WS v1 marketdata | wired (H6) |
| Crypto.com | yes, WS `trade.*` | wired (H6) |
| **Bullish** | **yes**: unauthenticated WS `wss://api.exchange.bullish.com/trading-api/v1/market-data/trades` (topic `anonymousTrades`, `keepalivePing`; at most 100 unauthenticated connections per IP) and REST `/trading-api/v1/markets/<SYM>/trades` | **wired now (H7)**; verified live 2026-10-30 for BTCUSD/ETHUSD/SOLUSD. Bullish XRPUSD last traded 2026-09-24, so it rarely counts as fresh. |
| **LMAX Digital** | **no**. The market-data API needs an LMAX account, an API key with the "Market Data" scope and a bearer token, and the API agreement requires a funded account. | not wired. The paid route is CoinAPI's LMAX add-on (about $500/mo). |

The desk's `ref` row is a **BRTI-like median of last trades** from 6 of the 7 venues. It is a research proxy, not the
index. Expect small differences because BRTI uses order-book depth, not trades, and it includes LMAX.

## The free CF index feed (best option)

**Kalshi's WebSocket channel `cfbenchmarks_value`** passes through the real CF index values, roughly 1 per second:
`index_id`, the raw CF frame (value + time) and `avg_60s_data`. In the last minute before :00/:15/:30/:45 it also sends
`last_60s_windowed_average_15min`, the number the 15-minute markets settle on. Any Kalshi key can use it, including a
read-only one. It costs nothing extra. There is also a 5 Hz variant for BTC, ETH, SOL, XRP and DOGE.

- Wired as opt-in: `KALSHI_WS=true KALSHI_WS_CF_INDEX=true` plus a read-only key. Rows go to `kalshi.ws.cf`
  (`v`, `avg60`, `q15`). See docs/kalshi-api-key.md. **Not tested live yet; no key on the box.**
- For history, Kalshi has a REST passthrough at `GET /trade-api/v2/cfbenchmarks/history/values?id=BRTI&timespan=…`.
  It needs a signed REST GET, and the desk's signer deliberately signs only the WS handshake, so this is **not wired**.
  Adding it would mean a second, equally narrow signer for that one GET path, which should be reviewed separately.
- cfbenchmarks.com/data/indices/BRTI shows the index on a web page. That's not an API, so I didn't scrape it.

## Paid options (only if the free route isn't enough)

| option | price (public) | what you get | verdict |
|---|---|---|---|
| CF Benchmarks direct data licence (REST/WS, API key) | not published; ask sales. Disclosed ETF *index-use* licences run $5k per pair per quarter or bps of AUM, which is a different product. | BRTI/RTI at 200 ms, full history | Not needed. Kalshi's `cfbenchmarks_value` already gives the settlement index for free. |
| CoinAPI | Startup $79/mo, Streamer $249/mo, Pro $599/mo (PAYG with $25 free credit); LMAX Digital add-on about $500/mo | normalized trades/quotes/books from 400+ venues; with the add-on, LMAX L2 | Only worth it if a full 7/7 order-book rebuild of BRTI becomes a research goal. Then Streamer plus the LMAX add-on is about $750/mo. |
| Kaiko | from about $1,000/mo (L1 aggregations) to about $2,500/mo (L2 tick) | institutional normalized data | Overkill for this desk. |

**Recommendation:** use the free Kalshi `cfbenchmarks_value` feed with the read-only key. Keep the 6-venue median as an
independent cross-check. Don't pay for anything yet.

## Sources

- CF Benchmarks constituent list PDF (v13.7) and RTI methodology PDF; cfbenchmarks.com BRTI page and blog
  ("Who signs the price", "Suspension of itBit Paxos").
- docs.lmax.com Broker Market Data API; LMAX Digital API Agreement; coinapi.io/lmax; coinapi.io pricing.
- github.com/bullish-exchange/api-docs (trading-api yml, public endpoints and the unauthenticated trades WS), plus a
  live probe on 2026-10-30.
- docs.kalshi.com: CF Benchmarks Value Feed, CF REST passthrough, WebSocket auth; Kalshi `CRYPTO15M.pdf`; help-center
  "Crypto Markets".
- Kaiko prices are from a third-party comparison page (rfp.wiki), not Kaiko itself.
