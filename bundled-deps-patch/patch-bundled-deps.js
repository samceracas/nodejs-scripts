#!/usr/bin/env node
/**
 * Patches vulnerable packages that other packages ship inside their own tarball
 * (bundleDependencies). npm never resolves bundled packages, so `npm audit fix`
 * and `overrides` cannot update them. This runs after install and:
 *
 *   1. replaces each bundled copy on disk with a patched copy
 *   2. updates the matching "inBundle" entries in package-lock.json so
 *      `npm audit` and lockfile scanners report the patched version
 *
 * Configure in package.json:
 *
 *   "bundledPatches": {
 *     "handlebars": "4.7.10",                               // minimum safe version
 *     "proxy-addr": { "min": "2.0.8" },
 *     "some-pkg":   { "min": "3.0.0", "allowMajor": true }, // opt in to cross-major swaps
 *     "other-pkg":  { "min": "1.2.3", "fetch": true }       // download the patch from the registry
 *   }
 *
 * Where the patched copy comes from:
 *   - node_modules/<name> in your project, if it is installed and >= min
 *   - otherwise, with "fetch": true, exactly <name>@<min> downloaded with `npm pack`
 *     (uses your normal npm registry, proxy and auth settings)
 *
 * Usage: node patch-bundled-deps.js [--root <project-dir>]
 *
 * Every copy it swaps in gets a ".bundled-patch.json" marker. A bundled copy that is already
 * patched but has no marker was fixed by the bundling package itself, and the script says
 * the entry can be removed.
 *
 * Exit codes: 0 = done or nothing to do, 1 = a vulnerable copy is installed and could not be patched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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

// Marker left in every copy this script swaps in. A bundled copy at or above `min` without
// the marker was shipped that way by the bundling package, so the entry is no longer needed.
const MARKER = '.bundled-patch.json';
const hasMarker = (dir) => fs.existsSync(path.join(dir, MARKER));

// "node_modules/@sap/cds-dk/node_modules/handlebars" -> "@sap/cds-dk"
const parentOf = (key, name) => {
  const parentPath = key.slice(0, -(`/node_modules/${name}`.length));
  return parentPath.slice(parentPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
};
const upstreamFixed = (name, key, version) =>
  `${TAG} ${name}: ${parentOf(key, name)} now bundles ${version} itself, no patch needed for it.`;

const tempDirs = [];
process.on('exit', () => tempDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// Runs npm the same way across platforms. Inside an npm script, npm_execpath points at npm's CLI.
const runNpm = (args) => {
  const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const cli = process.env.npm_execpath;
  if (cli && /npm-cli\.js$/.test(cli)) return execFileSync(process.execPath, [cli, ...args], opts);
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { ...opts, shell: process.platform === 'win32' });
};

// Downloads <name>@<version> from the registry and returns the extracted package folder.
// `npm pack` verifies the tarball against the registry's integrity hash.
const fetchFromRegistry = (name, version) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-patch-'));
  tempDirs.push(dir);
  const out = runNpm(['pack', `${name}@${version}`, '--json', '--pack-destination', dir]);
  const tarball = path.join(dir, JSON.parse(out)[0].filename);
  const extractTo = path.join(dir, 'x');
  fs.mkdirSync(extractTo);
  // tar ships with Linux, macOS and Windows 10+.
  execFileSync('tar', ['-xzf', tarball, '-C', extractTo], { stdio: 'pipe' });
  return path.join(extractTo, 'package');
};

// --- config ---------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const config = Object.entries(pkg.bundledPatches || {}).map(([name, v]) =>
  typeof v === 'string'
    ? { name, min: v, allowMajor: false, fetch: false }
    : { name, allowMajor: false, fetch: false, ...v });

if (!config.length) process.exit(0);
if (!fs.existsSync(lockPath)) {
  console.log(`${TAG} no package-lock.json, skipping`);
  process.exit(0);
}
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const packages = lock.packages || {};

let lockChanged = false;
let errors = 0;

for (const { name, min, allowMajor, fetch } of config) {
  // Bundled copies are found from the lockfile, so new bundling packages are picked up automatically.
  const suffix = `node_modules/${name}`;
  const bundled = Object.keys(packages).filter((k) =>
    k !== suffix && k.endsWith('/' + suffix) && packages[k].inBundle);

  if (!bundled.length) {
    console.log(`${TAG} ${name}: no bundled copies found, nothing to do`);
    continue;
  }

  // What actually needs work: vulnerable copies on disk, and lockfile entries still below min.
  const vulnerableOnDisk = bundled.filter((k) => {
    const v = readVersion(path.join(root, k));
    return v && !gte(v, min);
  });
  const staleInLock = bundled.filter((k) => !gte(packages[k].version, min));

  if (!vulnerableOnDisk.length && !staleInLock.length) {
    const installed = bundled.filter((k) => readVersion(path.join(root, k)));
    if (!installed.length) {
      console.log(`${TAG} ${name}: bundling package not installed (e.g. --omit=dev), nothing to do`);
      continue;
    }
    const fixedUpstream = installed.filter((k) => !hasMarker(path.join(root, k)));
    for (const k of fixedUpstream) console.log(upstreamFixed(name, k, readVersion(path.join(root, k))));
    if (fixedUpstream.length === installed.length) {
      console.log(`${TAG} ${name}: no installed copy needs this patch anymore. ` +
        `Remove "${name}" from bundledPatches.`);
    } else {
      console.log(`${TAG} ${name}: already patched`);
    }
    continue;
  }

  if (!vulnerableOnDisk.length) {
    // Only the lockfile is stale and nothing vulnerable is on disk (e.g. a production install
    // that omits the dev tool that bundles it). Don't break the install or hit the network over it.
    console.warn(`${TAG} ${name}: lockfile still lists a version below ${min}, but no vulnerable copy ` +
      `is installed. Run a full npm install to update the lockfile.`);
    continue;
  }

  // Find a patched source: the project's own copy first, then the registry if allowed.
  let source = path.join(root, suffix);
  let srcVersion = readVersion(source);
  if (!srcVersion || !gte(srcVersion, min)) {
    if (!fetch) {
      console.error(`${TAG} ${name}: top-level copy is ${srcVersion || 'missing'}, need >= ${min}. Either ` +
        `set "${name}": { "min": "${min}", "fetch": true } in bundledPatches to download it, or run ` +
        `npm i -D ${name}@^${min} and then npm install again (npm skips this project's postinstall ` +
        `when you install a package by name).`);
      errors++;
      continue;
    }
    try {
      source = fetchFromRegistry(name, min);
      srcVersion = readVersion(source);
      console.log(`${TAG} ${name}: fetched ${name}@${srcVersion} from the registry`);
    } catch (e) {
      const detail = String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 3).join(' | ');
      console.error(`${TAG} ${name}: could not download ${name}@${min} from the registry: ${detail}`);
      errors++;
      continue;
    }
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
      const newVersion = readVersion(target);
      fs.writeFileSync(path.join(target, MARKER), JSON.stringify({
        patchedBy: 'patch-bundled-deps',
        from: diskVersion,
        to: newVersion,
        date: new Date().toISOString(),
      }, null, 2) + '\n');
      console.log(`${TAG} ${name}: ${key} ${diskVersion} -> ${newVersion}`);
    } else if (diskVersion && !hasMarker(target)) {
      console.log(upstreamFixed(name, key, diskVersion));
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
process.exit(errors ? 1 : 0);
