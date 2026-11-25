import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

// What the launcher tells the Server, over IPC.
export type LauncherMessage = { type: "ready"; url: string } | { type: "contentMap"; inputPathToUrl: Record<string, string[]> };

// Starts the site's own Eleventy dev server and learns, from Eleventy itself, the URL each Post file renders to (ADR 0009).
// Resolves once it serves, before the first build is done: until a build works, `pageUrl` knows no Post.
export function startEleventy(siteDir: string) {
  let inputPathToUrl: Record<string, string[]> = {};
  const builtListeners = new Set<() => void>();
  let closed = false;
  const child = fork(new URL("./eleventy-launcher.ts", import.meta.url), {
    cwd: siteDir,
    // Never the Server's own flags (`--watch`, `--env-file`). A TypeScript config needs the site's own loader:
    // plain Node cannot load every one (docs/research/eleventy-page-url.md).
    execArgv: existsSync(join(siteDir, "eleventy.config.ts")) ? ["--import", "tsx"] : [],
  });
  const eleventy = {
    url: "",
    // Eleventy's keys are relative to the site, with `./` and `/`.
    // shortcut: no pathPrefix in front of the URL; add Eleventy's when a site sets one.
    pageUrl: (file: string): string | undefined => inputPathToUrl[`./${relative(siteDir, file).split(sep).join("/")}`]?.[0],
    // After every build that worked: a page can move, as a permalink may follow front matter.
    onBuild: (listener: () => void) => void builtListeners.add(listener),
    async close() {
      closed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
  };
  return new Promise<typeof eleventy>((resolve, reject) => {
    child.once("exit", (code) => {
      if (closed) return;
      const error = new Error(`the site's Eleventy stopped (exit code ${code}): the preview is gone until the Server restarts`);
      // After it served, nothing awaits the promise any more.
      if (eleventy.url) console.error(error.message);
      reject(error);
    });
    child.on("message", (message: LauncherMessage) => {
      if (message.type === "contentMap") {
        inputPathToUrl = message.inputPathToUrl;
        for (const listener of builtListeners) listener();
      }
      if (message.type !== "ready") return;
      eleventy.url = message.url;
      resolve(eleventy);
    });
  });
}
