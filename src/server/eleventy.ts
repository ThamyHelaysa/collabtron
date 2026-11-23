import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

// The launcher's exit code when the site's first build failed and a file changed since: a new launcher builds again.
export const buildAgain = 75;

// What the launcher tells the Server, over IPC.
export type LauncherMessage = { type: "ready"; url: string } | { type: "contentMap"; inputPathToUrl: Record<string, string[]> };

// Starts the site's own Eleventy dev server and learns, from Eleventy itself, the URL each Post file renders to (ADR 0009).
// Resolves once it serves, before the first build is done: until a build works, `pageUrl` knows no Post.
export function startEleventy(siteDir: string) {
  let inputPathToUrl: Record<string, string[]> = {};
  let child: ChildProcess;
  let closed = false;
  const eleventy = {
    // Changes when a new launcher takes over; the Server reads it on every request.
    url: "",
    // Eleventy's keys are relative to the site, with `./` and `/`.
    // shortcut: no pathPrefix in front of the URL; add Eleventy's when a site sets one.
    pageUrl: (file: string): string | undefined => inputPathToUrl[`./${relative(siteDir, file).split(sep).join("/")}`]?.[0],
    async close() {
      closed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
  };
  return new Promise<typeof eleventy>((resolve, reject) => {
    const launch = () => {
      child = fork(new URL("./eleventy-launcher.ts", import.meta.url), {
        cwd: siteDir,
        // Never the Server's own flags (`--watch`, `--env-file`). A TypeScript config needs the site's own loader:
        // plain Node cannot load every one (docs/research/eleventy-page-url.md).
        execArgv: existsSync(join(siteDir, "eleventy.config.ts")) ? ["--import", "tsx"] : [],
      });
      child.once("exit", (code) => {
        if (closed) return;
        if (code === buildAgain) return launch();
        const error = new Error(`the site's Eleventy stopped (exit code ${code}): the preview is gone until the Server restarts`);
        // After it served, nothing awaits the promise any more.
        if (eleventy.url) console.error(error.message);
        reject(error);
      });
      child.on("message", (message: LauncherMessage) => {
        if (message.type === "contentMap") inputPathToUrl = message.inputPathToUrl;
        if (message.type !== "ready") return;
        eleventy.url = message.url;
        resolve(eleventy);
      });
    };
    launch();
  });
}
