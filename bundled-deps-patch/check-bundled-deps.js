#!/usr/bin/env node
// Usage: node check-bundled-deps.js [--root <project-dir>]
// Lists every installed copy (bundled or not) of each package in "bundledPatches"
// and exits 1 if any copy on disk is below its minimum version.
const fs = require('fs');
const path = require('path');
// Project root: --root <dir>, otherwise the current directory (npm runs scripts from the package root).
const rootArg = process.argv.indexOf('--root');
const root = path.resolve(rootArg > -1 && process.argv[rootArg + 1] ? process.argv[rootArg + 1] : process.cwd());
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const parse = (v) => String(v).split('-')[0].split('.').map(Number);
const gte = (a, b) => { const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return true; };

const nm = path.join(root, 'node_modules');
if (!fs.existsSync(nm)) { console.error('[bundled-check] no node_modules in ' + root + ', run npm install first'); process.exit(1); }
const all = fs.readdirSync(nm, { recursive: true }).map(String);
let bad = 0;
for (const [name, v] of Object.entries(pkg.bundledPatches || {})) {
  const min = typeof v === 'string' ? v : v.min;
  const re = new RegExp(`(^|[\\\\/])node_modules[\\\\/]${name.replace(/[/\\]/g, '[\\\\/]')}[\\\\/]package\\.json$`);
  for (const p of all.filter((p) => re.test('node_modules/' + p))) {
    const version = JSON.parse(fs.readFileSync(path.join(nm, p), 'utf8')).version;
    const ok = gte(version, min); if (!ok) bad++;
    const dir = path.join(nm, path.dirname(p));
    const patched = fs.existsSync(path.join(dir, '.bundled-patch.json')) ? ' (patched)' : '';
    console.log(`${ok ? 'OK  ' : 'VULN'} ${name.padEnd(12)} ${version.padEnd(8)} ${path.relative(root, dir)}${patched}`);
  }
}
process.exit(bad ? 1 : 0);
