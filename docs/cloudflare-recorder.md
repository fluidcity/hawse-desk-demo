# Always-on recorder on Cloudflare (H7 Stage L, DEPLOYED 2026-10-30)

**Status: deployed and recording** since 2026-10-30 15:26 PDT, with Bryan's approval.

| | |
|---|---|
| Account | Leadpathqa@proton.me's Account |
| Worker | `hawse-recorder` (one Durable Object class `Recorder`, SQLite-backed, instance `main`, location hint `enam`) |
| URL | https://hawse-recorder.leadpathqa.workers.dev |
| Not touched | the existing `hawse-webhook` Worker, its D1 database and its secrets; every other script on the account |

It is **record-only**. Upstream it makes only public market-data HTTPS GETs. `getPublic()` allowlists:
- Kalshi `*.kalshi.com/trade-api/v2/markets`, `/markets/trades`, `/markets/{ticker}` and `/markets/{ticker}/orderbook`;
- Polymarket `gamma-api /markets`, `clob /book` and `data-api /trades`.

It has no order path, no Kalshi key and no auth header upstream. `test/cf-recorder.test.js` checks all of this.

## What it records (same row shapes as the box recorder, plus `src:'cf'`)

A Durable Object alarm re-arms itself every 1 s. Cron is too coarse for this.

| Stream | Source | Cadence |
|---|---|---|
| `kalshi.book` | `/markets/{tk}/orderbook?depth=10` for the live KXBTC15M / KXETH15M / KXSOL15M / KXXRP15M market | every 1 s |
| `kalshi.trade` | `/markets/trades?ticker=&min_ts=` | every 2 s, deduped by `trade_id` |
| `kalshi.market` | `/markets?series_ticker=&status=open` | every 60 s, and every 2 s around a rollover or while no market is live |
| `kalshi.extra` | top 12 open markets of KXNFLGAME, KXNBAGAME, KXNHLGAME, KXBTCD | one book every 3 s, round-robin |
| `poly.book` | `clob /book` for btc/eth/sol/xrp `-updown-15m-<window>` | every 2 s, written only when the book changes |
| `poly.trade` | `data-api /trades` for the same markets | every 5 s; the wallet field is dropped |
| `gap` | `do-start`, `http-429`, `trade-page-limit`, book polls missing for more than 5 s | as they happen |

How trades are paged: a full trades page (1000) that contains no trade already seen means older trades may be
missing. The recorder then follows Kalshi's cursor, up to `TRADE_PAGES` = 3 pages, and this also applies to a market's
first poll. If the last page is still full, it writes a `trade-page-limit` gap.

How chunks are stored:
- Every 60 s, or sooner once 40k rows are buffered, the buffer becomes one gzipped JSONL **chunk** in the DO's own
  SQLite (`chunks` table).
- Chunks are pruned when they are more than 14 days old or when the total exceeds 2 GiB (`RETAIN_DAYS`, `MAX_BYTES`).
- Counters live in a `meta` table and survive restarts.

**R2 is not enabled on the account.** The API answers 10042, "enable R2 in the dashboard". So chunks live in DO
SQLite. If you enable R2 and add an `r2_buckets` binding named `BUCKET` (see the comment in `wrangler.jsonc`), every
chunk is also mirrored to `rec/<UTC day>/<id>-cf.jsonl.gz`.

## Endpoints

| Route | Auth | Returns |
|---|---|---|
| `GET /health` | public | `ok` / `stale` / `running` / `lastWriteAgeS` only |
| `GET /status` | READ token | the full status listed below |
| `GET /pull/list?after=<id>&limit=` and `GET /pull/chunk?id=` | READ token | chunk metadata; one gzipped chunk |
| `POST /start`, `/stop`, `/restart` | ADMIN token | `/restart` flushes and aborts the DO so a redeploy takes effect at once. A busy DO otherwise keeps running the old code; this happened during the live check. |

`/status` returns health, rows per stream, stored chunks and bytes, last write, alarms, restarts, gaps, requests and
429s per host, and the live markets. Any other path gets 404, and the wrong method gets 405.

## Secrets

- Two random 32-byte tokens, READ and ADMIN, were generated on the box with `openssl rand`. They exist only in
  `/home/box/secrets/hawse-cf-recorder.env` (mode 600), together with `CF_RECORDER_URL`.
- The Worker holds **only their SHA-256 digests** as Worker secrets (`READ_TOKEN_SHA256`, `ADMIN_TOKEN_SHA256`). It
  compares in constant time and never forwards the token to the DO.
