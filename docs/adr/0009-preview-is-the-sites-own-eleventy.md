# The preview is the site's own Eleventy, through the Server

The editor shows the Post's page beside it, in the `#preview` iframe, as the site renders it (issue #14). Collabtron does not render the page itself: the site's own Eleventy dev server does, and the Server proxies it. Research: [eleventy-page-url](../research/eleventy-page-url.md).

The Server starts that dev server. `startEleventy` (`src/server/eleventy.ts`) forks `src/server/eleventy-launcher.ts` with its working directory at `SITE_DIR`. The launcher loads the Eleventy installed in the site, and runs it the way `eleventy --serve --incremental` does. When the site's config is `eleventy.config.ts`, it gets `--import tsx`, because plain Node cannot load every TypeScript config. Eleventy's programmatic `config` callback runs before the site's config file, so it adds what collabtron needs without touching the site:

- `eleventy.contentMap` gives the URL of every input file. The launcher sends the map to the Server on `eleventy.after`, which a build that failed never reaches. So the Server only opens pages that were written.
- The `ready` server option gives the port. It is `serve("0")`, so the OS picks a free port, never the Server's own.

`/preview/<post-id>` redirects to the Post's page from that map. Until a build has worked, it answers `503` with `Refresh: 2`, so the iframe asks again on its own.

Every other path the editor does not use (`/p/`, `/api/auth`, `/preview/`, `/ws/`, `/main.js`) goes to the dev server, at the root of the Server's own origin. The site's pages use absolute URLs, and Eleventy's reload client opens its WebSocket at `ws://<the page's host>/`. So WebSocket upgrades are proxied too. The preview's cookie covers them, as it covers the pages ([ADR 0010](0010-token-opens-the-socket-a-cookie-the-preview.md)). Headers are forwarded as sent, `sec-fetch-mode` included: the dev server adds its reload client only to navigations.

The preview refreshes through the site's own live reload. The Server saves ([ADR 0006](0006-server-saves-never-over-outside-changes.md)), Eleventy rebuilds, and its reload client in the iframe reloads or morphs the page. An edit can also move the page, because a permalink may follow front matter (on this site, a `date` in another year). So after every build that worked, the Server sends `{ type: "preview", url }` to the Collaborators of each open Post. A client whose preview shows another path replaces the iframe with a new one at that URL. It does not just change `src`: the old page's live reload can arrive after the message, and its `location.reload()` would cancel the navigation. A Post with `draft: true` works when the site still renders drafts while serving, as this site does: its draft check only leaves them out of collections.

When the site's first build fails, Eleventy stops, as `npm start` does. The editor is how a Post that breaks the build gets fixed, so the Server starts anyway. Only then does the launcher watch the site's input folder, ignoring the output folder, `node_modules` and the Server's own temp files (names ending in `~`). Only then, because on Linux Node watches every file and folder one by one, and a site whose input is its root would cost a walk of `node_modules` at every start. Once a file changes, it exits with code 75, and `startEleventy` forks a new one. A retry in the same process would build stale text: Eleventy caches the files it read in module state, and only its own watcher clears it.

On Linux, the launcher sets Eleventy's chokidar to `usePolling`. Its native watcher misses some of the Server's saves: the hard link that a save makes before its rename ([ADR 0006](0006-server-saves-never-over-outside-changes.md)) fires an event first, and chokidar 4 drops the events that follow it within 5 ms, including the one for the new file. Measured on CI with chokidar 4.0.3 and `writePost`: 19 of 20 saves seen natively, every one under test load lost for two Posts, 20 of 20 with polling. On macOS the native watcher saw 20 of 20, so it stays.

## Considered Options

- **Copying the site's permalink rule** (`/blog/<year of date>/<slug>/`): rejected. It drifts silently when the site changes its rule. `getFullYear()` depends on the time zone, and the special `date` values (`"Last Modified"`, `"git Created"`) give `/blog/NaN/…`.
- **The owner runs `npm start` and sets its URL in `.env`**: rejected by the owner. Collabtron will become an Eleventy plugin, so it may know how Eleventy starts. The `contentMap` listener is the one the plugin will add.
- **The site's config redirects to the Post's page** (a dev server `onRequest`): rejected, because it changes the site's repo.
- **A prefix such as `/preview/…` for the whole site**: rejected. The pages' absolute URLs and the reload socket would need rewriting.
- **A second port for the preview**: rejected. Public mode has one port, and the token's cookie (#15) has to cover the preview.

## Consequences

- Eleventy Dev Server 2 has no host option. It listens on every network interface, and its reload socket checks no `Origin`. So anyone on the same network can read the site's pages on the dev server's port, drafts included, the same as with `npm start`. Accepted for dev mode; the Server prints a warning at start. It must be closed before public mode (#37).
- A save that breaks the site's build is only reported in the terminal. Eleventy keeps serving the last page that built, and the Collaborators are not told (#38). The toolbar's empty image container is one such save today.
- A Collaborator who follows a link inside the preview is brought back to the Post's page after the next build.
- `watch`, `serve` and `directories` are public methods of Eleventy, but they are not documented: recheck them on each Eleventy minor version.
- `pnpm dev` builds the whole site before the preview shows, and `node --watch` restarts the Server and its Eleventy with it.
- A site with a `pathPrefix` is not supported yet: the map's URLs lack it.
- `POSTS_DIR` must be inside `SITE_DIR`, since the map is keyed by paths inside the site: the Server refuses to start otherwise. A Post the site does not render while serving (`permalink: false` for drafts) keeps the preview on its retry message.
- The proxy sits at the root, so a site file at `/main.js`, `/api/auth`, `/p/…`, `/preview/…` or `/ws/…` is hidden by the editor's own. This site has none.
- The launcher's `ready` server option is replaced if the site's config sets its own: the Server would then wait forever at start. This site sets none.
- If the launcher dies after it served, the Server says so in the terminal and the preview answers `502` until the Server restarts.
- Eleventy 4 uses Server-Sent Events for live reload instead of a WebSocket. The HTTP proxy streams responses, but that is untested.
- New dev dependency: `@11ty/eleventy`. Seam 3 runs the launcher against a small fixture site. At run time, collabtron uses the site's own Eleventy.
