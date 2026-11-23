// Runs in a child process with its working directory at the site: the site's own Eleventy, as `eleventy --serve --incremental`
// would run it, plus a listener that tells the Server where each input file renders to (ADR 0009, docs/research/eleventy-page-url.md).
import { existsSync, watch } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAgain } from "./eleventy.ts";

type EleventyConfig = { on(event: string, listener: (arg: any) => void): void; setServerOptions(options: object): void };

// The site's Eleventy, not one of collabtron's. `watch` and `serve` are what its cmd.cjs runs: public, but undocumented.
const { Eleventy } = await import(pathToFileURL(join(process.cwd(), "node_modules/@11ty/eleventy/src/Eleventy.js")).href);
const send = (message: object) => process.send!(message);
let inputPathToUrl = {};
const eleventy = new Eleventy(undefined, undefined, {
  source: "cli",
  runMode: "serve",
  quietMode: true,
  // Not in Eleventy 3's default config file names.
  configPath: existsSync("eleventy.config.ts") ? "eleventy.config.ts" : undefined,
  // Runs before the site's config file, which still runs.
  config(eleventyConfig: EleventyConfig) {
    // Every build sends the whole map, before rendering; a rebuild of passthrough copies alone sends an empty one.
    eleventyConfig.on("eleventy.contentMap", (map) => {
      if (Object.keys(map.inputPathToUrl).length) inputPathToUrl = map.inputPathToUrl;
    });
    // Only once the build is done, and never for one that failed: the Server opens only pages that were written.
    eleventyConfig.on("eleventy.after", () => send({ type: "contentMap", inputPathToUrl }));
    eleventyConfig.setServerOptions({ ready: (server: { getServerUrl(host: string): string }) => send({ type: "ready", url: server.getServerUrl("localhost") }) });
  },
});
await eleventy.init();
eleventy.setIncrementalBuild(true);
// Before the first build, which can fail: the editor is how a Post that breaks it gets fixed.
// The string: the OS picks a free port. A number 0 falls back to 8080.
eleventy.serve("0");
// The Server stopped, or died: its IPC channel closes with it.
process.on("disconnect", () => process.exit());

// Eleventy stops watching when its first build fails, as `eleventy --serve` does, and keeps what it read cached:
// once a file of the site changes, a new launcher builds again from scratch. Never for what the build itself writes.
let failed = false;
let changed = false;
const output = resolve(eleventy.directories.output);
const watcher = watch(eleventy.directories.input, { recursive: true }, (_event, name) => {
  const path = resolve(eleventy.directories.input, String(name));
  if (path.startsWith(output + sep) || path.split(sep).includes("node_modules")) return;
  changed = true;
  if (failed) process.exit(buildAgain);
});
try {
  await eleventy.watch();
  watcher.close();
} catch {
  // Eleventy has logged why.
  failed = true;
  if (changed) process.exit(buildAgain);
}
