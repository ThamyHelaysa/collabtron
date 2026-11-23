# CLAUDE.md — collabtron

Real-time collaborative editor for the Posts of an Eleventy site. Workflow, rules and commands live in [AGENTS.md](AGENTS.md); domain words in [GLOSSARY.md](GLOSSARY.md); decisions in [docs/adr/](docs/adr/).

## Layout

- `src/shared/` — runs on both sides. `markdown.ts`: ProseMirror `schema`, `parse` (Markdown to doc), `serialize` (doc to Markdown). `collaborator.ts`: the colour palette and `displayName`, the rule for names.
- `src/server/` — Node 24, TypeScript run directly (no build). `main.ts` reads `.env` and refuses non-loopback hosts; `post-catalog.ts` is the only way a Post ID becomes a Post; `post-file.ts` reads and writes a Post file, front matter included; `authority.ts` holds one Post's document, Version and Step log; `post-saver.ts` writes an Editing Session's document back to its Post file; `server.ts` is the HTTP and WebSocket server, with the map of Authorities, and proxies every other path to the site's Eleventy; `eleventy.ts` forks `eleventy-launcher.ts`, which runs the site's own Eleventy dev server and sends back where each Post renders.
- `src/client/` — browser editor, bundled by esbuild into `dist/client/`. `sync.ts` is the client side of the sync protocol (reconnect and browser storage included), with no DOM, so the Seam 2 tests in `src/server/authority.test.ts` run it headless. `presence.ts` keeps the other Collaborators' Presence on the same text and draws it.
- `test/fixtures/roundtrip/` — one `.md` per case; `src/shared/markdown.test.ts` checks each Round-trip.
- `test/two-tabs.test.ts` — Seam 3: the editor in the installed Google Chrome through `playwright-core`, against a small Eleventy site in a temp folder, inside `pnpm test`.

## Gotchas

- Imports use the `.ts` extension (`allowImportingTsExtensions`, `erasableSyntaxOnly`): no enums, no namespaces, no parameter properties.
- `pnpm dev` takes exactly one Post ID; the catalog only knows that Post.
- No auth yet: dev mode binds loopback only, and that check in `main.ts` must stay.
- Round-trip is faithful when the site renders the same HTML, not when bytes match.
- Typed text is literal: the serializer writes `&lt;`, `&amp;`, `&#123;` where text would open HTML or Nunjucks; Shortcode Blocks come only from the toolbar. Code, autolinks, image alt, fields and front matter are exceptions ([ADR 0003](docs/adr/0003-typed-text-is-literal.md)).
- Front matter is the optional first doc node `front_matter`, split off by `parse`. YAML is checked with `js-yaml` `load`, the engine gray-matter uses, because gray-matter cannot bundle for the browser ([ADR 0004](docs/adr/0004-front-matter-checked-with-js-yaml.md)).
- Sync: a `steps` message means the same whether the Authority accepted Steps or rejected stale ones; the client skips what it has and rebases. The WebSocket upgrade checks `Origin` until there is a token ([ADR 0005](docs/adr/0005-one-steps-message.md)).
- Presence: a client sends its selection only with no unconfirmed Steps; the Server keeps the latest per socket, never in the Step log, and relays it mapped to the current Version; a receiver maps it over its own unconfirmed Steps. Its colour is a number into `colors`, drawn only through classes, and its name must pass `displayName` unchanged ([ADR 0007](docs/adr/0007-presence-relayed-at-the-authority-version.md)).
- Only the Server writes a Post file (no `PUT`, no Save button). It saves 1 s after the last Step, at most 10 s apart, and when the Editing Session ends; it replaces the file by rename, never in place, and never over a file whose hash differs from what it last wrote ([ADR 0006](docs/adr/0006-server-saves-never-over-outside-changes.md)).
- Reconnect: the instance ID in `init` is per Editing Session, not per Server start. Same instance, the client sends `catch-up` and rebases; a new one, its unconfirmed Steps are dropped and its text shown in `#recovery`. Kept per tab in `sessionStorage`, never `localStorage`, with the `clientID` so a reload never sends accepted Steps twice ([ADR 0008](docs/adr/0008-reconnect-catches-up-or-offers-the-text-back.md)).
- Preview: the Server forks the site's own Eleventy (`watch` + `serve("0")`, `--import tsx` for a `.ts` config) and proxies every path the editor does not use to it, at the root, WebSocket upgrades included. The Post's URL comes from `eleventy.contentMap`, never from a copied permalink rule; after each build the Server sends it as `preview`, and the client swaps in a new iframe (a new `src` loses to the old page's live reload). After a failed first build the launcher exits 75 once a site file changes, and a new one builds; never retry in the same process. Its dev server listens on every interface (#37) ([ADR 0009](docs/adr/0009-preview-is-the-sites-own-eleventy.md)).
