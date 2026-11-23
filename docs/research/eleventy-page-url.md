# Eleventy page URL and the dev server

Research for the Server's preview: the catch-all proxy and `proxyUpgrade` in `src/server/server.ts`, and the copied permalink rule. Read in November 2026. Versions: `@11ty/eleventy` 3.1.2 (installed in the site) and `@11ty/eleventy-dev-server` 2.0.8. Eleventy 3.1.8, the npm `latest`, has the same cited files, with two exceptions: `Eleventy.js` imports a different chokidar package, and `Require.js` changes its ESM cache-busting, which shifts its line numbers. In Dev Server 2.1.2, `server.js` and `reload-client.js` differ only in the chokidar package. Source links are permalinks to the v3.1.2 and v2.0.8 tags (see [Sources](#sources)).

"Observed" means checked here on Node 24.12.0, macOS 15 (Darwin 24.6), time zone UTC−3. The checks ran against a scratch fixture site, not the site: two Posts at `src/posts/<slug>/index.md`, the site's permalink rule, and one passthrough copy folder. The fixture used the site's installed Eleventy.

## Question

How do plugins and tools learn which URL an input file such as `src/posts/<slug>/index.md` renders to? How can an outside process talk to a running `eleventy --serve`? What should collabtron do instead of copying the site's permalink rule (`/blog/<getFullYear(new Date(data.date || now))>/<page.fileSlug>/`), now and once it is a plugin?

## Short answer

- `eleventy.contentMap` is the source of truth. It fires on every build: full, watch, serve and incremental. Its payload maps each input path (`./`-prefixed and relative to the working directory) to its URLs. The `inputPathToUrl` filter is built on it.
- A small launcher can do what `cmd.cjs --serve` does (`init`, `watch`, `serve`). Its `config` callback adds an `eleventy.contentMap` listener without editing the site's config, and the site's config file still runs after it. The listener can send the map to collabtron's Server over `process.send`. Observed working.
- The dev server has no option for the host. It calls `listen({ port })`, so it listens on all interfaces. Its reload WebSocket takes any path and any `Origin`.
- A busy port moves to port+1, up to 10 times. The real port appears on stderr as `[11ty] Server at http://localhost:<port>/`, even with `--quiet`. `--port=0` (or `serve("0")`) lets the OS pick a free port, and a `ready` server option reports it with no log parsing.
- `.ts` is not in the 3.1.x default config file list. Plain Node 24 can import `eleventy.config.ts` only if it uses erasable syntax, `.ts` specifiers and `import type`. The site's config fails under plain Node, so the site needs `tsx`, and so does any launcher.

## 1. The `eleventy.contentMap` event

- **When:** `TemplateMap.cache()` emits it once permalinks and computed data are resolved, before any content is rendered ([TemplateMap.js][e-cache]). Each `TemplateWriter.write()` builds a new `TemplateMap` and calls `cache()` ([TemplateWriter.js][e-tw-create]). `write()` runs for every build: a plain build, the first build of `--watch`/`--serve` ([Eleventy.js][e-watch]) and every rebuild ([Eleventy.js][e-rewatch]). The docs only say it was added in v2.0.0 for the i18n plugin ([Events][d-events]).
- **Lazy:** the payload is computed only if a listener exists ([AsyncEventEmitter.js][e-lazy]).
- **Incremental builds:** every template is still added to the map. Rendering is only switched off for templates the change does not affect ([TemplateWriter.js][e-tw-inc]), so the map stays complete. Observed: after a Post changed, the map still listed both Posts.
- **One exception:** if the changed file is a passthrough copy file, every template is filtered out ([TemplateWriter.js][e-tw-copy]), and the event fires with `{}` for both maps. Observed with `--incremental`. A listener must ignore an empty map, or merge maps, rather than overwrite.
- **Listeners persist:** before each rebuild, `events.reset()` removes only internal `eleventy#` listeners ([Eleventy.js][e-init], [AsyncEventEmitter.js][e-reset]).
- **Payload** ([TemplateMap.js][e-gen]), as observed:

```js
{
  inputPathToUrl: { "./src/posts/hello/index.md": ["/blog/2025/hello/"] },   // one URL per page; more with pagination
  urlToInputPath: { "/blog/2025/hello/": { inputPath: "./src/posts/hello/index.md", groupNumber: 0 } },
}
```

