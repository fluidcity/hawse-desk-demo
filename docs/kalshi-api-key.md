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
| `KALSHI_PRIVATE_KEY_PEM` | alternative: the PEM inline with literal `\n` escapes |
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

## 4. Status

**Not tested live.** No Kalshi key existed on the box when this was built. The signer is verified with locally
generated Ed25519 and RSA keys against `crypto.verify`. The recorder is verified against a fake socket using the
message shapes in Kalshi's docs. Node 24's built-in WebSocket was checked to send custom handshake headers. An
unauthenticated connect to the real endpoint closes (1006), as the docs say it should. Once the key is in place, the
first live run should confirm the Recorder card shows `open` and that `kalshi.ws.book` rows appear within seconds.
