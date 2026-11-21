# CLAUDE.md — collabtron

Real-time collaborative editor for the Posts of an Eleventy site. Workflow, rules and commands live in [AGENTS.md](AGENTS.md); domain words in [GLOSSARY.md](GLOSSARY.md); decisions in [docs/adr/](docs/adr/).

## Layout

- `src/shared/` — runs on both sides. `markdown.ts`: ProseMirror `schema`, `parse` (Markdown to doc), `serialize` (doc to Markdown).
- `src/server/` — Node 24, TypeScript run directly (no build). `main.ts` reads `.env` and refuses non-loopback hosts; `post-catalog.ts` is the only way a Post ID becomes a Post; `post-file.ts` reads and writes a Post's body; `server.ts` is the HTTP server.
- `src/client/` — browser editor, bundled by esbuild into `dist/client/`.
- `test/fixtures/roundtrip/` — one `.md` per case; `src/shared/markdown.test.ts` checks each Round-trip.

## Gotchas

- Imports use the `.ts` extension (`allowImportingTsExtensions`, `erasableSyntaxOnly`): no enums, no namespaces, no parameter properties.
- `pnpm dev` takes exactly one Post ID; the catalog only knows that Post.
- No auth yet: dev mode binds loopback only, and that check in `main.ts` must stay.
- Round-trip is faithful when the site renders the same HTML, not when bytes match.
- Typed text is always literal: the serializer writes `&lt;`, `&amp;`, `&#123;` where text would open HTML or Nunjucks; Shortcode Blocks come only from the toolbar ([ADR 0003](docs/adr/0003-typed-text-is-literal.md)).
