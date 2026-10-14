# bundled-deps-patch

Patches vulnerable dependencies that npm cannot update because another package ships them inside its own tarball (`bundleDependencies`).

| Script | What it does |
|---|---|
| `patch-bundled-deps.js` | Replaces each bundled copy with your top-level patched copy, and updates the matching `package-lock.json` entries so `npm audit` and lockfile scanners (Snyk, Mend, Black Duck) see the fix |
| `check-bundled-deps.js` | Lists every installed copy of each configured package and exits `1` if any copy on disk is still vulnerable |

No dependencies. Requires Node.js 18.17+ or 20.1+ (uses recursive `fs.readdirSync`) and npm 7+ (lockfile v2/v3).

## When you need this

You run `npm audit fix` and a vulnerable package stays on the old version. Then you try `overrides` and `npm ls` prints `<pkg>@<old> overridden`, yet the old version is still on disk.

Confirm it is a bundling problem by checking the lockfile entry for the stuck copy:

```bash
node -e 'const p=require("./package-lock.json").packages; for (const [k,v] of Object.entries(p)) if (k.endsWith("/node_modules/handlebars")) console.log(k, v.version, v.inBundle ? "BUNDLED" : "")'
```

If the stuck copy says `BUNDLED`, this tool applies. If it doesn't, use npm `overrides` instead.

A known case is `@sap/cds-dk` 10.x, which bundles `handlebars@4.7.9` and `proxy-addr@2.0.7`.

## Setup

1. Copy both scripts into your project, for example into `scripts/`:

   ```bash
   mkdir -p scripts
   curl -fsSLo scripts/patch-bundled-deps.js https://raw.githubusercontent.com/samceracas/nodejs-scripts/main/bundled-deps-patch/patch-bundled-deps.js
   curl -fsSLo scripts/check-bundled-deps.js https://raw.githubusercontent.com/samceracas/nodejs-scripts/main/bundled-deps-patch/check-bundled-deps.js
   ```

   If the repo is private, copy the files manually instead.

2. Install the patched version at the top level of your project. The script copies from `node_modules/<name>`, so it must be there:

   ```bash
   npm i -D handlebars@^4.7.10     # or "dependencies" if your app uses it directly
   ```

   Do this even if the package is already there transitively, so a future dependency change can't silently remove your source copy.

