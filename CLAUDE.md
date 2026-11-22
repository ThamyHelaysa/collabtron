# CLAUDE.md — collabtron

Real-time collaborative editor for the Posts of an Eleventy site. Workflow, rules and commands live in [AGENTS.md](AGENTS.md); domain words in [GLOSSARY.md](GLOSSARY.md); decisions in [docs/adr/](docs/adr/).

## Layout

- `src/shared/` — runs on both sides. `markdown.ts`: ProseMirror `schema`, `parse` (Markdown to doc), `serialize` (doc to Markdown).
- `src/server/` — Node 24, TypeScript run directly (no build). `main.ts` reads `.env` and refuses non-loopback hosts; `post-catalog.ts` is the only way a Post ID becomes a Post; `post-file.ts` reads and writes a Post file, front matter included; `authority.ts` holds one Post's document, Version and Step log; `post-saver.ts` writes an Editing Session's document back to its Post file; `server.ts` is the HTTP and WebSocket server, with the map of Authorities.
- `src/client/` — browser editor, bundled by esbuild into `dist/client/`. `sync.ts` is the client side of the sync protocol, with no DOM, so the Seam 2 tests in `src/server/authority.test.ts` run it headless.
- `test/fixtures/roundtrip/` — one `.md` per case; `src/shared/markdown.test.ts` checks each Round-trip.

## Gotchas

- Imports use the `.ts` extension (`allowImportingTsExtensions`, `erasableSyntaxOnly`): no enums, no namespaces, no parameter properties.
- `pnpm dev` takes exactly one Post ID; the catalog only knows that Post.
- No auth yet: dev mode binds loopback only, and that check in `main.ts` must stay.
- Round-trip is faithful when the site renders the same HTML, not when bytes match.
- Typed text is literal: the serializer writes `&lt;`, `&amp;`, `&#123;` where text would open HTML or Nunjucks; Shortcode Blocks come only from the toolbar. Code, autolinks, image alt, fields and front matter are exceptions ([ADR 0003](docs/adr/0003-typed-text-is-literal.md)).
- Front matter is the optional first doc node `front_matter`, split off by `parse`. YAML is checked with `js-yaml` `load`, the engine gray-matter uses, because gray-matter cannot bundle for the browser ([ADR 0004](docs/adr/0004-front-matter-checked-with-js-yaml.md)).
- Sync: a `steps` message means the same whether the Authority accepted Steps or rejected stale ones; the client skips what it has and rebases. The WebSocket upgrade checks `Origin` until there is a token ([ADR 0005](docs/adr/0005-one-steps-message.md)).
- Only the Server writes a Post file (no `PUT`, no Save button). It saves 1 s after the last Step, at most 10 s apart, and when the Editing Session ends; it replaces the file by rename, never in place, and never over a file whose hash differs from what it last wrote ([ADR 0006](docs/adr/0006-server-saves-never-over-outside-changes.md)).