- No token or digest is in the repo, a commit, a log or the client bundle. The release checks grep for both the values
  and the digests.
- The desk reads `CF_RECORDER_URL` / `CF_RECORDER_READ_TOKEN` server-side only. The browser gets counts and times.

## The desk side

- `server/recorder/cf-remote.js` polls `/status` every 60 s. Every 10 min it pulls new chunks into
  `data/recorder/cf/<UTC day>/<id>-cf.jsonl.gz` (gitignored; cursor in `sync-state.json`; each file is checked by byte
  length).
- The recorder card and the Storage panel show a **Cloudflare recorder (remote)** line and bar:
  - LIVE only when the last chunk was written less than 3 min ago.
  - Otherwise **STALE** with the reason: the desk can't reach it, the recorder is stopped, nothing has been written
    yet, or the last write is too old.
  - The line also shows rows, the 429 share, gaps, restarts and synced chunks.
- Manual sync and check: `set -a; . /home/box/secrets/hawse-cf-recorder.env; set +a; node scripts/cf-recorder-sync.js`.
  Add `--status` to skip the pull and `--max=N` to limit the number of chunks. It prints counts only. Exit codes: 0 =
  live, 1 = stale, 2 = not configured, 3 = error.
- Merging rule for analysis: when both sources have the same `trade_id` or the same market-second, use the box row.
  CF rows fill the box's gaps, and `src:'cf'` keeps every fill visible.

## Cost and limits

Billing endpoints return 403 to the connector, so the plan itself could not be read. The design fits both plans.

| Item | Measured / projected per month | Workers Free (daily) | Workers Paid |
|---|---|---|---|
| DO requests: alarms (~86.4k/day), desk status (1.4k/day) and pulls (~1.6k/day) | ≈ 2.7 M | ≈ 89.5k of 100k/day (90 %) | 1 M included, then 1.7 M × $0.15/M ≈ **$0.26** |
| DO duration (always awake, billed at 128 MB) | ≈ 2.63 M s × 0.125 GB ≈ 329k GB-s | ≈ 10.8k of 13k GB-s/day (83 %) | 400k GB-s included → **$0** |
| DO SQLite storage (hard cap `MAX_BYTES` 2 GiB) | ≤ 2 GiB | 5 GB | 5 GB included → **$0** |
| SQLite rows written (≈ 2 per flush plus alarm state) | < 0.2 M | 100k/day | 50 M included → **$0** |
| Worker requests (status, pull, health) | ≈ 0.1 M | 100k/day | 10 M included → **$0** |
| Outbound subrequests (≈ 9/s to Kalshi + Polymarket) | ≈ 24 M | not billed | not billed |
| R2 | not used (not enabled) | | |

**Projection on Paid: about $5.26/month**, the $5 minimum plus about $0.26. That's inside the $5–7 budget. The only
growth path is R2, if you enable it: about $0.015/GB-month beyond 10 GB.

On Free it costs $0. If the daily limits are exceeded, the DO errors until the daily reset; nothing is billed. That
would show as STALE plus a `do-start` gap.

CPU per invocation, from Cloudflare analytics at 15:20–15:40 PDT: p50 4.4 ms, p99 21.5 ms, 0 `exceededCpuErrors`.

Storage rate measured live: about 156 KB/min gzipped, about 225 MB/day, and the busiest stream is the BTC 15m trades.
At that rate **the 2 GiB cap binds before 14 days, at about 9 days**. That's fine, because the box keeps its own
copy, synced every 10 min. To keep more on Cloudflare, raise `MAX_BYTES` (up to about 4.5 GiB stays inside the 5 GB
included) and redeploy.

## Live verification (2026-10-30, PDT)

Snapshot at 16:04:47 PDT. The first row was written at 15:26:38. Runs: v1 15:26:38–15:34:06, then a deliberate stop; v2 15:36:34–15:52:15 (15.7 min); a stop to load the new code; v3 from 15:54:45, still running.

