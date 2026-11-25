// Runs in a child process with its working directory at the site: the site's own Eleventy, as `eleventy --serve --incremental`
// would run it, plus a listener that tells the Server where each input file renders to (ADR 0009, docs/research/eleventy-page-url.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LauncherMessage } from "./eleventy.ts";

type EleventyConfig = { on(event: string, listener: (arg: any) => void): void; setServerOptions(options: object): void; setChokidarConfig(options: object): void };

// The site's Eleventy, not one of collabtron's.
const site = join(process.cwd(), "node_modules/@11ty/eleventy");
const { version } = JSON.parse(readFileSync(join(site, "package.json"), "utf8"));
// Its Dev Server 2 has no host option and listens on every network interface (#37).
if (parseInt(version) < 4) throw new Error(`the site's Eleventy is ${version}: the preview needs Eleventy 4, whose dev server listens on loopback only`);
// `watch` and `serve` are what its cmd.cjs runs: public, but undocumented.
const { Eleventy } = await import(pathToFileURL(join(site, "src/Core.js")).href);
const send = (message: LauncherMessage) => process.send!(message);
let inputPathToUrl: Record<string, string[]> = {};
const eleventy = new Eleventy(undefined, undefined, {
  source: "cli",
  runMode: "serve",
  quietMode: true,
  // Runs before the site's config file, which still runs.
  config(eleventyConfig: EleventyConfig) {
    // Every build sends the whole map, before rendering; a rebuild of passthrough copies alone sends an empty one.
    eleventyConfig.on("eleventy.contentMap", (map) => {
      if (Object.keys(map.inputPathToUrl).length) inputPathToUrl = map.inputPathToUrl;
    });
    // Only once the build is done, and never for one that failed: the Server opens only pages that were written.
    eleventyConfig.on("eleventy.after", () => send({ type: "contentMap", inputPathToUrl }));
    eleventyConfig.setServerOptions({
      ready(server: { listenHost?: string; getServerUrl(host: string): string }) {
        // The site's config may set another host, or another server module: the drafts stay off the network either way.
        if (!/^(127\.|::1$|localhost$)/.test(server.listenHost ?? "")) {
          console.error(`The site's Eleventy dev server listens on ${server.listenHost ?? "an address it does not say"}, not loopback only: stopping it.`);
          process.exit(1);
        }
        // Where it listens, not `localhost`: Node tries `::1` first, where another process may hold the same port.
        send({ type: "ready", url: server.getServerUrl(server.listenHost === "::1" ? "[::1]" : server.listenHost!) });
      },
    });
    // On Linux, chokidar 4's native watcher misses some of the Server's saves: the hard link made before the rename (ADR 0006)
    // fires first, and its throttle drops the events that follow. Polling sees every one (ADR 0009).
    if (process.platform === "linux") eleventyConfig.setChokidarConfig({ usePolling: true });
  },
});
await eleventy.init();
eleventy.setIncrementalBuild(true);
// Before the first build, which can fail: the editor is how a Post that breaks it gets fixed.
// The string: the OS picks a free port. A number 0 falls back to 8080.
eleventy.serve("0");
// The Server stopped, or died: its IPC channel closes with it.
process.on("disconnect", () => process.exit());
// A first build that fails is logged, and Eleventy keeps watching: a fix builds again.
await eleventy.watch();
