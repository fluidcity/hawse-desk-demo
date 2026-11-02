#!/usr/bin/env node
'use strict';
// Import a Dune `dex.sandwiched` CSV export as ground truth for the mempool lab (H4). Local file in, local file out.
// No network calls and no Dune API key: run the query in the Dune UI (free tier), export CSV, then:
//   node scripts/mev-import-dune.js path/to/export.csv [--out data/mev/dune-sandwiched.json]
// Suggested query (Ethereum only, recent days):
//   SELECT block_time, block_number, tx_hash, project, amount_usd FROM dex.sandwiched
//   WHERE blockchain = 'ethereum' AND block_time > now() - interval '3' day
// amount_usd there is the VICTIM trade size. Add an attacker_profit_usd column yourself (e.g. joined from
// dex.sandwiches) if you want Dune-side attacker profit; otherwise the lab uses its own receipt-based attacker gross.
const fs = require('fs');
const path = require('path');
const { parseCsv, duneIndex } = require('../server/mev/truth');

const args = process.argv.slice(2); const file = args.find((a) => !a.startsWith('--'));
const oi = args.indexOf('--out'); const out = oi >= 0 ? args[oi + 1] : path.join(__dirname, '..', 'data', 'mev', 'dune-sandwiched.json');
if (!file) { console.error('usage: node scripts/mev-import-dune.js export.csv [--out file.json]'); process.exit(2); }
const rows = parseCsv(fs.readFileSync(file, 'utf8')); const idx = duneIndex(rows);
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rows.filter((r) => idx.has((r.tx_hash || r.victim_tx_hash || '').toLowerCase()))));
console.log(`imported ${idx.size} sandwiched victim tx hashes (${rows.length} rows read) → ${out}`);
