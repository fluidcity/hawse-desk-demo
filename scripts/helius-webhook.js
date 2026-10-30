#!/usr/bin/env node
'use strict';
// Admin helper: register / update / pause / resume / delete the Helius webhook that feeds POST /hooks/helius.
//
//   node scripts/helius-webhook.js plan                 # default; DRY RUN, makes no network calls
//   node scripts/helius-webhook.js upsert --apply       # create, or update the webhook whose URL matches (100 credits)
//   node scripts/helius-webhook.js pause  --apply       # PATCH active:false (stop the 1-credit/event charges)
//   node scripts/helius-webhook.js resume --apply
//   node scripts/helius-webhook.js delete --apply       # 100 credits
//   node scripts/helius-webhook.js list   --apply       # GET /v0/webhooks (Helius does not document a credit price for this)
//
// Reads from env / .env only: HELIUS_API_KEY, HELIUS_WEBHOOK_URL (public https), HELIUS_WEBHOOK_AUTH (shared secret),
// HELIUS_WEBHOOK_ADDRESSES (else HELIUS_WATCH_ADDRESSES, else FOLLOW_WALLETS_SOL), HELIUS_WEBHOOK_TX_TYPES (default SWAP,TRANSFER).
// It NEVER prints the API key or the auth secret: the key travels only in the request URL, and errors are redacted.
// Every create/edit/delete is 100 credits and is recorded in data/credits.json against HELIUS_CREDIT_BUDGET.
const path = require('path');
const config = require('../server/config');
const { CreditBudget } = require('../server/lib/credits');
const H = require('../server/feeds/helius');
const { DEFAULT_SOL_WATCH } = require('../server/feeds/whales');

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const BUSY = new Set(DEFAULT_SOL_WATCH.map((w) => w.addr));

/** Pure: validate env + args into a plan. Never includes secret values (only whether they are set). */
function buildPlan(env, argv) {
  const cmd = (argv.find((a) => !a.startsWith('--')) || 'plan').toLowerCase();
  const apply = argv.includes('--apply'), allowBusy = argv.includes('--allow-busy-pools');
  const url = env.HELIUS_WEBHOOK_URL || '';
  const addresses = list(env.HELIUS_WEBHOOK_ADDRESSES).length ? list(env.HELIUS_WEBHOOK_ADDRESSES) : list(env.HELIUS_WATCH_ADDRESSES).length ? list(env.HELIUS_WATCH_ADDRESSES) : list(env.FOLLOW_WALLETS_SOL);
  const txTypes = list(env.HELIUS_WEBHOOK_TX_TYPES).length ? list(env.HELIUS_WEBHOOK_TX_TYPES) : ['SWAP', 'TRANSFER'];
  const errors = [], warnings = [];
  if (!['plan', 'upsert', 'pause', 'resume', 'delete', 'list'].includes(cmd)) errors.push('unknown command ' + cmd);
  if (!env.HELIUS_API_KEY) errors.push('HELIUS_API_KEY is not set');
  if (cmd === 'upsert' || cmd === 'plan') {
    if (!env.HELIUS_WEBHOOK_AUTH) errors.push('HELIUS_WEBHOOK_AUTH is not set (the receiver rejects every delivery without it)');
    let u = null; try { u = new URL(url); } catch { errors.push('HELIUS_WEBHOOK_URL must be a full public https URL ending in /hooks/helius'); }
    if (u && u.protocol !== 'https:') errors.push('HELIUS_WEBHOOK_URL must be https');
    if (u && /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[?::1)/.test(u.hostname)) errors.push('HELIUS_WEBHOOK_URL must be publicly reachable (Helius cannot reach localhost/private IPs)');
    if (!addresses.length) errors.push('no addresses: set HELIUS_WEBHOOK_ADDRESSES (or HELIUS_WATCH_ADDRESSES / FOLLOW_WALLETS_SOL)');
    if (addresses.length > 100000) errors.push('Helius allows at most 100,000 addresses per webhook');
    const busy = addresses.filter((a) => BUSY.has(a));
    if (busy.length && !allowBusy) errors.push(`refusing to watch busy AMM pool(s) ${busy.map((a) => a.slice(0, 4) + '…').join(', ')}: every swap is a 1-credit event and a major SOL-USDC pool can exceed the 1M/month free plan by itself. Watch wallets instead, or pass --allow-busy-pools`);
    if (busy.length && allowBusy) warnings.push('busy AMM pools included: watch the credit meter in the Data Sources panel and pause if needed');
  }
  if (['pause', 'resume', 'delete'].includes(cmd) && !url) errors.push('HELIUS_WEBHOOK_URL is required to pick which webhook to ' + cmd);
  // pause/resume priced as an edit (assumption; Helius lists create/edit/delete = 100 credits each)
  const cost = { plan: 0, list: 0, upsert: H.CREDITS.webhookManage, delete: H.CREDITS.webhookManage, pause: H.CREDITS.webhookManage, resume: H.CREDITS.webhookManage }[cmd] || 0;
  return { cmd, apply, url, addresses, txTypes, cost, errors, warnings,
    body: { webhookURL: url, webhookType: 'enhanced', transactionTypes: txTypes, accountAddresses: addresses, txnStatus: 'success', authHeader: env.HELIUS_WEBHOOK_AUTH ? '<HELIUS_WEBHOOK_AUTH>' : '' } };
}

