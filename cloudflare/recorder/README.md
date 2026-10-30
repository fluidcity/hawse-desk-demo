# cloudflare/recorder (DEPLOYED as `hawse-recorder`)

This is an always-on, record-only recorder of Kalshi and Polymarket **public** market data:
- a Durable Object with a 1 s alarm;
- gzipped JSONL chunks stored in its SQLite, with an optional R2 mirror;
- an authenticated pull for the desk.

There is no order path and no exchange key. The only secrets are SHA-256 digests of the desk's bearer tokens, stored as
Worker secrets.

Everything else is in [`../../docs/cloudflare-recorder.md`](../../docs/cloudflare-recorder.md): what it records, the
endpoints, cost and limits, the live verification, how to deploy an update, and **teardown/rollback**.

Tests run from the repo root: `node --test test/cf-recorder.test.js`.
