'use strict';
// Guard: every local require() in shipped code must resolve to a file git tracks, and
// .gitignore must not hide source. A clean clone would crash otherwise (PR #1 review).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; }
}
const listed = git(['ls-files', '--cached', '--others', '--exclude-standard']);

test('no source file under server/, public/, scripts/, test/ is gitignored', { skip: listed === null && 'not a git checkout' }, () => {
  const ignored = (git(['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'server', 'public', 'scripts', 'test']) || '')
    .split('\n').filter(Boolean);
  assert.deepStrictEqual(ignored, [], 'ignored source files: ' + ignored.join(', '));
});

test('every relative require() resolves to a tracked or committable file', { skip: listed === null && 'not a git checkout' }, () => {
  const known = new Set(listed.split('\n').filter(Boolean).map((f) => path.join(ROOT, f)));
  const missing = [];
  for (const rel of listed.split('\n').filter((f) => /^(server|scripts|test)\/.*\.js$/.test(f))) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let target;
      try { target = require.resolve(path.resolve(path.dirname(file), m[1])); } catch (e) { missing.push(rel + ' -> ' + m[1] + ' (unresolvable)'); continue; }
      if (!known.has(target)) missing.push(rel + ' -> ' + path.relative(ROOT, target));
    }
  }
  assert.deepStrictEqual(missing, []);
});
