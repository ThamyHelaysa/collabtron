# AGENTS.md

## Hard rules

- **Never add AI attribution** in anything written to this repo or GitHub:
  no `Co-Authored-By` trailers, no "Generated with Claude Code" footers,
  no session links — commits, PR bodies, issue bodies, comments included.

- **Fix tool bugs at the source**: change the tool, its version or its config
  (see `docs/adr/`). Code written to work around a tool's bug is forbidden.

- **Work is done when CI is green**: after a push, run `gh pr checks <n> --watch`
  and fix what fails before reporting.

## Run and check

pnpm via corepack (`packageManager` in `package.json`, ADR 0002). Never `npm` or `npx`.

```bash
corepack pnpm install
corepack pnpm dev <post-id>   # needs .env, copy from .env.example
corepack pnpm dev:fixture     # by hand, no .env: a temp Eleventy site, prints the Share Link
corepack pnpm typecheck
corepack pnpm test
```

Before reporting: run `typecheck` and `test`, say which commands you could not run and why, list risks and what still needs a manual check.

## Don'ts

- No `--no-frozen-lockfile`, no lockfile edits by hand.
- No new dependency without a stated reason. Every import must be declared in `package.json` (pnpm is strict).
- No refactors outside the task's scope.
- Never edit `dist/` (build output).
- Never commit real paths from `SITE_DIR`/`POSTS_DIR` or `.env` values.
- Don't contradict an ADR silently; say so and why.

## Git

- Branch off `main`, one branch per issue (`issue-<n>-<slug>`). Never push to `main`.
- Conventional commits: `<type>(<scope>)?: <description>`, enforced by `.githooks/commit-msg`.
- PR body says `Closes #<n>`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`ThamyHelaysa/collabtron`), via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`, also for where the target site's Markdown config and Posts live.
