# Always-on recorder on Cloudflare (H7 design, NOT deployed)

Status: design plus a tested skeleton in `cloudflare/recorder/`. Nothing has been deployed, and no Cloudflare resource
(Worker, Durable Object, R2 bucket, token) has been created. The connected account is a standard account. Deploying is
your call (Bryan), and it needs the Workers Paid plan (see cost below).

## Why

The box recorder stops whenever the box sleeps or the desk restarts, and every stop leaves a gap in the 8-week frozen
test (gaps are logged, never filled). A Durable Object (DO) on Cloudflare runs regardless of the box. The box still
runs the desk and the analysis; it just pulls the recorded files.

## Feasibility

| Need | Cloudflare piece | Notes |
|---|---|---|
| Poll about every 1 s | DO **alarm** that re-arms itself (`setAlarm(next second)`) | Cron Triggers have 1-minute granularity, too coarse for 1 s books. Alarms have ms precision and are at-least-once, so the handler re-arms first and rows carry `rx` to dedupe. |
| Kalshi public REST | `fetch()` from the DO | The same endpoints the box uses: `GET /markets?series_ticker=…&status=open` once a minute, and `GET /markets/{tk}/orderbook?depth=10` each second per live market (4 series ≈ 4–8 req/s). |
| Optional authenticated WS | outbound `WebSocket` from the DO | Works (WebCrypto has Ed25519 for the signature). An open outbound socket keeps the DO **non-hibernatable**, so it bills duration 24/7. That still fits the included GB-s (below). Not in the skeleton; add it only after the read-only key exists (docs/kalshi-api-key.md). |
| Durable storage | **R2**, one gzipped JSONL object per minute | `rec/<UTC day>/kalshi.book.<HHMMSS>-cf.jsonl.gz`. The row shape is the box recorder's `kalshi.book` plus `src:'cf'`. |
| Eviction / restart | constructor writes a `gap` row (`reason:'do-start'`) | The in-memory buffer (≤ 60 s) can be lost on eviction. That shows up as an explicit gap, never as silent data. |
| Location | `locationHint: 'enam'` (US East) | Kalshi is US-hosted, so latency stays low. |

The skeleton contains no order path. `getPublic()` refuses anything that isn't an https GET to a `*.kalshi.com`
`/trade-api/v2/markets[/<ticker>/orderbook]` path. The Worker entry only routes `/status`, plus `POST /start` and
`POST /stop`, behind a `STATUS_TOKEN` bearer secret. `test/cf-recorder.test.js` checks all of this.

## Monthly cost (Cloudflare list prices, fetched 2026-10-30)

Assume one DO that is always active (1 s alarms keep it awake), 4 series, and 1-minute R2 objects.

| Item | Usage / month | Included (Workers Paid) | Billable |
|---|---|---|---|
| Workers Paid plan | n/a | n/a | **$5.00** minimum |
| DO requests (alarm invocations count; WS messages bill 20:1) | ≈ 2.6 M alarms (+ ~4 control) | 1 M | 1.6 M × $0.15/M ≈ **$0.24** |
| DO duration (billed at 128 MB wall-clock while active) | 2.59 M s × 0.125 GB ≈ 324 k GB-s | 400 k GB-s | **$0** |
| DO storage (SQLite: `running` flag + alarm writes) | tiny; each `setAlarm` is a write | 1 M rows written / 50 M read | ≈ $0–2.6 (if alarm writes are billed as row writes: 1.6 M × $1/M ≈ $1.60) |
| Outbound `fetch` subrequests | ≈ 10–20 M | not billed separately on Workers Paid | $0 |
| R2 Class A (PUT) | 43,200 | 1 M | $0 |
| R2 storage (box rate ≈ 210 MiB/day gzipped → ~6.3 GB per month, cumulative) | month 1 ≈ 3 GB-avg; month 2 ≈ 9 GB-avg | 10 GB-month | ≈ $0 for the first month, then $0.015/GB-month (≈ $0.10–0.20 at 8 weeks) |
| R2 egress to the box | ~6 GB | free | $0 |

