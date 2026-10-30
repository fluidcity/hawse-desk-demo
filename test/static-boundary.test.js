'use strict';
// Static/file-serving boundary + "no endpoint returns env values" (PR #1 review item 2).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { resolveStatic, inside } = require('../server/static');

// Sandbox: <tmp>/public (root) next to <tmp>/public-evil, <tmp>/secret.txt, <tmp>/.env
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawse-static-'));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(path.join(pub, 'betting'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(pub, 'app.js'), '1');
  fs.writeFileSync(path.join(pub, 'betting', 'index.html'), 'b');
  fs.writeFileSync(path.join(pub, '.env'), 'X=1');
  fs.writeFileSync(path.join(pub, 'notes.txt'), 'not allowlisted');
  fs.mkdirSync(path.join(pub, 'data'));
  fs.writeFileSync(path.join(pub, 'data', 'c.json'), '{}');
  fs.mkdirSync(path.join(dir, 'public-evil'));
  fs.writeFileSync(path.join(dir, 'public-evil', 'x.js'), 'EVIL');
  fs.writeFileSync(path.join(dir, 'secret.js'), 'SECRET');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET');
  fs.symlinkSync(path.join(dir, 'secret.js'), path.join(pub, 'leak.js'));
  fs.symlinkSync(path.join(dir, 'public-evil'), path.join(pub, 'evil'));
  fs.symlinkSync(path.join(pub, 'app.js'), path.join(pub, 'alias.js')); // in-root symlink: allowed
  return { dir, pub, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('inside() uses path.relative, not a prefix match', () => {
  assert.strictEqual(inside('/a/public', '/a/public/x.js'), true);
  assert.strictEqual(inside('/a/public', '/a/public'), true);
  assert.strictEqual(inside('/a/public', '/a/public-evil/x.js'), false);
  assert.strictEqual(inside('/a/public', '/a/secret.js'), false);
  assert.strictEqual(inside('/a/public', '/etc/passwd'), false);
});

test('resolveStatic serves allowlisted files and refuses every escape', () => {
  const s = sandbox();
  try {
    const ok = (u) => resolveStatic(s.pub, u).status === 200;
    assert.ok(ok('/'));
    assert.ok(ok('/app.js'));
    assert.ok(ok('/betting/'));
    assert.ok(ok('/alias.js'));
    const bad = [
      '/../secret.js', '/%2e%2e/secret.js', '/%2E%2E/secret.js', '/..%2fsecret.js', '/..%2F..%2Fetc%2Fpasswd',
      '/%252e%252e%252fsecret.js', '/..%252fsecret.js',                 // double-encoded
      '/%2fetc%2fpasswd', '//etc/passwd', '/' + path.join(s.dir, 'secret.js'), // absolute
      '/..%5csecret.js', '/..\\secret.js',                               // backslashes
      '/app.js%00.html', '/index.html%00',                               // NUL
      '/..%2fpublic-evil%2fx.js', '/evil/x.js',                          // prefix sibling / dir symlink
      '/leak.js',                                                         // file symlink outside root
      '/.env', '/%2eenv', '/..%2f.env', '/data/c.json', '/DATA/c.json', '/node_modules/x.js', '/server/config.js',
      '/scripts/helius-webhook.js', '/test/x.js', '/package.json', '/notes.txt', '/%E0%A4%A', '/nope.js',
    ];
    for (const u of bad) {
      const r = resolveStatic(s.pub, u);
      assert.notStrictEqual(r.status, 200, u + ' must be refused, got ' + JSON.stringify(r));
    }
  } finally { s.done(); }
});

// ---- over real HTTP against the real server and real /public ----
const SENTINELS = {
  HELIUS_API_KEY: 'sentinel-helius-7f3a91', ODDS_API_KEY: 'sentinel-odds-55c2e0', ODDS_API_KEY_PAID: 'sentinel-oddspaid-9d14bb',
  TRADOVATE_USERNAME: 'sentinel-tvuser-a81c', TRADOVATE_PASSWORD: 'sentinel-tvpass-2e6f', TRADOVATE_SECRET: 'sentinel-tvsec-c0de',
  JUPITER_API_KEY: 'sentinel-jup-3b77', HELIUS_WEBHOOK_AUTH: 'sentinel-hook-8a8a', ALCHEMY_API_KEY: 'sentinel-alch-4242',
  INFURA_API_KEY: 'sentinel-inf-1313', PYTH_API_KEY: 'sentinel-pyth-6060', DUNE_API_KEY: 'sentinel-dune-0101',
  HAWSE_READ_TOKEN: 'sentinel-inboxread-77aa', HAWSE_WEBHOOK_URL: 'https://sentinel-inbox-5e5e.example.workers.dev',
};
function raw(port, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.end();
  });
}

