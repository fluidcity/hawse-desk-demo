#!/usr/bin/env node
'use strict';
// Admin helper for the ONE Helius enhanced webhook that delivers to the HAWSE inbox (<HAWSE_WEBHOOK_URL>/helius).
// DRY RUN BY DEFAULT: without --apply nothing is sent anywhere (no Helius call, no inbox call).
//
//   node scripts/helius-webhook.js plan                 # default; prints the request body + credit estimate, no network
//   node scripts/helius-webhook.js create --apply       # POST /v0/webhooks once (100 credits); refuses if ours already exists
//   node scripts/helius-webhook.js update --apply       # PUT our webhook (matched by webhookURL) with the current plan (100 credits)
//   node scripts/helius-webhook.js pause  --apply       # PATCH active:false (stops the 1-credit/event charges)
//   node scripts/helius-webhook.js resume --apply
//   node scripts/helius-webhook.js delete --apply       # 100 credits
//   node scripts/helius-webhook.js list   --apply       # GET /v0/webhooks
//
// Reads env / .env only: HELIUS_API_KEY, HAWSE_WEBHOOK_URL (inbox base URL), HELIUS_WEBHOOK_AUTH (raw Authorization value
// the inbox expects, no "Bearer"), HELIUS_WEBHOOK_ADDRESSES (else HELIUS_WATCH_ADDRESSES, else FOLLOW_WALLETS_SOL, else the
// verified proposed list in server/feeds/helius-watch.js), HELIUS_WEBHOOK_TX_TYPES (default SWAP,TRANSFER),
// HELIUS_WEBHOOKS_API (default https://api-mainnet.helius-rpc.com/v0/webhooks).
// It NEVER prints the API key, the auth value or the inbox URL: the key travels only in the request URL; output is redacted.
// Every create/edit/delete is 100 credits and is recorded in data/credits.json against HELIUS_CREDIT_BUDGET.
const path = require('path');
const config = require('../server/config');
const { CreditBudget } = require('../server/lib/credits');
const H = require('../server/feeds/helius');
const { DEFAULT_SOL_WATCH } = require('../server/feeds/whales');
const { resolveWatch, estimateCredits } = require('../server/feeds/helius-watch');

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const BUSY = new Set(DEFAULT_SOL_WATCH.map((w) => w.addr));
const COMMANDS = ['plan', 'create', 'update', 'pause', 'resume', 'delete', 'list'];
const HOOK_URL_LABEL = '<HAWSE_WEBHOOK_URL>/helius';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Pure: validate env + args into a plan. Never includes secret values (only whether they are set). */
function buildPlan(env, argv) {
  const cmd = (argv.find((a) => !a.startsWith('--')) || 'plan').toLowerCase();
  const apply = argv.includes('--apply'), allowBusy = argv.includes('--allow-busy-pools');
  const url = H.inboxHookUrl(env.HAWSE_WEBHOOK_URL || '');
  const watch = resolveWatch(env), addresses = watch.accounts.map((a) => a.addr);
  const txTypes = list(env.HELIUS_WEBHOOK_TX_TYPES).length ? list(env.HELIUS_WEBHOOK_TX_TYPES).map((t) => t.toUpperCase()) : ['SWAP', 'TRANSFER'];
  const errors = [], warnings = [];
  if (!COMMANDS.includes(cmd)) errors.push('unknown command ' + cmd + ' (use ' + COMMANDS.join(' | ') + ')');
  if (!env.HELIUS_API_KEY) errors.push('HELIUS_API_KEY is not set');
  if (!env.HAWSE_WEBHOOK_URL) errors.push('HAWSE_WEBHOOK_URL is not set (the inbox base URL; Helius delivers to <it>/helius)');
  else {
    let u = null; try { u = new URL(url); } catch { errors.push('HAWSE_WEBHOOK_URL must be a full https URL'); }
    if (u && u.protocol !== 'https:') errors.push('HAWSE_WEBHOOK_URL must be https');
    if (u && /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1)/.test(u.hostname)) errors.push('HAWSE_WEBHOOK_URL must be publicly reachable (Helius cannot reach localhost/private IPs)');
  }
  if (cmd === 'create' || cmd === 'update' || cmd === 'plan') {
    if (!env.HELIUS_WEBHOOK_AUTH) errors.push('HELIUS_WEBHOOK_AUTH is not set (the inbox rejects every delivery without it)');
    else if (/^bearer\s/i.test(env.HELIUS_WEBHOOK_AUTH)) errors.push('HELIUS_WEBHOOK_AUTH must be the raw value, without "Bearer"');
    if (!addresses.length) errors.push('no addresses to watch');
    const bad = addresses.filter((a) => !B58.test(a)); if (bad.length) errors.push(`${bad.length} address(es) are not valid base58 Solana addresses`);
    if (addresses.length > 100000) errors.push('Helius allows at most 100,000 addresses per webhook');
    const busy = addresses.filter((a) => BUSY.has(a));
    if (busy.length && !allowBusy) errors.push(`refusing to watch busy AMM pool(s) ${busy.map((a) => a.slice(0, 4) + '…').join(', ')}: every swap is a 1-credit event and a major SOL-USDC pool can exceed the 1M/month free plan by itself. Watch wallets instead, or pass --allow-busy-pools`);
    if (busy.length && allowBusy) warnings.push('busy AMM pools included: watch the credit meter in the Data Sources panel and pause if needed');
  }
  const est = estimateCredits(watch.accounts);
  const cfg = config.build(env); const daily = cfg.helius.dailyBudget;
  if (est.planned != null && est.planned > daily * 0.5) warnings.push(`planned ${est.planned}/day (with ×${est.safety} headroom) is over half the ${daily}/day cap: trim the list`);
  if (est.perDay == null) warnings.push(`no measured tx rate for ${est.unknown.length} address(es): credits/day unknown until deliveries are observed (the daily cap still auto-pauses)`);
  // pause/resume priced as an edit (assumption; Helius lists create/edit/delete = 100 credits each)
  const cost = { create: H.CREDITS.webhookManage, update: H.CREDITS.webhookManage, delete: H.CREDITS.webhookManage, pause: H.CREDITS.webhookManage, resume: H.CREDITS.webhookManage }[cmd] || 0;
  return { cmd, apply, url, api: env.HELIUS_WEBHOOKS_API || H.WEBHOOKS_URL, watch, addresses, txTypes, cost, errors, warnings, estimate: est, dailyBudget: daily,
    body: { webhookURL: url ? HOOK_URL_LABEL : '', webhookType: 'enhanced', transactionTypes: txTypes, accountAddresses: addresses, txnStatus: 'success', authHeader: env.HELIUS_WEBHOOK_AUTH ? '<HELIUS_WEBHOOK_AUTH>' : '' } };
}

