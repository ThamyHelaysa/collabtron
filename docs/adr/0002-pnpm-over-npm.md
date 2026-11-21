# pnpm instead of npm

The package manager is pnpm, pinned through the `packageManager` field and run with corepack. CI installs with `pnpm install --frozen-lockfile`. We chose it after npm failed twice, on PR #18 and PR #19: an incremental `npm install` on macOS prunes optional dependencies of other platforms (`@emnapi/*`) from `package-lock.json`, and then `npm ci` fails on Linux CI. The macOS npm cannot detect this, even with `--os=linux`. pnpm's lockfile records optional dependencies for every platform, so the bug does not exist there. We rejected bun: it is a younger package manager, and the project does not use bun as its runtime.

## Consequences

- `scripts/check-lockfile.ts` and its pre-commit hook were a workaround for the npm bug. They are deleted in the migration.
- `--no-frozen-lockfile` is never used in CI. It would hide lockfile drift. The only exception would be a future dependency-update bot.
- pnpm's strict `node_modules` breaks imports of undeclared packages. Every import must be in `package.json`.
