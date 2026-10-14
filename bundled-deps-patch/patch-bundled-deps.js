#!/usr/bin/env node
/**
 * Patches vulnerable packages that other packages ship inside their own tarball
 * (bundleDependencies). npm never resolves bundled packages, so `npm audit fix`
 * and `overrides` cannot update them. This runs after install and:
 *
 *   1. replaces each bundled copy on disk with your top-level (patched) copy
 *   2. updates the matching "inBundle" entries in package-lock.json so
 *      `npm audit` and lockfile scanners report the patched version
 *
 * Configure in package.json:
 *
 *   "bundledPatches": {
 *     "handlebars": "4.7.10",                               // minimum safe version
 *     "proxy-addr": { "min": "2.0.8" },
 *     "some-pkg":   { "min": "3.0.0", "allowMajor": true }  // opt in to cross-major swaps
 *   }
 *
 * The patched version must be installed at the top level (node_modules/<name>).
 * If it is not, add it to devDependencies, e.g. `npm i -D proxy-addr@^2.0.8`.
 *
 * Usage: node patch-bundled-deps.js [--root <project-dir>]
 *
 * Exit codes: 0 = done or nothing to do, 1 = config problem (missing/old source).
 */
const fs = require('fs');
const path = require('path');

// Project root: --root <dir>, otherwise the current directory (npm runs scripts from the package root).
const rootArg = process.argv.indexOf('--root');
const root = path.resolve(rootArg > -1 && process.argv[rootArg + 1] ? process.argv[rootArg + 1] : process.cwd());
const TAG = '[bundled-patch]';
const lockPath = path.join(root, 'package-lock.json');

// --- helpers --------------------------------------------------------------
const parse = (v) => String(v).split('-')[0].split('.').map(Number);
const gte = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return true;
};
const readVersion = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; }
  catch { return null; }
};

// --- config ---------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const config = Object.entries(pkg.bundledPatches || {}).map(([name, v]) =>
  typeof v === 'string' ? { name, min: v, allowMajor: false } : { name, allowMajor: false, ...v });

if (!config.length) process.exit(0);
if (!fs.existsSync(lockPath)) {
  console.log(`${TAG} no package-lock.json, skipping`);
  process.exit(0);
}
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const packages = lock.packages || {};

let lockChanged = false;
let configErrors = 0;

for (const { name, min, allowMajor } of config) {
  // Bundled copies are found from the lockfile, so new bundling packages are picked up automatically.
  const suffix = `node_modules/${name}`;
  const bundled = Object.keys(packages).filter((k) =>
    k !== suffix && k.endsWith('/' + suffix) && packages[k].inBundle);

  if (!bundled.length) {
    console.log(`${TAG} ${name}: no bundled copies found, nothing to do`);
    continue;
  }

  const source = path.join(root, suffix);
  const srcVersion = readVersion(source);
  if (!srcVersion || !gte(srcVersion, min)) {
    console.error(`${TAG} ${name}: top-level copy is ${srcVersion || 'missing'}, need >= ${min}. ` +
      `Run: npm i -D ${name}@^${min}`);
    configErrors++;
    continue;
  }

  for (const key of bundled) {
    const target = path.join(root, key);
    const diskVersion = readVersion(target);
    const entry = packages[key];

    if (parse(srcVersion)[0] !== parse(entry.version)[0] && !allowMajor) {
      console.warn(`${TAG} ${name}: SKIPPED ${key} (${entry.version} -> ${srcVersion} crosses a major ` +
        `version and may break its parent). Set "allowMajor": true after testing.`);
      continue;
    }

    if (diskVersion && !gte(diskVersion, min)) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true });
      console.log(`${TAG} ${name}: ${key} ${diskVersion} -> ${readVersion(target)}`);
    } else if (diskVersion) {
      console.log(`${TAG} ${name}: ${key} already ${diskVersion}`);
    }

    if (!gte(entry.version, min)) {
      entry.version = srcVersion;
      lockChanged = true;
      console.log(`${TAG} ${name}: lockfile ${key} -> ${srcVersion}`);
    }
  }
}

if (lockChanged) fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
process.exit(configErrors ? 1 : 0);
