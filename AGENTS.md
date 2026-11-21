# AGENTS.md

## Hard rules

- **Never add AI attribution** in anything written to this repo or GitHub:
  no `Co-Authored-By` trailers, no "Generated with Claude Code" footers,
  no session links — commits, PR bodies, issue bodies, comments included.

- **After any dependency change, regenerate the lockfile from scratch**:
  `rm -rf node_modules package-lock.json && npm install`, then check
  `grep -q '"node_modules/@emnapi/core"' package-lock.json`. An incremental
  `npm install <pkg>` on macOS drops the optional `@emnapi/*` wasm deps, and
  `npm ci` on Linux CI then fails with `Missing: @emnapi/core ... from lock file`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`ThamyHelaysa/collabtron`), via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
