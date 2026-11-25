# The preview is the site's own Eleventy, through the Server

The editor shows the Post's page beside it, in the `#preview` iframe, as the site renders it (issue #14). Collabtron does not render the page itself: the site's own Eleventy dev server does, and the Server proxies it. Research: [eleventy-page-url](../research/eleventy-page-url.md).

The Server starts that dev server. `startEleventy` (`src/server/eleventy.ts`) forks `src/server/eleventy-launcher.ts` with its working directory at `SITE_DIR`. The launcher loads the Eleventy installed in the site, which must be Eleventy 4 or later, and runs it the way `eleventy --serve --incremental` does. When the site's config is `eleventy.config.ts`, it gets `--import tsx`, because plain Node cannot load every TypeScript config. Eleventy's programmatic `config` callback runs before the site's config file, so it adds what collabtron needs without touching the site:

- `eleventy.contentMap` gives the URL of every input file. The launcher sends the map to the Server on `eleventy.after`, which a build that failed never reaches. So the Server only opens pages that were written.
- The `ready` server option gives the port. It is `serve("0")`, so the OS picks a free port, never the Server's own.
- The same `ready` checks where the dev server listens, and stops it unless that is loopback (`127.*`, `::1`, `localhost`).

**Loopback only** (#37). Anyone who reaches the dev server's own port reads the site's pages, drafts included, without the Share Link. Eleventy 4's Dev Server 3 listens on `127.0.0.1` by default. Its Dev Server 2 (Eleventy 3) has no host option and listens on every network interface, so the launcher refuses an Eleventy older than 4 before it starts anything. A site's config can still set another `host`, or another server module, so the `ready` check stays. The Server reaches the dev server at the host it listens on, not at `localhost`: Node tries `::1` first, where another process may hold the same port.

`/preview/<post-id>` redirects to the Post's page from that map. Until a build has worked, it answers `503` with `Refresh: 2`, so the iframe asks again on its own.

Every other path the editor does not use (`/p/`, `/api/auth`, `/preview/`, `/ws/`, `/main.js`) goes to the dev server, at the root of the Server's own origin. The site's pages use absolute URLs, and so does the reload client: it reads Server-Sent Events from `/.ba/events`. That is an HTTP response that stays open, and the proxy streams it, so the preview's cookie covers it as it covers the pages ([ADR 0010](0010-token-opens-the-socket-a-cookie-the-preview.md)). Nothing of the site upgrades to a WebSocket any more: an upgrade outside `/ws/` gets `404`. Headers are forwarded as sent, `sec-fetch-mode` included: the dev server adds its reload client only to navigations.

The preview refreshes through the site's own live reload. The Server saves ([ADR 0006](0006-server-saves-never-over-outside-changes.md)), Eleventy rebuilds, and its reload client in the iframe reloads or morphs the page. An edit can also move the page, because a permalink may follow front matter (on this site, a `date` in another year). So after every build that worked, the Server sends `{ type: "preview", url }` to the Collaborators of each open Post. A client whose preview shows another path replaces the iframe with a new one at that URL. It does not just change `src`: the old page's live reload can arrive after the message, and its `location.reload()` would cancel the navigation. A Post with `draft: true` works when the site still renders drafts while serving, as this site does: its draft check only leaves them out of collections.

When the site's first build fails, the Server starts anyway: the editor is how a Post that breaks the build gets fixed. Eleventy 4 logs the error and keeps watching, so the fix builds in the same process. (Eleventy 3 stopped watching there, and the launcher had to start a new one.)

On Linux, the launcher sets Eleventy's chokidar to `usePolling`. Its native watcher misses some of the Server's saves: the hard link that a save makes before its rename ([ADR 0006](0006-server-saves-never-over-outside-changes.md)) fires an event first, and chokidar 4 drops the events that follow it within 5 ms, including the one for the new file. Measured on CI with chokidar 4.0.3 and `writePost`: 19 of 20 saves seen natively, every one under test load lost for two Posts, 20 of 20 with polling. On macOS the native watcher saw 20 of 20, so it stays.

## Considered Options

- **Copying the site's permalink rule** (`/blog/<year of date>/<slug>/`): rejected. It drifts silently when the site changes its rule. `getFullYear()` depends on the time zone, and the special `date` values (`"Last Modified"`, `"git Created"`) give `/blog/NaN/…`.
- **The owner runs `npm start` and sets its URL in `.env`**: rejected by the owner. Collabtron will become an Eleventy plugin, so it may know how Eleventy starts. The `contentMap` listener is the one the plugin will add.
- **The site's config redirects to the Post's page** (a dev server `onRequest`): rejected, because it changes the site's repo.
- **A prefix such as `/preview/…` for the whole site**: rejected. The pages' absolute URLs and the reload socket would need rewriting.
- **A second port for the preview**: rejected. Public mode has one port, and the token's cookie (#15) has to cover the preview.
- **Eleventy `--watch` without its dev server, the Server serving the output folder on loopback** (#37): rejected by the owner. It loses the dev server's trailing-slash redirects, live reload, `onRequest` and passthrough emulation, which collabtron would write again.

## Consequences

- The site must run Eleventy 4, an alpha today (`4.0.0-alpha.12`, Dev Server `3.0.0-alpha.17`): a site on Eleventy 3 gets no preview, and the Server does not start.
- A site config that sets a non-loopback `host` listens there for the moment before `ready` stops it.
- Dev Server 3 refuses a live reload whose `Host` is a domain name not in its `allowedHosts` option; `localhost` and IP addresses always pass. Dev mode sends `127.0.0.1`. Public mode (#16) sends its own domain, so the launcher will have to allow it.
- A save that breaks the site's build is only reported in the terminal. Eleventy keeps serving the last page that built, and the Collaborators are not told (#38). The toolbar's empty image container is one such save today.
- A Collaborator who follows a link inside the preview is brought back to the Post's page after the next build.
- `watch`, `serve` and `setIncrementalBuild` are public methods of Eleventy, but they are not documented: recheck them on each Eleventy minor version.
- `pnpm dev` builds the whole site before the preview shows, and `node --watch` restarts the Server and its Eleventy with it.
- A site with a `pathPrefix` is not supported yet: the map's URLs lack it.
- `POSTS_DIR` must be inside `SITE_DIR`, since the map is keyed by paths inside the site: the Server refuses to start otherwise. A Post the site does not render while serving (`permalink: false` for drafts) keeps the preview on its retry message.
- The proxy sits at the root, so a site file at `/main.js`, `/api/auth`, `/p/…`, `/preview/…` or `/ws/…` is hidden by the editor's own. This site has none.
- The launcher's `ready` server option is replaced if the site's config sets its own: the Server would then wait forever at start. This site sets none.
- If the launcher dies after it served, the Server says so in the terminal and the preview answers `502` until the Server restarts.
- New dev dependency: `@11ty/eleventy`. Seam 3 runs the launcher against a small fixture site. At run time, collabtron uses the site's own Eleventy.