**Estimate: about $5.25–$7/month**, mostly the $5 plan minimum. The free plan's DO limits (100k requests/day,
13k GB-s/day) would just about fit one 1 s object (86.4k alarms, 10.8k GB-s per day). That leaves almost no headroom,
so plan on Paid. Turning the WS on adds no meaningful cost: WS messages bill at 20:1, and the DO is already awake 24/7.

## Rate limits and IP (Kalshi 429s)

- Kalshi's Basic tier is about 20 read req/s. The skeleton uses about 4–8/s plus discovery. Kalshi sends **no
  Retry-After**, so on a 429 the skeleton writes a `gap` row (`reason:'http-429'`) for that market and skips the tick.
  It never retries in a tight loop.
- Workers egress from **shared Cloudflare IPs**. Unauthenticated public REST is rate-limited per IP, so other
  tenants' traffic to Kalshi from the same egress could, in principle, trigger 429s we didn't cause. This is the main
  risk, and it can't be tested until the Worker is deployed. Two mitigations:
  1. Watch `s429` on `/status` during the first day.
  2. If it's non-zero, switch to the authenticated WS with the read-only key. Limits then apply per key rather than
     per IP, and one socket replaces about 5 req/s of polling.
- Don't run the box poller and the CF poller against Kalshi at full rate during the same window unless you need a
  comparison. They are separate IPs, so they don't share a bucket, but it doubles our load.

## How the box gets the data

Recommended: an **R2 read-only API token scoped to the one bucket** (create it in the dashboard under R2 → Manage API
tokens → "Object Read only" → this bucket). Keep its access key ID and secret in `/home/box/secrets/` (chmod 600) as env
vars, and never put them in the repo. The box then pulls through the S3-compatible endpoint every few minutes:

```
# example (rclone remote configured from env vars; not set up yet)
rclone copy r2:hawse-recorder/rec /workspace/hawse-desk-demo/data/recorder-cf --max-age 2h
```

The pulled files are gzipped JSONL with the box recorder's row shapes, so the replay and analysis code reads them
directly. Merging rule: when both sources have a row for the same market and second, prefer the box row. CF rows fill
the box's gaps, and every row keeps `src:'cf'`, so a fill is always visible. A future stage can add the `data/recorder-cf`
directory to the storage panel and its cap.

Alternative: an authenticated Worker `GET /files?day=…` that streams R2 objects. It works, but every download then
costs a Worker request, and the bearer token has to live on the box anyway. The S3 token is simpler.

## Steps to deploy (for Bryan; GrokBot has not done any of these)

1. Workers Paid plan on the account.
2. `npx wrangler r2 bucket create hawse-recorder`
3. `cd cloudflare/recorder && npx wrangler secret put STATUS_TOKEN` (type a random value; don't commit it).
4. `npx wrangler deploy` (the `npm run deploy` script deliberately refuses, so it's never run by accident).
5. `curl -X POST -H "authorization: Bearer $STATUS_TOKEN" https://hawse-recorder.<subdomain>.workers.dev/start`, then
   check `/status` (`polls`, `rows`, `s429`, `flushes`).
6. Create the R2 read-only token and set up the box pull.

## Tested vs not tested

- Tested: `node --test test/cf-recorder.test.js`. The DO class runs in Node with a fake storage, R2 and fetch:
  - the alarm grid;
  - book normalization;
  - the 1-minute gzipped flush;
  - the 429 gap row;
  - the do-start gap;
  - start and stop;
  - the token gate;
  - the GET-only path allowlist.
- `wrangler deploy --dry-run` bundles cleanly (6.2 KiB) with the expected bindings.
- Local `wrangler dev --local` run (2026-10-30, about 3:12 PM PT, from the box IP, with a throwaway local token outside the repo):
  - ~65 s: 86 alarm polls, 339 book rows across the 4 live 15m markets, 0 errors.
  - 1 R2 flush of 249 rows. It was gzip and decoded correctly, and the first row was the `do-start` gap.
  - 1 × 429, recorded as a gap row. The box desk recorder was polling from the same IP at the time, so this is a hint of the shared-IP risk.
- Not tested: anything on Cloudflare itself (no deploy). That includes real alarm jitter, eviction frequency, shared-IP
  429 behaviour, and actual billing.
