# Full local Round-trip

Install this project's dependencies with `corepack pnpm install`. The target site
must have its dependencies installed too, including Eleventy and `tsx`.
Copy `.env.example` to `.env` and set `SITE_DIR` to the site directory and
`POSTS_DIR` to its Posts directory. Relative paths are resolved from this project's
root. The site may be a subdirectory of a larger Git repository.

```sh
corepack pnpm test:roundtrip:full
```

The command creates a detached worktree at the site's `HEAD`, symlinks the site's
`node_modules`, and uses its `eleventy.config.ts`. Uncommitted site changes are not
included. Builds and Post writes happen only in the temporary worktree; it is
removed in `finally`, including after build, codec or comparison failures.

Synthetic fixtures get their own Post folders, placeholder metadata and
`eleventyExcludeFromCollections: true`. This keeps them out of the site's
pagination while still building and comparing their pages. Existing Post folders
are never overwritten by fixtures. Real Post content stays outside this repository.

After build A, each Post except those with YAML `draft: true` is passed through
the same `readPostBody → parse → serialize → writePostBody` path as the editor,
preserving its Front Matter Block. Build B uses a fresh Eleventy process. The
build results identify the Post pages, including computed permalinks; output paths
are not guessed from Post IDs.

The comparison parses HTML with `parse5`, sorts attributes and collapses ordinary
HTML whitespace, preserving whitespace in `pre`, `textarea`, `script` and `style`.
Every different, added or removed Post page is reported. Missing pages and Posts
the codec cannot represent also fail the command; other Posts are still checked.
The current codec intentionally refuses unsupported HTML and shortcodes, so a real
site run may fail until those constructs are supported by later issues.

This command is local only. CI runs synthetic integration tests of the command
against a temporary Git site with a stand-in build tool; it never needs the site's
private content, local paths or `.env`.