test('HTTP: escapes are refused, assets served, no GET endpoint returns env values', async () => {
  const config = require('../server/config');
  const { Engine } = require('../server/engine');
  const modules = require('../server/modules');
  const { createServer } = require('../server/server');
  const env = Object.assign({}, SENTINELS, { CREDITS_FILE: '', ODDS_CACHE_FILE: '', BET_RULES_FILE: '', LAB_FILE: '', INBOX_STATE_FILE: '', WHALES_ENABLED: 'true' });
  const cfg = config.build(env);
  if (cfg.lab) cfg.lab.file = '';
  const engine = new Engine(cfg, { modules }); // not started: no network
  const srv = createServer(engine, config.publicFlags(cfg));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.strictEqual((await raw(port, '/')).status, 200);
    assert.strictEqual((await raw(port, '/app.js')).status, 200);
    const h = await raw(port, '/api/health');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(JSON.parse(h.body).mode, 'paper');
    for (const u of ['/../server/config.js', '/%2e%2e/server/config.js', '/..%2fserver%2fconfig.js', '/..%252fpackage.json',
      '/..%2f.env', '/.env', '/..%2f..%2f..%2fetc%2fpasswd', '/%2fetc%2fpasswd', '/..%5cpackage.json', '/index.html%00.js',
      '/..%2fdata%2fcredits.json', '/..%2fpublic-evil%2fx.js', '/node_modules/', '/scripts/helius-webhook.js', '/test/', '/package.json', '/..']) {
      const r = await raw(port, u);
      assert.ok(r.status === 404 || r.status === 400 || (r.status === 200 && r.body.startsWith('<!DOCTYPE html>')), u + ' -> ' + r.status);
      assert.ok(!/use strict|"name":\s*"hawse|root:x:0/.test(r.body), u + ' leaked a file');
    }
    assert.strictEqual((await raw(port, '/index.html', 'POST')).status, 405);
    const gets = ['/api/health', '/api/state', '/api/explain', '/api/providers', '/api/lab', '/api/betting/state', '/api/betting/rules'];
    for (const g of gets) {
      const r = await raw(port, g);
      for (const [k, v] of Object.entries(SENTINELS)) assert.ok(!r.body.includes(v), g + ' leaked ' + k);
      assert.ok(!r.body.includes('sentinel-inbox-5e5e'), g + ' leaked the inbox host');
    }
    // The local webhook receiver is gone (live whale data arrives via the HAWSE inbox poller): nothing under /hooks/ answers.
    for (const [base, p] of [[port, '/hooks/helius'], [port, '/helius'], [port, '/events']]) {
      for (const m of ['GET', 'POST']) {
        const r = await raw(base, p, m);
        assert.ok(r.status === 404 || r.status === 405 || (m === 'GET' && r.status === 200 && r.body.startsWith('<!DOCTYPE html>')), m + ' ' + p + ' -> ' + r.status);
        for (const [k, v] of Object.entries(SENTINELS)) assert.ok(!r.body.includes(v), p + ' leaked ' + k);
      }
    }
  } finally {
    engine.stop && engine.stop();
    await new Promise((r) => srv.close(r));
  }
});
