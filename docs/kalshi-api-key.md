# Kalshi API key: read-only, for market-data WebSocket only

The desk is paper-only. It has no code that places, amends, or cancels orders, and none that reads portfolio, balance,
fills, or positions. Kalshi's WebSocket needs a signed handshake **even for public market-data channels**, though,
so the optional WS recorder needs a key. Create a **read-only** key. If the key leaked, the worst anyone could do is
read data.

## 1. Create a read-only key (Bryan, about 2 minutes)

**Web UI**
1. Sign in at kalshi.com and open **Account & security**, then **API keys** (or go straight to `https://kalshi.com/account/profile`).
2. Click **Create key** and name it something like `hawse-desk-readonly`.
3. Under permissions, keep **Read all data** ticked and **untick Full access**. That also clears *Trade* and *Transfers*.
   Kalshi's docs say a key created without scopes gets full access, so check that only `read` is left.
4. Choose **Ed25519** if you're offered a key type. It's Kalshi's default and recommended type; RSA works too.
5. Kalshi shows the **Key ID** and downloads the **private key** file **once**. Save the file; Kalshi can't show it again.

**API alternative.** `POST /trade-api/v2/api_keys/generate` with `{"name":"hawse-desk-readonly","scopes":["read"]}`.
That request needs an existing authenticated key, so the UI is simpler.

Sources: docs.kalshi.com (API keys, scopes, WebSocket connection and authentication), read 2026-10-30. The UI steps
also match a third-party walkthrough from realize.tax (2026-10-08). The UI labels may move.

## 2. Store it on the box (never in the repo)

```bash
mkdir -p /home/box/secrets && chmod 700 /home/box/secrets
mv ~/Downloads/<downloaded-key>.pem /home/box/secrets/kalshi-readonly.pem   # or upload it there
chmod 600 /home/box/secrets/kalshi-readonly.pem
```

Add these lines to an env file outside the repo, for example `/home/box/secrets/hawse-webhook.env` or a new
`/home/box/secrets/kalshi.env`, or to the repo's gitignored `.env`:

```
KALSHI_API_KEY_ID=<key id>
KALSHI_PRIVATE_KEY_PATH=/home/box/secrets/kalshi-readonly.pem
KALSHI_WS=true
# optional: the CF Benchmarks RTI values Kalshi settles on (BRTI, ETHUSD_RTI, ...), ~1/s
KALSHI_WS_CF_INDEX=true
```

Env var names (values are never committed or logged):

| name | meaning |
|---|---|
| `KALSHI_API_KEY_ID` | key id (not secret by itself, but still kept out of the repo) |
| `KALSHI_PRIVATE_KEY_PATH` | absolute path to the PEM file (preferred) |
| `KALSHI_PRIVATE_KEY_PEM` | alternative: the PEM inline. Real newlines, CRLF, literal `\n` escapes, or a PEM whose newlines were flattened to spaces (or removed) all load: `normalizePem` re-wraps the base64 body between the armor lines |
| `KALSHI_ENV` | `prod` (default) or `demo`; picks the default socket URL (`api.elections.kalshi.com` or `demo-api.kalshi.co`). Prod keys don't work on demo and the reverse |
| `KALSHI_WS` | `true` turns the WS recorder on (default **off**) |
| `KALSHI_WS_URL` | default `wss://api.elections.kalshi.com/trade-api/ws/v2`; only `wss://*.kalshi.com` / `*.kalshi.co` on `/trade-api/ws/v2` is accepted |
| `KALSHI_WS_CF_INDEX` / `KALSHI_WS_CF_INDEX_IDS` | opt-in `cfbenchmarks_value` channel / index ids |
| `KALSHI_WS_EXTRA` | also stream the daily/sports series the REST recorder tracks |

Restart the desk the usual way (`set -a; . <env file>; set +a; npm start`). The Recorder card's "Kalshi WebSocket"
line should show `open` with snapshot, delta, and trade counts. With no key it shows "no Kalshi key configured" and
opens no socket.

## 3. What the code does with the key