const SECRET_VARS = ['HELIUS_API_KEY', 'HELIUS_WEBHOOK_AUTH', 'HAWSE_READ_TOKEN', 'HAWSE_WEBHOOK_URL'];
const redactAll = (s, env) => {
  let x = String(s);
  for (const k of SECRET_VARS) { const v = env[k]; if (v && String(v).length >= 4) { x = x.split(String(v)).join('***'); const bare = String(v).replace(/^https?:\/\//, '').replace(/\/+$/, ''); if (bare.length >= 4) x = x.split(bare).join('***'); } }
  return x.replace(/api-key=[^&\s"]+/g, 'api-key=***');
};

async function call(p, env, method, sub, body) {
  const r = await fetch(p.api + sub + '?api-key=' + encodeURIComponent(env.HELIUS_API_KEY), { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const text = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const describeHook = (w, url) => ({ webhookID: w.webhookID, webhookURL: w.webhookURL === url ? HOOK_URL_LABEL : '(another URL)', webhookType: w.webhookType, active: w.active, addresses: (w.accountAddresses || []).length, transactionTypes: w.transactionTypes });

function printPlan(p, env, log) {
  log(`helius-webhook ${p.cmd}${p.apply ? ' (APPLY)' : ' (dry run: no network calls)'}`);
  log(`  target: ${p.url ? HOOK_URL_LABEL : '(HAWSE_WEBHOOK_URL unset)'} · api: ${p.api.replace(/\?.*$/, '')} · type: enhanced · txnStatus: success · types: ${p.txTypes.join(',')}`);
  log('  env: ' + SECRET_VARS.map((k) => `${k} ${env[k] ? 'set' : 'unset'}`).join(' · '));
  log(`  accounts (${p.addresses.length}, from ${p.watch.source}):`);
  for (const a of p.watch.accounts) log(`    ${a.addr}  ${a.label}${a.txPerDay != null ? ` · ~${a.txPerDay} tx/day (${a.measured || '?'})` : ' · rate unknown'}${a.source ? ' · ' + a.source : ''}`);
  const e = p.estimate;
  log(e.perDay == null ? '  expected credits/day: unknown (unmeasured addresses)'
    : `  expected credits/day: ~${e.perDay.toLocaleString()} (≈${e.perMonth.toLocaleString()}/month = ${(100 * e.perMonth / H.CREDITS.freePlanMonthly).toFixed(1)}% of the 1M free plan); plan for up to ${e.planned.toLocaleString()}/day = ${(100 * e.planned / p.dailyBudget).toFixed(0)}% of the ${p.dailyBudget.toLocaleString()}/day cap`);
  log('  assumption: ' + e.assumption);
  log(`  credit cost of this command: ${p.cost} (webhook create/edit/delete = 100; each delivered event = 1)`);
  log('  request body: ' + JSON.stringify({ ...p.body, accountAddresses: `[${p.addresses.length} addresses above]` }));
}

async function main(env = process.env, argv = process.argv.slice(2), log = (s) => console.log(redactAll(s, env))) {
  const p = buildPlan(env, argv);
  printPlan(p, env, log);
  p.warnings.forEach((w) => log('  warning: ' + w));
  if (p.errors.length) { p.errors.forEach((e) => log('  error: ' + e)); if (p.cmd !== 'plan') process.exitCode = 2; return p; }
  if (!p.apply || p.cmd === 'plan') { log('  nothing sent. Re-run with a command and --apply to execute.'); return p; }
  const cfg = config.build(env);
  const budget = new CreditBudget({ provider: 'helius', budget: cfg.helius.creditBudget, dailyBudget: cfg.helius.dailyBudget, planCredits: H.CREDITS.freePlanMonthly, file: cfg.creditsFile });
  if (p.cost && !budget.trySpend(p.cost, 'webhook-manage')) { log(`  refused: credit budget guard (${budget.view().used}/${budget.budget} used this month)`); process.exitCode = 3; return p; }
  try {
    const hooks = await call(p, env, 'GET', ''); const all = Array.isArray(hooks) ? hooks : [];
    const mine = all.find((w) => w.webhookURL === p.url);
    if (p.cmd === 'list') { log(JSON.stringify(all.map((w) => describeHook(w, p.url)), null, 2)); return p; }
    const body = { ...p.body, webhookURL: p.url, authHeader: env.HELIUS_WEBHOOK_AUTH };
    if (p.cmd === 'create') {
      if (mine) { log(`  refused: a webhook already points at ${HOOK_URL_LABEL} (${mine.webhookID}); use update`); process.exitCode = 4; return p; }
      const r = await call(p, env, 'POST', '', body); log('  created ' + JSON.stringify(describeHook(r, p.url)));
    } else if (!mine) log(`  no webhook points at ${HOOK_URL_LABEL}`);
    else if (p.cmd === 'update') { const r = await call(p, env, 'PUT', '/' + mine.webhookID, body); log('  updated ' + JSON.stringify(describeHook(r, p.url))); }
    else if (p.cmd === 'delete') { await call(p, env, 'DELETE', '/' + mine.webhookID); log('  deleted ' + mine.webhookID); }
    else { const r = await call(p, env, 'PATCH', '/' + mine.webhookID, { active: p.cmd === 'resume' }); log('  ' + p.cmd + 'd ' + JSON.stringify(describeHook(r, p.url))); }
  } catch (e) { log('  failed: ' + redactAll(e.message, env)); process.exitCode = 1; }
  return p;
}

if (require.main === module) { config.loadDotEnv(path.join(__dirname, '..', '.env')); main(); }
module.exports = { buildPlan, main, redactAll, HOOK_URL_LABEL };
