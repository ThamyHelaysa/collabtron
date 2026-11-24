# Coding standards

Judgement calls for review. Typing, tests, commit messages and secrets are checked by `pnpm typecheck`, `pnpm test`, `.githooks/commit-msg` and CI. This file holds what no check can.

## Browser policy is checked in Safari too

A change that relies on what the browser decides names, in the PR body, every browser it was checked in. That covers cookies and their attributes, storage, secure contexts, iframes and WebSocket upgrades. Safari is on that list: the Collaborator opens the Share Link in whatever browser they use, and Safari's policy differs from Chrome's. For example, it keeps no `Secure` cookie over plain HTTP ([ADR 0010](docs/adr/0010-token-opens-the-socket-a-cookie-the-preview.md)). Seam 3 drives Chrome only, so the Safari check is manual until it does more.

The finding, when this is missing: the PR does not say which browsers the browser-dependent behaviour was checked in, or Safari is not among them and the PR does not say why.
