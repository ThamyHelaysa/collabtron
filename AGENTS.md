# AGENTS.md

## Hard rules

- **Never add AI attribution** in anything written to this repo or GitHub:
  no `Co-Authored-By` trailers, no "Generated with Claude Code" footers,
  no session links — commits, PR bodies, issue bodies, comments included.

- **Work is done when CI is green**: after a push, run `gh pr checks <n> --watch`
  and fix what fails before reporting.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`ThamyHelaysa/collabtron`), via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`, also for where the target site's Markdown config and Posts live.
