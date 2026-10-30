# cloudflare/recorder (SKELETON, not deployed)

This is an always-on Kalshi **public** order-book recorder:
- a Durable Object with a self-re-arming 1 s alarm;
- a 1-minute gzipped JSONL flush to R2.

It has no order path, no Kalshi key and no secrets. Design, cost, rate limits, the box pull and the deploy steps are
in [`../../docs/cloudflare-recorder.md`](../../docs/cloudflare-recorder.md). Tests: `node --test test/cf-recorder.test.js`
from the repo root.

Local try-out (doesn't touch your Cloudflare account): put `STATUS_TOKEN=<anything>` in `.dev.vars` (gitignored), then:

```
npx wrangler dev --local
curl -X POST -H "authorization: Bearer <anything>" localhost:8787/start
curl -H "authorization: Bearer <anything>" localhost:8787/status
```
