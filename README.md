# nodejs-scripts

Standalone Node.js scripts for use in any project. Each script lives in its own folder with a README that explains when to use it and how to set it up. Scripts have no dependencies, so you can copy them straight into a project.

## Scripts

| Folder | What it does |
|---|---|
| [`bundled-deps-patch`](./bundled-deps-patch) | Patches vulnerable dependencies that npm `audit fix` and `overrides` can't reach because another package bundles them (`bundleDependencies`). Works in any npm project |

## Conventions

- One folder per tool, named for what it does, with its own `README.md`.
- Plain Node.js, no npm dependencies, so a file can be copied into a project as is.
- Scripts take the project root from the current directory, with an optional `--root <dir>` override.
- Exit code `0` on success and `1` on failure, so the scripts work in npm hooks and CI.