- **Input path format:** a leading `./` is added to each entry ([TemplateMap.js][e-order]). Observed paths were relative to the working directory (the project root), not to the input folder, and used `/`.
- **URL format:** URLs are `page.url`, without `pathPrefix`. Eleventy adds the prefix itself before telling the dev server ([Eleventy.js][e-reload]).

## 2. The InputPathToUrl filter and plugin

- The filter plugin is added in `defaultConfig.js`, so `inputPathToUrl` works without `addPlugin` ([defaultConfig.js][e-defcfg], [docs][d-i2u]). The transform plugin is opt-in ([docs][d-i2u]).
- It keeps the last `inputPathToUrl` from the event ([InputPathToUrl.js][e-i2u-filter]). To look a path up, it decodes it and adds `./`. It tries the path as given if it starts with the input folder, then relative to the input folder, then relative to the current template ([InputPathToUrl.js][e-i2u-norm]). It returns `urls[0]` plus any `?query#hash`, and it throws if nothing matches ([InputPathToUrl.js][e-i2u-filter]).
- It is a template filter (it reads `this.page`), so the Server cannot call it. It shows the pattern to copy: listen to the event, keep the latest map, look up `./`-relative keys.

## 3. `eleventy.after` results

- **Arguments:** `directories`, `inputDir`, `dir`, `runMode`, `outputMode`, `incremental`, `results` and `uses` ([Eleventy.js][e-build]).
- **`results`:** the templates this build wrote, with `{ inputPath, outputPath, url, content }` ([Events][d-events]).
- **Full build:** `results` lists every page.
- **Incremental build:** it lists only re-rendered pages. Observed: 2 results on the first build, 1 after a Post changed.
- **On a build error:** the event is not emitted, because the code jumps to the error handler ([Eleventy.js][e-build]).
- So `eleventy.after` is a good "this page was rebuilt" signal. It cannot look up an unchanged Post.

## 4. Programmatic API and a launcher

- **Options:** `new Eleventy(input, output, options)` takes `source`, `runMode`, `dryRun`, `configPath`, `pathPrefix`, `quietMode`, `config` and `inputDir` ([Eleventy.js][e-ctor]). The docs show `configPath` and `config` but don't say how `config` combines with the config file ([Programmatic API][d-prog]).
- **`config` runs first, then the config file:** `config(userConfig)` runs in `initializeConfig()` before `eleventyConfig.init()` loads the config file ([Eleventy.js][e-initcfg]). The config file then receives the same `userConfig` ([TemplateConfig.js][e-require]). Plugins added by either one run after the config file ([TemplateConfig.js][e-plugins]). Observed: `config` ran, then the site config, and both `contentMap` listeners ran.
- **The site config can override it:** `setServerOptions` merges with a deep copy ([UserConfig.js][e-setsrv]). A key the site config sets later replaces the same key from `config`.
- **Config reset:** when the config file changes during watch, `resetConfig()` drops the config, and `init()` runs `initializeConfig()` again ([Eleventy.js][e-resetcfg], [Eleventy.js][e-rewatch]). So `config` runs again and its listeners come back.
- **Watch and serve:** the programmatic docs cover only `write`, `toJSON` and `toNDJSON` ([Programmatic API][d-prog]). `watch()`, `serve(port)` and `stopWatch()` are public methods all the same. `cmd.cjs --serve` is just: constructor, `init()`, `setIgnoreInitial`, `setIncrementalBuild`, `watch()`, `serve(argv.port)`, and SIGINT calls `stopWatch()` ([cmd.cjs][e-cmd]).
- **The launcher:** this sketch was observed working, forked with an IPC channel and `cwd` set to the fixture:

```js
// launcher.mjs: fork(launcher, { cwd: siteDir, execArgv: ["--import", "tsx"] }) gives process.send.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// The site's own Eleventy (its "import" export), not collabtron's.
const { Eleventy } = await import(pathToFileURL(join(process.cwd(), "node_modules/@11ty/eleventy/src/Eleventy.js")).href);
const elev = new Eleventy(undefined, undefined, {
  source: "cli", runMode: "serve", configPath: "eleventy.config.ts",
  config(eleventyConfig) {
    eleventyConfig.on("eleventy.contentMap", (map) => process.send({ type: "contentMap", map }));
    eleventyConfig.setServerOptions({ ready: (server) => process.send({ type: "ready", url: server.getServerUrl("localhost") }) });
  },
});
await elev.init();
elev.setIncrementalBuild(true); // --incremental
await elev.watch();             // first build, then chokidar
elev.serve("0");                // like --port=0; a number 0 would fall back to 8080 (see 6)
process.on("disconnect", () => elev.stopWatch().then(() => process.exit()));
```