3. Configure `package.json`:

   ```json
   {
     "scripts": {
       "postinstall": "node -e \"require('fs').existsSync('scripts/patch-bundled-deps.js') && require('./scripts/patch-bundled-deps.js')\"",
       "check:bundled": "node scripts/check-bundled-deps.js"
     },
     "overrides": {
       "handlebars": "$handlebars"
     },
     "bundledPatches": {
       "handlebars": "4.7.10",
       "proxy-addr": "2.0.8"
     }
   }
   ```

   The `postinstall` line only runs the script if the file exists. This matters when your package.json is copied somewhere without the `scripts/` folder (see [Build outputs](#build-outputs-cap-mta-docker)). It's written in Node rather than shell (`[ -f ... ]`) so it also works on Windows. A config error inside the script still fails the install.

   `overrides` is optional but recommended. It handles any *non-bundled* nested copies, which npm can resolve on its own. `$handlebars` means "the version in my dependencies". It requires the package to be a direct dependency, which step 2 ensures.

4. Reinstall and verify:

   ```bash
   rm -rf node_modules package-lock.json
   npm install
   npm run check:bundled     # every line must say OK
   npm audit
   ```

   The vulnerability count at the end of `npm install` is computed **before** postinstall runs. Run `npm audit` afterwards for the real result.

5. Smoke test the package that bundles the dependency, for example `cds compile`, `cds build`, and `cds add` for `@sap/cds-dk`.

6. Commit `package.json`, `package-lock.json` and both scripts.

## Configuration

### What `bundledPatches` is

`bundledPatches` is **not an npm feature**. npm ignores keys in `package.json` that it doesn't recognize, so this is a config block that only `patch-bundled-deps.js` and `check-bundled-deps.js` read. Adding it does nothing until one of the scripts runs (normally through `postinstall`).

It tells the scripts which packages to look for and the lowest safe version of each. It maps a package name to its minimum safe version:

```json
"bundledPatches": {
  "handlebars": "4.7.10",
  "proxy-addr": { "min": "2.0.8" },
  "some-pkg": { "min": "3.0.0", "allowMajor": true }
}
```

This reads as: "any bundled copy of handlebars below 4.7.10, or of proxy-addr below 2.0.8, must be replaced."

### What the patch script does with each entry

Using `"handlebars": "4.7.10"` as the example:

1. **Find the bundled copies.** Search `package-lock.json` for entries ending in `node_modules/handlebars` that are marked `"inBundle": true`. With `@sap/cds-dk` this finds `node_modules/@sap/cds-dk/node_modules/handlebars`.
2. **Find the safe source.** Check that the top-level `node_modules/handlebars` exists and is at least 4.7.10. If it is missing or older, stop with an error, since there is nothing safe to copy from.
3. **Compare versions.** Bundled copies below the minimum are replaced. Copies already at or above it are left alone.
4. **Replace and record.** Delete the bundled folder, copy the top-level folder into its place, and update that entry's `version` in the lockfile so `npm audit` sees the fix.

The check script uses the same entries, but only reads. It lists every installed copy of each package and fails if any copy on disk is below its minimum.

The value is a **minimum, not a pin**. The script copies whatever version is installed at the top level, so if you later upgrade to handlebars 4.7.12, the bundled copy becomes 4.7.12 too. To control the exact version, control your top-level dependency.

### Options

| Option | Default | Meaning |
|---|---|---|
| `min` | required | Copies below this version are replaced. The string form `"x.y.z"` is shorthand for `{ "min": "x.y.z" }` |
| `allowMajor` | `false` | Allow replacing a bundled copy with a different major version (for example 3.x with 4.x). Only enable this after testing the parent package |

Bundled copies are found from `package-lock.json` (entries with `"inBundle": true`), not from hardcoded paths. If another package starts bundling the same dependency, it is picked up automatically.

## Behavior

| Situation | Result | Exit |
|---|---|---|
| Bundled copy below `min` | Replaced on disk, lockfile entry updated | 0 |
| Already patched on disk or in the lockfile | Left alone. Safe to run any number of times | 0 |
| Top-level copy missing or below `min` | Error with the `npm i -D` command to run | 1 |
| Swap would cross a major version without `allowMajor` | Skipped with a warning | 0 |
| Package not bundled anywhere | Logs "nothing to do" | 0 |
| No `bundledPatches` key or no lockfile | Does nothing | 0 |

Exit `1` makes `npm install` fail loudly on a config problem instead of shipping a vulnerable copy silently.

## Running outside postinstall

Both scripts use the current directory as the project root. To point at another project, pass `--root`:

```bash
node patch-bundled-deps.js --root path/to/project
node check-bundled-deps.js --root path/to/project
```

Use this when your CI pipeline installs with `npm ci --ignore-scripts`, which skips postinstall. In that case the lockfile says patched while the disk still has the vulnerable copy. Add an explicit step after install:

```bash
npm ci --ignore-scripts
node scripts/patch-bundled-deps.js
node scripts/check-bundled-deps.js   # fails the build if anything is still vulnerable
```

## Build outputs (CAP, MTA, Docker)

Some build tools copy `package.json` into an output folder without your `scripts/` folder, then run `npm install` or `npm ci` there. CAP is one example: `cds build` writes `gen/srv/package.json` with your `scripts` block intact. When the MTA builder installs inside `gen/srv`, an unguarded `"postinstall": "node scripts/patch-bundled-deps.js"` fails.

### The error

In a CI pipeline (Jenkins shown here), it looks like this:

```
Error: Cannot find module '/home/jenkins/agent/<project>/gen/srv/scripts/patch-bundled-deps.js'
code: 'MODULE_NOT_FOUND'
npm error command sh -c node scripts/patch-bundled-deps.js
```

npm runs `postinstall` from the folder being installed, so the relative path `scripts/patch-bundled-deps.js` resolves to `gen/srv/scripts/patch-bundled-deps.js`. `cds build` never copies `scripts/` there, so the file does not exist.

### How the guard fixes it

Use the guarded `postinstall` from [Setup](#setup):

```json
"postinstall": "node -e \"require('fs').existsSync('scripts/patch-bundled-deps.js') && require('./scripts/patch-bundled-deps.js')\""
```

| Where npm installs | `existsSync` checks | Result |
|---|---|---|
| Project root | `<project>/scripts/patch-bundled-deps.js` (exists) | `require` runs the patch as usual |
| `gen/srv` | `<project>/gen/srv/scripts/patch-bundled-deps.js` (missing) | Returns `false`, `&&` short-circuits, `require` never runs, install continues with exit 0 |

Skipping inside `gen/srv` is safe. That folder installs production dependencies only, so dev tools like `@sap/cds-dk` and their bundles are not present and there is nothing to patch. To confirm, run the checker against the output folder after the build:

```bash
node scripts/check-bundled-deps.js --root gen/srv
```

### Pipeline checklist

- **Commit the updated `package.json`.** `cds build` copies `package.json` at build time, so `gen/srv` only gets the guarded line once the change is in the commit the pipeline builds.
- **Make sure `gen/` is regenerated.** If `gen/` is committed or cached between builds, delete it so `cds build` writes a fresh `gen/srv/package.json`.
- **Keep the escapes.** The command sits inside a JSON string, so copy it exactly, including the `\"` escapes.
- **Test locally before pushing:**

  ```bash
  npx cds build --production
  npm run postinstall                       # root: prints [bundled-patch] lines
  (cd gen/srv && npm run postinstall)       # gen/srv: no output, exit code 0
  (cd gen/srv && npm ci --omit=dev)         # same install the MTA builder runs
  ```

If an output folder does contain a package that bundles a vulnerable dependency (a production dependency, not a dev tool), copy the scripts into that folder as part of the build so the patch runs there too.

## Adding a package later

1. In `npm audit`, the finding's path contains another package's `node_modules/`, and the lockfile entry has `"inBundle": true`.
2. A fixed version exists. If the advisory range is `*`, nothing can be patched yet, so wait for upstream.
3. `npm i -D <name>@^<fixed>`.
4. Add `"<name>": "<fixed>"` to `bundledPatches`.
5. Reinstall, run the check, and smoke test the parent package.

## Removing it

This is a workaround. When the upstream package ships a release that bundles the fixed version, remove that entry from `bundledPatches`. When the object is empty, remove the scripts and the `postinstall` line. To check what a release bundles without installing it:

```bash
npm pack @sap/cds-dk@latest
tar -xOzf sap-cds-dk-*.tgz package/node_modules/handlebars/package.json | grep '"version"'
```

## Limitations

- The swapped-in copy was never tested by the parent package's maintainers. Keep the patch within the same major version and smoke test after each change.
- Only npm is supported. Yarn and pnpm use different lockfile formats.
- The lockfile edit changes only `version` on `inBundle` entries. Those entries have no `resolved` or `integrity` fields, so nothing else needs to change.