- `server/kalshi-auth/ws-sign.js` is the **only** file in the repo that signs anything. It signs exactly
  `<ms timestamp> + "GET" + "/trade-api/ws/v2"`, using Ed25519 or RSA-PSS-SHA256 depending on the key. The method and
  path are constants, and the returned function takes no arguments, so it can't sign a REST or order request. The
  file has no network code.
- `server/recorder/kalshi-ws.js` receives only that header function. Every outgoing frame goes through an allowlist:
  the `subscribe` and `update_subscription` commands only (`add_markets`, `delete_markets`, `get_snapshot`), on the
  channels `orderbook_delta`, `trade` and (opt-in) `cfbenchmarks_value`. Private channels (`fill`, `market_positions`,
  `user_orders`, …) are refused before sending.
- Tests in `test/kalshi-ws.test.js` and `test/recorder.test.js` enforce all of this by scanning the source.
- Rows go to `data/recorder/<day>/kalshi.ws.book|trade|cf.*.jsonl` (gitignored). Sequence gaps write a `ws-seq-gap`
  gap marker and request a fresh snapshot.

## 4. Status: live on prod (2026-10-30)

Bryan's key is a **prod** key (RSA 2048, PKCS#1). It arrived in the env as one line with its newlines turned into
spaces, which is why the loader now normalizes the PEM. Checks run from the box, 17:15–17:36 PDT:

- **Auth:** `wss://api.elections.kalshi.com/trade-api/ws/v2` with the signed handshake opened and subscribed with no
  errors. The same host with no auth headers closed with 1006. `demo-api.kalshi.co` with this key also closed with 1006,
  so `KALSHI_ENV=prod` is correct and is the default.
- **Data, first 13 min inside the desk:** 4 markets (the 15m BTC/ETH/SOL/XRP windows), 116k book deltas in the first
  2.5 min (~750k by 12 min), ~80k trades, CF Benchmarks values for BRTI/ETHUSD_RTI/SOLUSD_RTI/XRPUSD_RTI at ~1/s
  each, 0 error frames. The 17:30 rollover dropped the closed markets and added the new ones with fresh snapshots.
- **Exchange timestamps:** each delta and trade row keeps the event `ts_ms` (`ex`) and the frame's `sending_ts_ms`
  (`sx`). `sx − ex` was p50 6 ms, p99 13 ms.
- **Parity against the REST recorder** (trade ids, window 17:18:29–17:29:24 PDT): 64,947 trades by WS, 64,947 by
  REST, 64,947 in both, 0 only on one side, and 0 mismatches in ticker, time, price, size or side.
- **Latency (box receive minus exchange time, same trades):** WS p50 75 ms / p90 80 / p99 127; REST p50 1,304 ms /
  p90 2,150 / p99 4,066. The WS sees the same trade about 1.2 s sooner at the median (2.1 s at p90). Box-clock offset
  is included in both.
- **Reconnect:** the TCP socket was killed with `ss -K`. The client was back, re-signed and re-snapshotted in 1.4 s,
  and wrote a `ws-down closed` gap for the outage.
- **Bugs fixed from the live run:**
  - the space-flattened PEM;
  - Kalshi's *trade* channel skips seq numbers around `add_markets`/`delete_markets` with no trades missing. These
    used to trigger book re-snapshots and are now logged as `ws-trade-seq-gap` only;
  - a drop of an open socket wasn't counted and its outage wasn't recorded until the next 5 s sync.

**Scope.** This key may carry trade permission; the app still uses it for the WS handshake signature only. No code
path builds an order, portfolio, balance or fills request (tests scan the whole repo). A read-only key (section 1)
is still the recommended replacement, so a leaked key could only read data.

**Box pauses.** The WS runs only on the box. When the box VM is paused the socket dies and the WS rows have a gap,
marked by a `ws-down` gap row. The Cloudflare recorder (`hawse-recorder`, REST only, **no Kalshi key**) keeps
recording trades and books through those pauses, and the box pulls its chunks afterwards.