What a launcher has to get right:

- **Working directory:** the child must run with `cwd` set to the site. Input paths and keys come out relative to it (observed).
- **TypeScript:** the site's config needs `tsx` (see 7). `node --import tsx`, run from `$SITE_DIR`, imported the site's config here. Node resolves `tsx` from the working directory.
- **`source: "cli"`:** with `"script"`, a build error is logged as an error rather than a fatal one ([Eleventy.js][e-build]).
- **The site's `ready`:** if the site's config sets its own `ready` server option, it replaces collabtron's (see the deep-copy merge above).
- **Timing:** the map is sent before rendering. A template error later in the same build still leaves the map sent.
- **Empty maps:** ignore the empty map from passthrough-only rebuilds (see 1).
- **IPC:** `process.send` exists only with an IPC channel (`fork`, or `"ipc"` in `stdio`). The payload is plain JSON.
- **Stability:** watch and serve from a script are undocumented, so re-check them on each Eleventy minor version.

## 5. Dev server

- **Options:** the defaults are `port` 8080, `reloadPort` false (same port), `liveReload`, `domDiff`, `showAllHosts`, `injectedScriptsFolder` `.11ty`, `portReassignmentRetryCount` 10, `https`, `encoding`, `pathPrefix`, `watch`, `aliases`, `indexFileName`, `useCache`, `headers`, `messageOnStart` and `onRequest` ([server.js][s-opts]). The docs list a subset ([Dev Server][d-dev]).
- **What Eleventy adds:** `pathPrefix`, its logger and the `setServerOptions` values, plus the `setup` and `ready` callbacks. `--port` wins over `serverOptions.port` ([EleventyServe.js][e-srv-opts], [EleventyServe.js][e-srv-serve]).
- **`onRequest`:** it maps a URLPattern pathname to a callback that receives `{ url, pattern, patternGroups }`. The callback returns a string, an object or a `Response`. It runs before static files ([server.js][s-onreq]).
- **Host:** there is no host option. `_serverListen` calls `listen({ port })` ([server.js][s-listen]), so Node binds `::`, every interface (observed `address: "::"`). `showAllHosts` only adds LAN URLs to the log line ([server.js][s-hosts]). Dev Server 3.0.0-alpha.17 adds `host: "127.0.0.1"` as the default, plus `allowedHosts` for live reload ([server.js v3][s3-opts]). Eleventy 4.0.0-alpha.12 depends on it ([package.json][e4-pkg]).
- **Trailing slash:** for `/x`, where only `x/index.html` exists, the response is `301` with `Location: <pathname>/` ([server.js][s-map], [server.js][s-loc]). `/x/` where only `x.html` exists gets a `301` to `/x`.
  - The Location is a path only, so behind a root proxy it stays on the proxy's origin.
  - The query string is dropped. Observed: `/blog/2025/hello?a=1` gave `301 /blog/2025/hello/`.
  - With a `pathPrefix`, `/` gets a `302` to the prefix.
- **Script injection:** every HTML response gets `<script type="module" integrity="…" src="/.11ty/reload-client.js[?reloadPort=N]">` ([server.js][s-notifier]). It goes before `</head>`, or else after an import map, `</title>`, `</body>`, and so on.
  - It is skipped when `sec-fetch-mode` is present and is not `navigate` ([server.js][s-wrap]). Observed: Node `fetch` (which sends `cors`) got no script, while `http.get` got it. A proxy must forward that header unchanged.
  - The script and `/.11ty/morphdom.js` are served by the dev server's own middleware ([server.js][s-client]).
- **Reload socket:** the client opens `ws(s)://<page host>` at path `/`, swapping in `reloadPort` if set ([reload-client.js][c-init]). The server is `new WebSocketServer({ server })` with no `path` and no `verifyClient` ([server.js][s-ws]). So it accepts any upgrade on any path, with any `Origin` or `Host`.
  - Observed: `Origin: http://evil.example` at `/any/path` was accepted and received the reload, including the page HTML.
  - With `reloadPort`, `ws` opens its own listener on that port.
  - Dev Server 3 alpha uses `EventSource`, not a WebSocket ([reload-client.js v3][c3-sse]).
