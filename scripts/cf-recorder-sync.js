#!/usr/bin/env node
'use strict';
// Pull the always-on Cloudflare recorder's chunks to the desk (data/recorder/cf/<day>/<id>-cf.jsonl.gz) and print its status.
// Needs CF_RECORDER_URL and CF_RECORDER_READ_TOKEN in the PROCESS env, e.g.:
//   (set -a; . /home/box/secrets/hawse-cf-recorder.env; set +a; node scripts/cf-recorder-sync.js)          # sync once + status
//   (set -a; . /home/box/secrets/hawse-cf-recorder.env; set +a; node scripts/cf-recorder-sync.js --status) # status only
// Prints counts only; never prints the token. Read-only on the remote (the READ token cannot start/stop it).
const path = require('path');
const { CfRecorderRemote } = require('../server/recorder/cf-remote');

async function main(argv = process.argv.slice(2), env = process.env, out = (s) => console.log(s)) {
  const r = new CfRecorderRemote({ url: env.CF_RECORDER_URL, token: env.CF_RECORDER_READ_TOKEN, dir: env.CF_RECORDER_DIR || path.join(__dirname, '..', 'data', 'recorder', 'cf'), statusMs: 60000, log: () => {} });
  if (!r.configured) { out('cf-recorder: not configured (CF_RECORDER_URL https://… and CF_RECORDER_READ_TOKEN must be set in the env)'); return 2; }
  await r.status();
  if (!argv.includes('--status')) { const s = await r.sync({ max: +(argv.find((a) => a.startsWith('--max=')) || '--max=5000').slice(6) }); out(`sync: fetched ${s.fetched} chunk(s), ${s.bytes || 0} bytes · lastId ${s.lastId}`); }
  const v = r.view();
  out(`status: ${v.state.toUpperCase()}${v.staleReason ? ' (' + v.staleReason + ')' : ''} · running ${v.running} · last write ${v.lastWriteAgeS}s ago · stored ${v.stored ? v.stored.chunks + ' chunks / ' + v.stored.rows + ' rows / ' + v.stored.bytes + ' B' : '—'}`);
  out(`http: ${Object.entries(v.http).map(([h, x]) => `${h} ${x.req} req, ${x.s429} 429 (${(100 * x.share429).toFixed(3)}%)`).join(' · ')} · gaps ${v.gaps} · restarts ${v.restarts}`);
  out(`local: ${v.sync.files} chunk(s), ${v.sync.bytes} B, ${v.sync.rows} rows under ${path.relative(process.cwd(), r.dir) || r.dir}`);
  return v.stale ? 1 : 0;
}
if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error('cf-recorder: ' + String(e.message || e)); process.exit(3); });
module.exports = { main };