- **Stored:** 33 chunks, 186,274 rows, 5.87 MB in DO SQLite. That is about 156 KB/min. One chunk is flushed every ~60 s (33 flushes, 0 errors). There are 1,993 alarms in v3 (about 1 per second) and 0 pruned.
- **Rows by stream:** kalshi.trade 172,544; poly.book 8,000; kalshi.book 7,147; poly.trade 1,634; kalshi.extra 660; gap 55; market rows 36 + 36.
- **One real Kalshi market, KXBTC15M-26OCT301915-15:** 277 books and 15,641 trades. A sample book row: strike 76,715.94, YES bid 0.88 / ask 0.89, fetch latency 49 ms. ETH, SOL and XRP ran alongside, as did Polymarket `btc/eth/sol/xrp-updown-15m` books (1 s) and trades.
- **429s from Cloudflare egress:**
  - Kalshi: 5 of 11,783 requests (0.042 %). One was at 15:42:18. The other four came in a burst at 15:51:01–15:51:12, which left a 16 s `poll-gap` on the four trade streams; books stayed ≤ 3 s apart. The min_ts overlap re-fetched those trades.
  - Polymarket: 0 of 9,644 requests (clob 8,008, data-api 1,600, gamma 36).
- **Continuity against the box recorder:** this compares the sets of Kalshi `trade_id`s for the same markets. "Box-only" means a trade the box recorder has but the Worker does not.
  - v2, the 18:45 ET markets: BTC 19,223 = 19,223; ETH 8,907; SOL 3,253; XRP 2,937. All exact, 0 box-only.
  - v3, the 19:00 ET markets: BTC 38,987, ETH 2,809, SOL 4,213, XRP 1,375. All exact.
  - v3, the 19:15 ET markets, including the 16:00 PDT rollover and the opening seconds: BTC 5,846, ETH 499, SOL 306, XRP 271. 0 box-only and 0 CF-only.
  - Under v1, a busy BTC market lost 3,349 trades to the 1,000-row page limit (40 `trade-page-limit` gaps). v2 added cursor paging to fix that. v3 extended paging to a market's first poll, which had still missed 259 opening trades.
- **CPU (Cloudflare GraphQL analytics):** DO invocations p50 4.4 ms, p99 21.5 ms. 0 exceeded-CPU errors.
- **Auth:** `/status` needs no token. `/pull/*` returns 401 without the read token. The admin routes need the separate admin token.
- **Desk:** the Storage panel's `cf` bar showed LIVE, 5.87 MB of 2.00 GiB. The synced copy under `data/recorder/cf` held 32+ chunk files (`docs/screenshots/h7-cf-recorder-storage.png`). When the Worker is stopped, the bar reads STALE (tested).
- **Sync-state fix:** with the desk and the CLI syncing at the same time, one process could overwrite the other's file and byte totals. Fixed: sync now adopts a newer on-disk cursor and counts files and bytes from disk (test in `test/cf-remote.test.js`).

## Deploying an update

`wrangler.jsonc` is the deployed config. Either of these works:
- `cd cloudflare/recorder && npx wrangler deploy` (a token with Workers Scripts:Edit).
- Upload through the Cloudflare API with the same metadata. Leave out `migrations` after the first deploy; `v1` is
  applied.

Then run `POST /restart` with the ADMIN token, and check that `/status.version` matches `CODE_VERSION`.

## Teardown / rollback

1. **Stop recording:** `POST /stop` with the ADMIN token. This flushes the buffer and deletes the alarm. The DO then
   idles and costs nothing beyond the plan.
2. **Keep the data:** run `node scripts/cf-recorder-sync.js` first. Everything the box has synced stays under
   `data/recorder/cf/`.
3. **Remove it completely:** delete the Worker with `npx wrangler delete hawse-recorder` or
   `DELETE /accounts/<account>/workers/scripts/hawse-recorder`. This also deletes the Durable Object namespace and
   **all chunks stored in it**. It does not touch `hawse-webhook`.
4. **Revoke on the box:** `rm /home/box/secrets/hawse-cf-recorder.env`. Restart the desk without the two
   `CF_RECORDER_*` vars; the panel then shows "not configured", or set `CF_RECORDER=false`.
5. **Roll back code only:** redeploy an earlier commit's `cloudflare/recorder/src/index.js` the same way, then run
   `POST /restart`.

## Tests

`node --test test/cf-recorder.test.js` (8 tests): the GET allowlist, the alarm loop with books, trades, Polymarket and
chunking, 429 and gap rows, trade cursor pagination (including the first poll), early flush, pruning, restart counters,
settlement, STALE, the R2 mirror, Worker auth routing and `/restart`.

`node --test test/cf-remote.test.js` (5 tests): the desk sync cursor and byte check, the STALE reasons, that the token
never appears in the view or in errors, and the CLI.