- **Messages:** `eleventy.status` (`connected`/`disconnected`), `eleventy.error`, and the reload ([server.js][s-reload]):

```js
{ type: "eleventy.reload", subtype: "css" | undefined, files: ["./src/posts/hello/index.md"],
  build: { stylesheets: [...], templates: [{ url, inputPath, outputPath, content, ... }] } }
```

- **Which templates a reload carries:** Eleventy sends every template written in that build. URLs carry `pathPrefix`, and `rawInput` is removed ([Eleventy.js][e-reload]). The dev server keeps only templates whose `inputPath` is in `files`, and none when `domDiff` is off ([server.js][s-reload]). The client morphs only an entry whose `url` equals `location.pathname`, and otherwise reloads the page ([reload-client.js][c-default]).
  - So `templates` is filled only when the page's own input file changed. A change to a layout or a data file sends `templates: []`, which means a full reload (inferred from the filter).

## 6. Port behaviour

- **A busy port:** on `EADDRINUSE`, the server retries on port+1, up to `portReassignmentRetryCount` (10), then throws ([server.js][s-port], [Dev Server][d-dev]).
- **The log line:** when the server starts listening, `messageOnStart` logs `Server at http://localhost:<port>/` ([server.js][s-opts], [server.js][s-port]). With `showAllHosts` it adds ` or http://<ip>:<port>/`.
  - It goes through Eleventy's `info`, which calls `console.warn`, so it lands on stderr with an `[11ty] ` prefix ([ConsoleLogger.js][e-log]).
  - `EleventyServe` has its own logger, so `--quiet` does not hide the line ([EleventyServe.js][e-srv-log]).
  - Observed with 47901 busy: `[11ty] Server at http://localhost:47902/` on stderr.
- **No parsing needed:** `serve(port)` passes `port || options.port` ([EleventyServe.js][e-srv-serve]). The CLI's `--port` is a string ([cmd.cjs][e-cmd]), so `--port=0` reaches `listen` and the OS picks a free port (observed: `Server at http://localhost:58012/`). A number `0` would fall back to 8080.
  - In a launcher, the `ready` option is called after listening ([EleventyServe.js][e-srv-serve]). `server.getServerUrl("localhost")` reads the bound port ([server.js][s-url]). Observed working.
- **macOS caveat:** the retry only reacts to `EADDRINUSE`. Here, a listener on `127.0.0.1:P` did not stop a second `listen({ port: P })` on `::` (observed). After that, `127.0.0.1:P` reached the loopback listener, while `[::1]:P` and `localhost` (Node tried `::1` first) reached the dev server.
  - So a requested port that a loopback-only server already holds is not moved, and the proxy may talk to the wrong process. `--port=0` avoids this.

## 7. TypeScript config file

- **Default list:** `.eleventy.js`, `eleventy.config.js`, `eleventy.config.mjs`, `eleventy.config.cjs`. There is no `.ts` in 3.1.2 or 3.1.8 ([TemplateConfig.js][e-cfgfiles], [Configuration][d-config]), so `--config=eleventy.config.ts` is required.
- **How it loads:** the config is loaded with a plain `import()` of its file URL ([Require.js][e-import]). So `.ts` works whenever Node can import `.ts`.
  - The docs show `npx @11ty/eleventy --config=eleventy.config.ts` with Node's type stripping (22.6+), or `tsx` ([TypeScript][d-ts]).
  - Type stripping is on by default since Node 23.6/22.18 and stable in 24.12 ([Node TypeScript][n-ts]). `process.features.typescript` was `"strip"` here.
