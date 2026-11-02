'use strict';
// Static file boundary for /public. Everything outside the public root is unreachable:
// - the URL path is decoded exactly once, and malformed %-escapes are rejected (400)
// - NUL bytes, backslashes, `..` segments and dot-segments/dotfiles (.env, .git, ...) are rejected
// - well-known private names are denied anywhere in the path (data, node_modules, server, scripts, test, docs, package*.json)
// - the realpath (symlinks resolved) of BOTH root and target must satisfy path.relative(root, target)
//   not starting with '..' and not absolute. This is NOT a startsWith() prefix test (that let /public-evil through)
// - only regular files with an allowlisted extension are served
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};
const DENY = new Set(['data', 'node_modules', 'server', 'scripts', 'test', 'docs', 'package.json', 'package-lock.json']);

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** Map a URL pathname (still %-encoded) to a file under root, or a refusal. Returns {status, file?, type?}. */
function resolveStatic(root, rawPath) {
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch (e) { return { status: 400 }; }
  if (/[\0\\]/.test(decoded) || /%[0-9a-f]{2}/i.test(decoded)) return { status: 400 }; // NUL, backslash, double-encoding
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  const segs = decoded.split('/').filter(Boolean);
  if (segs.some((s) => s.startsWith('.'))) return { status: 404 };          // '..', '.', dotfiles, .env
  if (segs.some((s) => DENY.has(s.toLowerCase()))) return { status: 404 };
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch (e) { return { status: 404 }; }
  let target = path.join(rootReal, ...segs);
  if (!inside(rootReal, target)) return { status: 404 };
  let real;
  try { real = fs.realpathSync(target); } catch (e) { return { status: 404 }; }
  if (!inside(rootReal, real)) return { status: 404 };                        // symlink pointing outside
  let st = fs.statSync(real);
  if (st.isDirectory()) {
    try { real = fs.realpathSync(path.join(real, 'index.html')); st = fs.statSync(real); } catch (e) { return { status: 404 }; }
    if (!inside(rootReal, real)) return { status: 404 };
  }
  if (!st.isFile()) return { status: 404 };
  const type = MIME[path.extname(real).toLowerCase()];
  if (!type) return { status: 404 };
  return { status: 200, file: real, type };
}

module.exports = { resolveStatic, inside, MIME, DENY };