const redactAll = (s, env) => [env.HELIUS_API_KEY, env.HELIUS_WEBHOOK_AUTH].filter(Boolean).reduce((x, k) => x.split(k).join('***'), String(s)).replace(/api-key=[^&\s]+/g, 'api-key=***');

async function call(env, method, sub, body) {
  const r = await fetch(H.WEBHOOKS_URL + sub + '?api-key=' + encodeURIComponent(env.HELIUS_API_KEY), { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const text = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const describeHook = (w) => ({ webhookID: w.webhookID, webhookURL: w.webhookURL, webhookType: w.webhookType, active: w.active, addresses: (w.accountAddresses || []).length, transactionTypes: w.transactionTypes });

async function main(env = process.env, argv = process.argv.slice(2)) {
  const p = buildPlan(env, argv);
  console.log(`helius-webhook ${p.cmd}${p.apply ? ' (APPLY)' : ' (dry run: no network calls)'}`);
  console.log(`  url: ${p.url || '(unset)'} · addresses: ${p.addresses.length} · types: ${p.txTypes.join(',')} · HELIUS_API_KEY ${env.HELIUS_API_KEY ? 'set' : 'unset'} · HELIUS_WEBHOOK_AUTH ${env.HELIUS_WEBHOOK_AUTH ? 'set' : 'unset'}`);
  console.log(`  credit cost of this command: ${p.cost} (webhook create/edit/delete = 100; each delivered event = 1)`);
  p.warnings.forEach((w) => console.log('  warning: ' + w));
  if (p.errors.length) { p.errors.forEach((e) => console.log('  error: ' + e)); if (p.cmd !== 'plan') process.exitCode = 2; return p; }
  if (!p.apply || p.cmd === 'plan') { console.log('  nothing sent. Re-run with a command and --apply to execute.'); return p; }
  const cfg = config.build(env);
  const budget = new CreditBudget({ provider: 'helius', budget: cfg.helius.creditBudget, planCredits: H.CREDITS.freePlanMonthly, file: cfg.creditsFile });
  if (p.cost && !budget.trySpend(p.cost, 'webhook-manage')) { console.log(`  refused: credit budget guard (${budget.view().used}/${budget.budget} used this month)`); process.exitCode = 3; return p; }
  try {
    const hooks = await call(env, 'GET', '');
    const mine = p.url ? (Array.isArray(hooks) ? hooks : []).find((w) => w.webhookURL === p.url) : null;
    if (p.cmd === 'list') { console.log(JSON.stringify((hooks || []).map(describeHook), null, 2)); return p; }
    const body = { ...p.body, authHeader: env.HELIUS_WEBHOOK_AUTH };
    if (p.cmd === 'upsert') { const r = mine ? await call(env, 'PUT', '/' + mine.webhookID, body) : await call(env, 'POST', '', body); console.log((mine ? 'updated ' : 'created ') + JSON.stringify(describeHook(r))); }
    else if (!mine) { console.log('  no webhook with that URL'); }
    else if (p.cmd === 'delete') { await call(env, 'DELETE', '/' + mine.webhookID); console.log('  deleted ' + mine.webhookID); }
    else { const r = await call(env, 'PATCH', '/' + mine.webhookID, { active: p.cmd === 'resume' }); console.log('  ' + p.cmd + 'd ' + JSON.stringify(describeHook(r))); }
  } catch (e) { console.log('  failed: ' + redactAll(e.message, env)); process.exitCode = 1; }
  return p;
}

if (require.main === module) { config.loadDotEnv(path.join(__dirname, '..', '.env')); main(); }
module.exports = { buildPlan, main, redactAll };