- **What fails under plain Node** (each one checked here):
  - A `.js` specifier pointing at a `.ts` file gives `ERR_MODULE_NOT_FOUND`. Node needs the real extension, and `tsx` maps it ([Node][n-ts]).
  - Type names imported without `type` from a JS package give `SyntaxError: Named export '…' not found` ([Node][n-ts-type]).
  - `enum` gives `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. The same goes for namespaces with runtime code, parameter properties and import aliases ([Node][n-ts]). `tsconfig` `paths` are ignored.
- **The site:** `node node_modules/@11ty/eleventy/cmd.cjs --config=eleventy.config.ts --dryrun --quiet` exited 1 with `Error in your Eleventy config file 'eleventy.config.ts'` and `Cannot find module '<$SITE_DIR>/src/_config/<helper>.js'`.
  - The config imports a `.ts` helper through a `.js` specifier.
  - It also imports type names from `@11ty/eleventy-img` without `import type`, which would fail next.
  - Nothing was built. `node --import tsx` loads the same file.
- **Side effects:** even `--dryrun` is not side-effect free for the site. Its `eleventy.before` handler writes CSS into the output folder.

## What this means for collabtron

**Now (spawned child):**

1. **Spawn a launcher, not `cmd.cjs`:** use the item-4 shape, `fork(launcher, { cwd: $SITE_DIR, execArgv: ["--import", "tsx"] })`. The site's config stays untouched, and nothing duplicates the permalink rule.
2. **Look up the Post:** keep the latest non-empty `inputPathToUrl` and look up `"./" + posix(relative($SITE_DIR, postFile))`. Take `urls[0]` and prepend `pathPrefix` if the site sets one (this site does not).
3. **Follow the URL:** each build sends a new map, so when an edited `date` moves the Post, the Server re-points the iframe. `eleventy.after` (or the proxied `eleventy.reload`) says when the page was rebuilt.
4. **The port:** use `serve("0")` plus `ready`, not a fixed port and not log parsing. If collabtron keeps `cmd.cjs`, `--port=0` plus the stderr line works, but the URL then still comes from the copied rule.
5. **Needs a decision:** the dev server listens on every interface, and its socket checks no `Origin`. So drafts and live HTML are readable from the LAN on the child's port. collabtron's Origin check covers only the proxied path. No 2.x option fixes this. The way out is upstream: Dev Server 3 binds `127.0.0.1` by default. The other option is to run `--watch` without the dev server and have the Server serve the output folder on loopback, which loses trailing-slash redirects, live reload, `onRequest` and passthrough emulation.

**Once collabtron is an Eleventy plugin:** the plugin calls `eleventyConfig.on("eleventy.contentMap", …)` in Eleventy's own process. That needs no launcher and no IPC, and the keys and empty-map rule stay the same. The site's config adds the plugin, so `tsx` is the site's concern. Watch two things:

- The site's own `setServerOptions({ ready })` would replace the plugin's.
- On Eleventy 4, the script folder is `.ba` and live reload uses SSE instead of a WebSocket ([server.js v3][s3-opts], [reload-client.js v3][c3-sse]). `proxyUpgrade` would no longer carry live reload, so the HTTP proxy must stream SSE.

**Caveats of the copied rule** (each one observed in the fixture):

- **Time zone:** YAML `date: 2026-01-01` is midnight UTC ([Dates][d-dates]), and `getFullYear()` uses the process's zone. At UTC−3 that gives `/blog/2025/hello/`. The copy matches the local dev server, because the child inherits the zone, but a UTC build server publishes `/blog/2026/…`.
- **Special values:** `data.date` is the raw cascade value, not `page.date` ([Dates][d-dates]). So `"Last Modified"`, `"Created"`, `"git Last Modified"` and `"git Created"` become an Invalid Date, and the URL becomes `/blog/NaN/<slug>/`. The site breaks the same way.
- **Missing date:** `new Date()` gives the year of each build, not the Post's year. A rebuild after 1 January moves the URL. Eleventy's own fallback (a date in the path, then the file's creation date) is not used by the rule.
- **Slug:** for `index.md`, `fileSlug` is the parent folder's name ([TemplateFileSlug.js][e-slug]), and a copy must repeat that.
- **Drift:** any change to the site's rule silently breaks the copy. The content map cannot drift.

## Sources

| Repo | Commit / version |
|---|---|
| [11ty/eleventy](https://github.com/11ty/buildawesome/tree/0064599391499da31800af1b7130a036f576ad5a) (now `11ty/buildawesome`) | v3.1.2 `0064599`, same files in v3.1.8 `a496c71`; v4.0.0-alpha.12 `40a5c75` |
| [11ty/eleventy-dev-server](https://github.com/11ty/dev-server/tree/1c658605f75224fdc76f68aebe7a412eeb4f1bc9) (now `11ty/dev-server`) | v2.0.8 `1c65860`; v3.0.0-alpha.17 `7d35509` |

Docs: [Events][d-events], [Programmatic API][d-prog], [Dev Server][d-dev], [Configuration][d-config], [TypeScript][d-ts], [InputPathToUrl][d-i2u], [Dates][d-dates], [Node.js TypeScript][n-ts].

[d-events]: https://www.11ty.dev/docs/events/#eleventy-content-map
[d-prog]: https://www.11ty.dev/docs/programmatic/#full-options-list
[d-dev]: https://www.11ty.dev/docs/dev-server/#options
[d-config]: https://www.11ty.dev/docs/config/#default-filenames
[d-ts]: https://www.11ty.dev/docs/languages/typescript/#using-a-type-script-configuration-file
[d-i2u]: https://www.11ty.dev/docs/plugins/inputpath-to-url/
[d-dates]: https://www.11ty.dev/docs/dates/#setting-a-content-date-in-front-matter
[n-ts]: https://nodejs.org/api/typescript.html#type-stripping
[n-ts-type]: https://nodejs.org/api/typescript.html#importing-types-without-type-keyword
[e-cache]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateMap.js#L256-L300
[e-gen]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateMap.js#L302-L322
[e-order]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateMap.js#L234-L254
[e-lazy]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Util/AsyncEventEmitter.js#L61-L81
[e-reset]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Util/AsyncEventEmitter.js#L18-L26
[e-tw-inc]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateWriter.js#L177-L290
[e-tw-copy]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateWriter.js#L318-L337
[e-tw-create]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateWriter.js#L348-L356
[e-defcfg]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/defaultConfig.js#L80
[e-i2u-norm]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Plugins/InputPathToUrl.js#L5-L46
[e-i2u-filter]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Plugins/InputPathToUrl.js#L85-L122
[e-ctor]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Eleventy.js#L94-L110
[e-initcfg]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Eleventy.js#L246-L264
[e-init]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Eleventy.js#L501-L508
[e-resetcfg]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Eleventy.js#L866-L871
[e-rewatch]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Eleventy.js#L946-L972
[e-reload]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Eleventy.js#L1008-L1027
[e-watch]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Eleventy.js#L1196-L1213
[e-build]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Eleventy.js#L1404-L1468
[e-cmd]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/cmd.cjs#L34-L128
[e-cfgfiles]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateConfig.js#L73-L79
[e-require]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateConfig.js#L377-L410
[e-plugins]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateConfig.js#L511-L517
[e-import]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Util/Require.js#L124-L148
[e-setsrv]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/UserConfig.js#L924-L930
[e-srv-log]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/EleventyServe.js#L30-L35
[e-srv-opts]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/EleventyServe.js#L144-L167
[e-srv-serve]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/EleventyServe.js#L222-L243
[e-log]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/Util/ConsoleLogger.js#L78-L136
[e-slug]: https://github.com/11ty/buildawesome/blob/0064599391499da31800af1b7130a036f576ad5a/src/TemplateFileSlug.js#L42-L52
[e4-pkg]: https://github.com/11ty/buildawesome/blob/40a5c752dc5e1ae49fcbcf918323e872a310a7ac/package.json#L134
[s-opts]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L23-L68
[s-map]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L269-L342
[s-notifier]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L382-L432
[s-onreq]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L484-L541
[s-client]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L543-L554
[s-loc]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L596-L601
[s-wrap]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L626-L648
[s-hosts]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L682-L691
[s-port]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L721-L762
[s-listen]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L771-L775
[s-url]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L785-L800
[s-ws]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L826-L849
[s-reload]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/server.js#L1000-L1021
[c-default]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/client/reload-client.js#L138-L147
[c-init]: https://github.com/11ty/dev-server/blob/1c658605f75224fdc76f68aebe7a412eeb4f1bc9/client/reload-client.js#L235-L252
[s3-opts]: https://github.com/11ty/dev-server/blob/7d35509038b5452e39408190ae0d573a5da1fd4d/server.js#L58-L100
[c3-sse]: https://github.com/11ty/dev-server/blob/7d35509038b5452e39408190ae0d573a5da1fd4d/client/reload-client.js#L588-L597
