# bundled-deps-patch

Patches vulnerable dependencies that npm can't update because another package ships them inside its own tarball (`bundleDependencies`). Works in any npm project: plain Node, frameworks, monorepos, CLI tools.

| Script | What it does |
|---|---|
| `patch-bundled-deps.js` | Replaces each bundled copy with a patched copy (yours, or downloaded from the registry), and updates the matching `package-lock.json` entries so `npm audit` and lockfile scanners (Snyk, Mend, Black Duck) see the fix |
| `check-bundled-deps.js` | Lists every installed copy of each configured package and exits `1` if any copy on disk is still vulnerable |

No dependencies. Requires Node.js 18.17+ or 20.1+ and npm 7+ (lockfile v2 or v3).

## The problem

Most transitive dependencies are resolved by npm, so `npm audit fix` or `overrides` can move them to a fixed version. **Bundled** dependencies are different. The publisher packs them into their own tarball, and npm installs them exactly as shipped:

```
your-app
└── node_modules/
    ├── handlebars/                  4.7.10   <- resolved by npm: audit fix and overrides work
    └── vendor-tool/
        └── node_modules/
            └── handlebars/          4.7.9    <- bundled: npm ignores audit fix and overrides
```

Symptoms:

- `npm audit fix` updates your copies, but the finding stays.
- With `overrides`, `npm ls` prints `handlebars@4.7.9 overridden`, yet 4.7.9 is still on disk. npm's maintainers confirm that [overrides don't apply to bundled dependencies](https://github.com/npm/cli/issues/4889).
- `npm audit fix --force` suggests downgrading the bundling package, which is usually a breaking change and often still bundles the old copy.

Until the publisher ships a release with the fixed version, you can't fix it with npm alone. This tool patches it after install.

### Is my case a bundling problem?

Check the lockfile entry of the stuck copy (replace `handlebars` with your package):

```bash
node -e 'const p=require("./package-lock.json").packages; for (const [k,v] of Object.entries(p)) if (k.endsWith("/node_modules/handlebars")) console.log(k, v.version, v.inBundle ? "BUNDLED" : "")'
```

If the stuck copy says `BUNDLED`, this tool applies. If not, use npm `overrides` instead.

## Setup

1. Copy both scripts into your project, for example into `scripts/`:

   ```bash
   mkdir -p scripts
   curl -fsSLo scripts/patch-bundled-deps.js https://raw.githubusercontent.com/samceracas/nodejs-scripts/main/bundled-deps-patch/patch-bundled-deps.js
   curl -fsSLo scripts/check-bundled-deps.js https://raw.githubusercontent.com/samceracas/nodejs-scripts/main/bundled-deps-patch/check-bundled-deps.js
   ```

   If the repo is private, copy the files manually instead.

2. Decide where the patched copy comes from:

   - **Your app already uses the package directly:** bump it, for example `npm i handlebars@^4.7.10`. The script copies from `node_modules/handlebars`.
   - **Your app doesn't use it:** add `"fetch": true` to its entry in step 3, and the script downloads the patched version itself. No new dependency needed. See [Projects that don't use the package directly](#projects-that-dont-use-the-package-directly).

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
       "handlebars": "4.7.10"
     }
   }
   ```

   - The `postinstall` line only runs the script if the file exists, so installs in folders without `scripts/` don't break (see [Build outputs](#build-outputs-and-docker)). It's written in Node rather than shell so it also works on Windows. A config error inside the script still fails the install.
   - `overrides` is optional but recommended for non-bundled copies. The right syntax depends on your setup. See [`overrides` and how it fits in](#overrides-and-how-it-fits-in).

4. Reinstall and verify:

   ```bash
   rm -rf node_modules package-lock.json
   npm install
   npm run check:bundled     # every line must say OK
   npm audit
   ```

   The vulnerability summary at the end of `npm install` is computed **before** postinstall runs. Run `npm audit` afterwards for the real result.

5. Smoke test the package that bundles the dependency by running the commands you use from it.

6. Commit `package.json`, `package-lock.json` and both scripts.

## Configuration

### What `bundledPatches` is

`bundledPatches` is **not an npm feature**. npm ignores keys in `package.json` that it doesn't recognize, so this is a config block that only these two scripts read. Adding it does nothing until one of the scripts runs (normally through `postinstall`).

It maps a package name to its minimum safe version:

```json
"bundledPatches": {
  "handlebars": "4.7.10",
  "proxy-addr": { "min": "2.0.8" },
  "@hapi/hoek": { "min": "9.3.0", "fetch": true },
  "some-pkg": { "min": "3.0.0", "allowMajor": true }
}
```

This reads as: "any bundled copy of handlebars below 4.7.10, of proxy-addr below 2.0.8, and so on, must be replaced." Scoped packages work the same way.

### Options

| Option | Default | Meaning |
|---|---|---|
| `min` | required | Copies below this version are replaced. The string form `"x.y.z"` is shorthand for `{ "min": "x.y.z" }` |
| `fetch` | `false` | If no suitable copy is installed at the top level, download exactly `<name>@<min>` from the registry with `npm pack` instead of failing |
| `allowMajor` | `false` | Allow replacing a bundled copy with a different major version (for example 3.x with 4.x). Only enable after testing the bundling package |

### What the patch script does with each entry

Using `"handlebars": "4.7.10"` as the example:

1. **Find the bundled copies.** Search `package-lock.json` for entries ending in `node_modules/handlebars` with `"inBundle": true`, for example `node_modules/vendor-tool/node_modules/handlebars`. Nothing is hardcoded, so if another package starts bundling it too, that copy is picked up automatically.
2. **Find a safe source.** Use the top-level `node_modules/handlebars` if it is at least 4.7.10. Otherwise, with `"fetch": true`, download exactly `handlebars@4.7.10`. If neither works, stop with an error, since there is nothing safe to copy from.
3. **Compare versions.** Bundled copies below the minimum are replaced. Others are left alone.
4. **Replace and record.** Delete the bundled folder, copy the safe source into its place, leave a `.bundled-patch.json` marker in it, and update that entry's `version` in the lockfile so `npm audit` sees the fix.

The check script reads the same config but changes nothing. It lists every installed copy of each package and fails if any copy on disk is below its minimum.

When the source is your top-level copy, `min` is a **minimum, not a pin**. The script copies whatever version is installed, so upgrading to handlebars 4.7.12 makes the bundled copy 4.7.12 too. With `fetch`, the script downloads exactly `min`, so builds stay reproducible.

## Behavior

| Situation | Result | Exit |
|---|---|---|
| Bundled copy below `min` | Replaced on disk, marker added, lockfile entry updated | 0 |
| Already patched by this script (marker present) | Logs "already patched". Safe to run any number of times | 0 |
| Bundled copy at or above `min` without a marker | The bundling package fixed it upstream. Logs that the entry can be removed | 0 |
| Vulnerable copy installed, no suitable top-level copy, `fetch` off | Error explaining the two ways to fix it | 1 |
| Same, with `fetch: true` | Downloads `<name>@<min>` and patches with it | 0 |
| `fetch` download fails (registry unreachable, version not found, auth) | Error with npm's message | 1 |
| Bundling package not installed (for example `npm ci --omit=dev` skipped a dev tool) | Logs "nothing to do" | 0 |
| Lockfile entry below `min`, but no vulnerable copy installed | Warning to run a full `npm install` | 0 |
| Swap would cross a major version without `allowMajor` | Skipped with a warning | 0 |
| Package not bundled anywhere | Logs "nothing to do". Use `overrides` for it instead | 0 |
| No `package-lock.json` (for example a Yarn or pnpm project) | Warning that only npm is supported | 0 |
| `lockfileVersion: 1` (npm 6) | Error asking you to upgrade npm and reinstall | 1 |
| No `bundledPatches` key | Does nothing | 0 |

Exit `1` makes `npm install` fail loudly instead of shipping a vulnerable copy silently.

## Projects that don't use the package directly

Example: your app never uses handlebars, but a tool you depend on bundles a vulnerable copy. The script needs a patched copy to swap in, and your `node_modules` has none. Without one, the install fails with:

```
[bundled-patch] handlebars: top-level copy is missing, need >= 4.7.10. Either set "handlebars": { "min": "4.7.10", "fetch": true } in bundledPatches to download it, or run npm i -D handlebars@^4.7.10 and then npm install again (npm skips this project's postinstall when you install a package by name).
```

### Option A: download it at install time (no new dependency)

```json
"bundledPatches": {
  "handlebars": { "min": "4.7.10", "fetch": true }
}
```

The script downloads exactly `handlebars@4.7.10` with `npm pack` into a temp folder, swaps it in, and deletes the temp folder. Nothing is added to your dependencies or to the lockfile's top level.

- **Same registry as your install.** `npm pack` reads the same `.npmrc` files as `npm ci` (project, user, and CI-provided), so private registries, mirrors (Artifactory, Nexus, Verdaccio) and proxies work without extra setup.
- **Integrity checked.** `npm pack` verifies the tarball against the registry's integrity hash.
- **Exact version.** It always downloads `min`, never "latest". To move to a newer patch release, raise `min`.
- **Only when needed.** No download happens when the copy is already patched, when the bundling package isn't installed, or when a suitable top-level copy exists.
- **Needs `tar`.** It ships with Linux, macOS, Windows 10+ and the official Node Docker images.

### Option B: add it as a devDependency

```bash
npm i -D handlebars@^4.7.10
npm install            # required: npm i <pkg> does not run your project's postinstall
npm run check:bundled
```

Use this if your install has no registry access, or if you want the patched version recorded in the lockfile.

- **Use `-D`.** The copy is only a source for the swap, so it shouldn't ship to production.
- **Run `npm install` again after adding it.** npm runs your project's `postinstall` only on a plain `npm install` or `npm ci`, not when you install a package by name.
- **Leave a note for your team.** Someone may later remove the "unused" devDependency. If they do, the install fails with the error above rather than shipping the vulnerable copy.

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
| **Bundled** (`"inBundle": true`) | `node_modules/vendor-tool/node_modules/handlebars` | This script. npm ignores `overrides` for bundled copies |
| **Normal** (resolved by npm) | `node_modules/handlebars`, installed because another dependency asks for `handlebars@^4.7.9` | npm `overrides`. This script never touches non-bundled copies |

So `overrides` stays relevant even with `fetch`. If another dependency pulls in a normal copy and your lockfile still pins the old version, that copy stays vulnerable, and `check-bundled-deps.js` fails the build until you fix it.

The syntax depends on whether the package is a direct dependency:

| Your project | Use | Why |
|---|---|---|
| Has it in `dependencies` or `devDependencies` | `"handlebars": "$handlebars"` | Follows your own version. A literal range that differs from your dependency fails with `EOVERRIDE` |
| Doesn't have it (for example, using `fetch`) | `"handlebars": "^4.7.10"` | `$handlebars` fails with `Unable to resolve reference $handlebars` without a direct dependency |

```jsonc
// direct dependency
"dependencies": { "handlebars": "^4.7.10" },
"overrides":    { "handlebars": "$handlebars" }

// no direct dependency (fetch)
"overrides":      { "handlebars": "^4.7.10" },
"bundledPatches": { "handlebars": { "min": "4.7.10", "fetch": true } }
```

If nothing in your project depends on the package normally, the override does nothing, but it protects you if a future dependency pulls in an old copy.

## Running outside postinstall

Both scripts use the current directory as the project root. To point at another project, pass `--root`:

```bash
node patch-bundled-deps.js --root path/to/project
node check-bundled-deps.js --root path/to/project
```

Use this when your install runs with `--ignore-scripts`, which skips postinstall. In that case the lockfile says patched while the disk still has the vulnerable copy, so add explicit steps after install:

```bash
npm ci --ignore-scripts
node scripts/patch-bundled-deps.js
node scripts/check-bundled-deps.js   # fails the build if anything is still vulnerable
```

## Build outputs and Docker

Any step that runs `npm install` or `npm ci` on a copy of your `package.json`, without your `scripts/` folder, needs attention. Common cases:

- Framework build steps that write a deployable folder with its own `package.json` (SAP CAP's `cds build` writes `gen/srv`, see [the CAP example](#example-sap-cap-sapcds-dk)).
- Docker builds that copy only `package*.json` before `npm ci`, for layer caching.
- Monorepo tools that prune or deploy a single package into a separate folder.

An unguarded `"postinstall": "node scripts/patch-bundled-deps.js"` fails there with:

```
Error: Cannot find module '/<build-folder>/scripts/patch-bundled-deps.js'
code: 'MODULE_NOT_FOUND'
```

npm runs `postinstall` from the folder being installed, and `scripts/` isn't in that folder. The guarded `postinstall` from [Setup](#setup) skips the script when the file is missing:

| Where npm installs | `existsSync` checks | Result |
|---|---|---|
| Project root | `<project>/scripts/patch-bundled-deps.js` (exists) | Runs the patch |
| Build output folder | `<output>/scripts/patch-bundled-deps.js` (missing) | `&&` short-circuits, install continues with exit 0 |

**Skipping is only safe if that install can't contain the vulnerable bundle.** It's safe when the folder installs production dependencies only and the bundling package is a devDependency. It is **not** safe when the bundling package is a production dependency. Then the build output needs the patch too.

Check by running the checker against the output after the build:

```bash
node scripts/check-bundled-deps.js --root path/to/output
```

### Docker

A typical cache-friendly Dockerfile copies `package*.json` first, so the scripts aren't there when `npm ci` runs. The guard skips the patch, and if the vulnerable bundle is in that install, it stays. Copy the scripts in before installing:

```dockerfile
COPY package*.json ./
COPY scripts/patch-bundled-deps.js scripts/check-bundled-deps.js ./scripts/
RUN npm ci && node scripts/check-bundled-deps.js
COPY . .
```

With `fetch`, the build stage needs registry access, which `npm ci` already requires.

## Monorepos (npm workspaces)

Put `bundledPatches`, the scripts and the `postinstall` in the **root** `package.json`. There is one `package-lock.json` for the whole workspace, and it lists bundled copies wherever they're installed, hoisted to the root or inside a workspace's own `node_modules`. One run patches all of them.

## CI/CD pipelines (Jenkins, GitHub Actions, GitLab CI, Azure DevOps)

Tested on a simulated clean agent (empty home folder, empty npm cache, `CI=true`) with `npm ci`, with and without `fetch`.

- **Node.js 18.17+ or 20.1+**, npm 7+.
- **`postinstall` must run.** With `--ignore-scripts`, add the explicit steps from [Running outside postinstall](#running-outside-postinstall).
- **With `fetch`:** the agent needs the same registry access `npm ci` already uses, a writable temp folder, and `tar`. Registry settings come from `.npmrc`, so a pipeline that injects one (for example for Artifactory) works automatically.
- **Commit `package.json`, `package-lock.json` and the scripts.**
- **Add the checker as a gate.** Run `node scripts/check-bundled-deps.js` as its own step after install. Your audit reads the lockfile, which the script edits. If postinstall is ever skipped, the lockfile says patched while the vulnerable copy is still on disk. The checker reads the disk, so it catches that.

## Adding a package later

1. The `npm audit` finding's path runs through another package's `node_modules/`, and the lockfile entry has `"inBundle": true`.
2. A fixed version exists. If the advisory covers every version, there's nothing to patch to yet.
3. Add `"<name>": "<fixed>"` to `bundledPatches`. If your project doesn't install a patched copy itself, add `"fetch": true` or use a devDependency (see [Projects that don't use the package directly](#projects-that-dont-use-the-package-directly)).
4. Run `npm install`, then `npm run check:bundled`.
5. Smoke test the bundling package.

## Removing it

This is a workaround, and the script tells you when it's no longer needed.

Every copy it swaps in gets a `.bundled-patch.json` marker:

```json
{ "patchedBy": "patch-bundled-deps", "from": "4.7.9", "to": "4.7.10", "date": "2026-10-14T13:39:10.646Z" }
```

Fresh installs re-extract the bundle, so the marker disappears along with the old copy. A bundled copy at or above `min` with no marker can only mean the publisher shipped the fix, and the install prints:

```
[bundled-patch] handlebars: vendor-tool now bundles 4.7.11 itself, no patch needed for it.
[bundled-patch] handlebars: no installed copy needs this patch anymore. Remove "handlebars" from bundledPatches.
```

The checker labels the copies the script swapped:

```
OK   handlebars   4.7.10   node_modules/vendor-tool/node_modules/handlebars (patched)
```

Workflow:

1. Upgrade the bundling package when a new version comes out (Dependabot, Renovate, a pre-commit hook, or by hand).
2. Run a full `npm install`.
3. If the output says an entry is no longer needed, remove it, along with any devDependency you added only as a patch source.
4. When `bundledPatches` is empty, remove the scripts, the `postinstall` line, and the CI checker step.

A leftover entry is harmless. The script finds nothing below `min` and does nothing.

To check what a release bundles without installing it:

```bash
npm pack vendor-tool@latest
tar -xOzf vendor-tool-*.tgz package/node_modules/handlebars/package.json | grep '"version"'
```

## Example: SAP CAP (`@sap/cds-dk`)

`@sap/cds-dk` 10.x bundles `handlebars@4.7.9` and `proxy-addr@2.0.7`. Both are flagged as critical, and npm can't update them.

Project that uses handlebars itself (for example to generate documents):

```json
"dependencies":   { "handlebars": "^4.7.10" },
"overrides":      { "handlebars": "$handlebars" },
"bundledPatches": { "handlebars": "4.7.10", "proxy-addr": "2.0.8" }
```

Project that only gets it through cds-dk:

```json
"overrides":      { "handlebars": "^4.7.10" },
"bundledPatches": {
  "handlebars": { "min": "4.7.10", "fetch": true },
  "proxy-addr": { "min": "2.0.8", "fetch": true }
}
```

CAP-specific notes:

- **`cds build` and `gen/srv`.** `cds build` copies `package.json` with your `scripts` into `gen/srv` but not the `scripts/` folder. The MTA builder then installs there, so an unguarded `postinstall` fails with `Cannot find module '.../gen/srv/scripts/patch-bundled-deps.js'`. The guarded `postinstall` skips it, which is safe: `gen/srv` installs production dependencies only, and cds-dk is a devDependency.
- **Commit the guarded line and regenerate `gen/`.** `gen/srv` picks up the guard at build time, so it must be in the commit your pipeline builds, and `gen/` must not be committed or cached.
- **Smoke test** with `cds compile`, `cds build --production` and one `cds add` (which renders handlebars templates).
- **Test locally before pushing:**

  ```bash
  npx cds build --production
  npm run postinstall                       # root: prints [bundled-patch] lines
  (cd gen/srv && npm ci --omit=dev)         # same install the MTA builder runs
  node scripts/check-bundled-deps.js --root gen/srv
  ```

## Limitations

- The swapped-in copy was never tested by the bundling package's maintainers. Stay within the same major version and smoke test after each change.
- Only the package folder is swapped. Its own dependencies resolve from the parent's bundle. If a patched version adds a dependency the bundle lacks, the parent fails at runtime, so smoke test.
- npm only (lockfile v2/v3). Yarn and pnpm use different lockfiles.
- The lockfile edit changes only `version` on `inBundle` entries. Those entries have no `resolved` or `integrity` fields, so nothing else needs to change.
