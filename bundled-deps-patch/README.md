# bundled-deps-patch

Patches vulnerable dependencies that npm cannot update because another package ships them inside its own tarball (`bundleDependencies`).

| Script | What it does |
|---|---|
| `patch-bundled-deps.js` | Replaces each bundled copy with a patched copy (yours, or downloaded from the registry), and updates the matching `package-lock.json` entries so `npm audit` and lockfile scanners (Snyk, Mend, Black Duck) see the fix |
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

2. Make sure the script has a patched copy to swap in. Pick one:

   - **Your app uses the package directly:** bump it in `dependencies`, for example `npm i handlebars@^4.7.10`. The script copies from `node_modules/handlebars`.
   - **Your app doesn't use it:** add `"fetch": true` to its `bundledPatches` entry (step 3) and the script downloads the patched version itself. No new dependency needed. Alternatively, `npm i -D handlebars@^4.7.10`. See [Projects that don't use the package directly](#projects-that-dont-use-the-package-directly) for the trade-offs.

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

   `overrides` is optional but recommended. The syntax depends on whether the package is a direct dependency. See [`overrides` and how it fits in](#overrides-and-how-it-fits-in).

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
  "some-pkg": { "min": "3.0.0", "allowMajor": true },
  "other-pkg": { "min": "1.2.3", "fetch": true }
}
```

This reads as: "any bundled copy of handlebars below 4.7.10, or of proxy-addr below 2.0.8, must be replaced."

### What the patch script does with each entry

Using `"handlebars": "4.7.10"` as the example:

1. **Find the bundled copies.** Search `package-lock.json` for entries ending in `node_modules/handlebars` that are marked `"inBundle": true`. With `@sap/cds-dk` this finds `node_modules/@sap/cds-dk/node_modules/handlebars`.
2. **Find the safe source.** Use the top-level `node_modules/handlebars` if it exists and is at least 4.7.10. Otherwise, if the entry has `"fetch": true`, download exactly `handlebars@4.7.10` from the registry. If neither is available, stop with an error, since there is nothing safe to copy from.
3. **Compare versions.** Bundled copies below the minimum are replaced. Copies already at or above it are left alone.
4. **Replace and record.** Delete the bundled folder, copy the safe source into its place, and update that entry's `version` in the lockfile so `npm audit` sees the fix.

The check script uses the same entries, but only reads. It lists every installed copy of each package and fails if any copy on disk is below its minimum.

When the source is your top-level copy, the value is a **minimum, not a pin**. The script copies whatever version is installed, so if you later upgrade to handlebars 4.7.12, the bundled copy becomes 4.7.12 too. With `"fetch": true` and no top-level copy, the script downloads exactly the `min` version, so builds stay reproducible.

### Options

| Option | Default | Meaning |
|---|---|---|
| `min` | required | Copies below this version are replaced. The string form `"x.y.z"` is shorthand for `{ "min": "x.y.z" }` |
| `allowMajor` | `false` | Allow replacing a bundled copy with a different major version (for example 3.x with 4.x). Only enable this after testing the parent package |
| `fetch` | `false` | If the package is not installed at the top level, download exactly `<name>@<min>` from the registry with `npm pack` instead of failing. See [Projects that don't use the package directly](#projects-that-dont-use-the-package-directly) |

Bundled copies are found from `package-lock.json` (entries with `"inBundle": true`), not from hardcoded paths. If another package starts bundling the same dependency, it is picked up automatically.

## Behavior

| Situation | Result | Exit |
|---|---|---|
| Bundled copy below `min` | Replaced on disk, lockfile entry updated | 0 |
| Already patched by this script (marker present) | Logs "already patched". Safe to run any number of times | 0 |
| Bundled copy already at or above `min` without a marker | The bundling package fixed it upstream. Logs that the entry can be removed | 0 |
| Vulnerable bundled copy installed, top-level copy missing or below `min`, `fetch` off | Error with the two ways to fix it | 1 |
| Same, with `fetch: true` | Downloads `<name>@<min>` and patches with it | 0 |
| `fetch: true` but the download fails (registry unreachable, version not found, auth) | Error with npm's message | 1 |
| Bundling package not installed (for example `npm ci --omit=dev` skipped `@sap/cds-dk`) | Logs "nothing to do" | 0 |
| Lockfile entry below `min`, but no vulnerable copy installed | Warning to run a full `npm install` | 0 |
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

## Projects that don't use the package directly

Example: your project never uses handlebars, but `@sap/cds-dk` bundles a vulnerable copy. The script needs a patched copy to swap in, and your `node_modules` has none. Without one, the install fails with:

```
[bundled-patch] handlebars: top-level copy is missing, need >= 4.7.10. Either set "handlebars": { "min": "4.7.10", "fetch": true } in bundledPatches to download it, or run npm i -D handlebars@^4.7.10 and then npm install again (npm skips this project's postinstall when you install a package by name).
```

There are two ways to fix it.

### Option A: download it at install time (no new dependency)

```json
"bundledPatches": {
  "handlebars": { "min": "4.7.10", "fetch": true }
}
```

The script downloads exactly `handlebars@4.7.10` with `npm pack` into a temp folder, swaps it in, and deletes the temp folder. Nothing is added to `dependencies`, `devDependencies` or the lockfile's top level.

- **Same registry as your install.** `npm pack` reads the same `.npmrc` files as `npm ci` (project, user, and CI-provided), so a private registry, mirror (Artifactory, Nexus) or proxy works without extra setup. If `npm ci` can reach the registry, so can the script.
- **Integrity checked.** `npm pack` verifies the tarball against the registry's integrity hash.
- **Exact version.** It always downloads `min`, never "latest", so every build gets the same copy. To move to a newer patch release, raise `min`.
- **Only when needed.** No download happens when the bundled copy is already patched, when the bundling package isn't installed (`npm ci --omit=dev`), or when a suitable top-level copy already exists.
- **Needs `tar`.** It ships with Linux, macOS and Windows 10+, and with the official Node Docker images.

### Option B: add it as a devDependency

```bash
npm i -D handlebars@^4.7.10
npm install            # required: npm i <pkg> does not run your project's postinstall
npm run check:bundled
```

Use this if your pipeline has no registry access during install, or if you want the patched version recorded in the lockfile.

- **Use `-D`.** The copy is only a source for the swap. As a devDependency it is not installed in production builds.
- **Run `npm install` again after adding it.** npm runs the root project's `postinstall` only on a plain `npm install` or `npm ci`, not when you install a package by name. CI is unaffected because it runs `npm ci`.
- **`overrides` works with a devDependency.** `"$handlebars"` resolves against devDependencies too. See [`overrides` and how it fits in](#overrides-and-how-it-fits-in).
- **Leave a note for your team.** Someone may later remove the "unused" devDependency. If they do, the install fails with the error above, so the vulnerable copy never ships silently.

### Which one

| | Option A (`fetch`) | Option B (devDependency) |
|---|---|---|
| Changes your dependencies | No | Yes, one devDependency |
| Patched version in lockfile top level | No | Yes |
| Needs registry access in `postinstall` | Yes (same as `npm ci`) | No |
| Version | Exactly `min` | Whatever `^min` resolves to |

## `overrides` and how it fits in

A project can have two kinds of vulnerable copies, and each needs a different fix:

| Copy | Example | Fixed by |
|---|---|---|
| **Bundled** (`"inBundle": true` in the lockfile) | `node_modules/@sap/cds-dk/node_modules/handlebars` | This script. npm ignores `overrides` for bundled copies |
| **Normal** (resolved by npm) | `node_modules/handlebars` installed for `@sap/hdi-deploy`, which declares `handlebars: ^4.7.9` | npm `overrides`. This script never touches non-bundled copies |

So `overrides` is still relevant even when the script downloads its patch with `fetch`. The script only fixes the bundle. If another dependency pulls in a normal copy and your lockfile still pins the old version, that copy stays vulnerable, and `check-bundled-deps.js` fails the build until you fix it. Tested: with `@sap/hdi-deploy` as a dependency and a lockfile pinning 4.7.9, the bundle was patched, but the top-level copy stayed at 4.7.9 until an override was added.

Which syntax to use depends on whether the package is a direct dependency:

| Your project | Use | Why |
|---|---|---|
| Has it in `dependencies` or `devDependencies` | `"handlebars": "$handlebars"` | Follows your own version, so the two never disagree. A literal range that differs from your dependency fails with `EOVERRIDE` |
| Doesn't have it (for example, using `fetch`) | `"handlebars": "^4.7.10"` | `$handlebars` fails with `Unable to resolve reference $handlebars` when there's no direct dependency to refer to |

```jsonc
// direct dependency
"dependencies": { "handlebars": "^4.7.10" },
"overrides":    { "handlebars": "$handlebars" }

// no direct dependency (fetch)
"overrides":      { "handlebars": "^4.7.10" },
"bundledPatches": { "handlebars": { "min": "4.7.10", "fetch": true } }
```

If no other package in your project depends on the vulnerable package normally, the override does nothing. It's still worth keeping as protection against a future dependency pulling in an old copy.

## CI/CD pipelines (Jenkins, GitHub Actions, Azure DevOps)

Tested on a simulated clean agent (empty home folder, empty npm cache, `CI=true`): `npm ci`, `cds build --production`, and `npm ci --omit=dev` inside `gen/srv` all pass, with and without `fetch`, and `npm audit` no longer reports the patched packages.

Checklist for your pipeline:

- **Node.js 18.17+ or 20.1+**, npm 7+.
- **`postinstall` must run.** If the pipeline uses `npm ci --ignore-scripts`, add explicit steps after install:

  ```bash
  npm ci --ignore-scripts
  node scripts/patch-bundled-deps.js
  node scripts/check-bundled-deps.js
  ```

- **With `fetch`:** the agent needs the same registry access `npm ci` already uses, a writable temp folder, and `tar`. Registry settings come from `.npmrc`, so if the pipeline injects one (for example a Jenkins config file provider for Artifactory), the download uses it automatically.
- **Commit `package.json`, `package-lock.json` and the scripts.** For CAP projects also see [Build outputs](#build-outputs-cap-mta-docker) for the guarded `postinstall`.
- **Optional gate:** run `node scripts/check-bundled-deps.js` as its own step. It exits 1 if any vulnerable copy is still on disk, which fails the build.

## Adding a package later

1. In `npm audit`, the finding's path contains another package's `node_modules/`, and the lockfile entry has `"inBundle": true`.
2. A fixed version exists. If the advisory range is `*`, nothing can be patched yet, so wait for upstream.
3. Add `"<name>": "<fixed>"` to `bundledPatches`. If your project doesn't already install a patched copy, either add `"fetch": true` or run `npm i -D <name>@^<fixed>` (see [Projects that don't use the package directly](#projects-that-dont-use-the-package-directly)).
4. Run `npm install` so the postinstall runs.
5. Reinstall, run the check, and smoke test the parent package.

## Removing it

This is a workaround. The script tells you when it's no longer needed.

### How it knows

Every copy the script swaps in gets a small `.bundled-patch.json` marker file:

```json
{ "patchedBy": "patch-bundled-deps", "from": "4.7.9", "to": "4.7.10", "date": "2026-10-14T13:39:10.646Z" }
```

`npm ci` and fresh installs re-extract the bundle, so the marker disappears along with the old copy. After a fresh install, a bundled copy at or above `min` with no marker can only mean the bundling package shipped the fixed version itself. In that case the install prints:

```
[bundled-patch] handlebars: @sap/cds-dk now bundles 4.7.11 itself, no patch needed for it.
[bundled-patch] handlebars: no installed copy needs this patch anymore. Remove "handlebars" from bundledPatches.
```

The checker also labels each copy it reads, so you can see which ones the script patched:

```
OK   handlebars   4.7.10   node_modules/@sap/cds-dk/node_modules/handlebars (patched)
```

### Workflow

1. Upgrade the bundling package when a new version comes out (for example when a pre-commit hook or Dependabot reports a newer `@sap/cds-dk`).
2. Run a full `npm install`.
3. If the output says an entry is no longer needed, remove it from `bundledPatches`. Also remove any `fetch` setup or devDependency you added only as a patch source.
4. When `bundledPatches` is empty, remove the scripts, the `postinstall` line, and the checker step from CI.

A leftover entry is harmless. The script finds nothing below `min` and does nothing, so forgetting step 3 costs clutter, not a broken build.

To check what a release bundles without installing it:

```bash
npm pack @sap/cds-dk@latest
tar -xOzf sap-cds-dk-*.tgz package/node_modules/handlebars/package.json | grep '"version"'
```

## Limitations

- The swapped-in copy was never tested by the parent package's maintainers. Keep the patch within the same major version and smoke test after each change.
- Only npm is supported. Yarn and pnpm use different lockfile formats.
- Only the package folder is swapped. Its own dependencies resolve from the parent's bundle. If a patched version adds a new dependency the bundle doesn't have, the parent fails at runtime, so smoke test after each change.
- The lockfile edit changes only `version` on `inBundle` entries. Those entries have no `resolved` or `integrity` fields, so nothing else needs to change.
