import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createPostCatalog } from "./post-catalog.ts";
import { startServer } from "./server.ts";

const postFile = "---\ntitle: Lorem\n---\n\n# Ipsum\n\nDolor sit amet.\n";

let postsDir: string;
let base: string;
let close: (() => Promise<void>) | undefined;
// Stands in for the site's own `eleventy --serve`: answers every request with where it was asked.
let eleventy: Server;

beforeEach(async () => {
  eleventy = createServer((req, res) => res.writeHead(200, { "content-type": "text/html", "x-site": "yes" }).end(`site page ${req.method} ${req.url}`));
  // Its live reload socket, which the reload client opens at ws://<the page's host>/.
  new WebSocketServer({ server: eleventy }).on("connection", (socket, req) => socket.send(`reload socket ${req.url}`));
  await new Promise<void>((resolve) => eleventy.listen(0, "127.0.0.1", resolve));

  postsDir = await mkdtemp(join(tmpdir(), "collabtron-"));
  await mkdir(join(postsDir, "lorem-ipsum"));
  await writeFile(join(postsDir, "lorem-ipsum", "index.md"), postFile);
  await mkdir(join(postsDir, "other-post"));
  await writeFile(join(postsDir, "other-post", "index.md"), "other\n");

  const catalog = await createPostCatalog(postsDir, ["lorem-ipsum"]);
  const server = await startServer({ host: "127.0.0.1", port: 0, catalog, eleventy: {
      url: `http://127.0.0.1:${(eleventy.address() as AddressInfo).port}`,
      // Where the site put each Post, as Eleventy's content map says.
      page: (file) => (file === join(postsDir, "lorem-ipsum", "index.md") ? "/blog/2026/lorem-ipsum/" : undefined),
    },
  });
  close = server.close;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await close?.();
  close = undefined;
  eleventy.closeAllConnections();
  await new Promise((resolve) => eleventy.close(resolve));
  await rm(postsDir, { recursive: true, force: true });
});

test("serves the editor page for a Post in the Post Catalog", async () => {
  const res = await fetch(`${base}/p/lorem-ipsum`);

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain('<div id="editor">');
});

test("Post Catalog refuses a Post ID that is not a plain folder name", async () => {
  await expect(createPostCatalog(postsDir, ["../lorem-ipsum"])).rejects.toThrow();
  await expect(createPostCatalog(postsDir, ["lorem-ipsum/"])).rejects.toThrow();
});

test("Post Catalog refuses a Post ID with no Post on disk", async () => {
  await expect(createPostCatalog(postsDir, ["missing"])).rejects.toThrow();
});

test("rejects Post IDs not in the Post Catalog, even ones that exist on disk", async () => {
  for (const id of ["other-post", "..%2Fother-post", "missing"]) {
    expect((await fetch(`${base}/p/${id}`)).status).toBe(404);
    expect((await fetch(`${base}/api/posts/${id}`)).status).toBe(404);
  }
});

test("loads the whole Post file, front matter included", async () => {
  const res = await fetch(`${base}/api/posts/lorem-ipsum`);

  expect(res.status).toBe(200);
  expect(await res.text()).toBe(postFile);
});

test("saving is the Server's alone: a tab cannot write the Post file", async () => {
  expect((await fetch(`${base}/api/posts/lorem-ipsum`, { method: "PUT", body: "x" })).status).toBe(405);
  expect(await readFile(join(postsDir, "lorem-ipsum", "index.md"), "utf8")).toBe(postFile);
});

test("a path the editor does not use is the site's own, from its Eleventy dev server", async () => {
  const res = await fetch(`${base}/blog/2026/lorem-ipsum/?x=1`);

  expect(res.status).toBe(200);
  expect(res.headers.get("x-site")).toBe("yes");
  expect(await res.text()).toBe("site page GET /blog/2026/lorem-ipsum/?x=1");
});

test("the site's live reload socket reaches its Eleventy dev server, from the editor's own origin only", async () => {
  const own = new WebSocket(base.replace("http:", "ws:") + "/", { headers: { origin: base } } as never);
  const message = await new Promise((resolve, reject) => {
    own.onmessage = (event) => resolve(event.data);
    own.onerror = reject;
  });
  own.close();
  expect(message).toBe("reload socket /");

  const other = new WebSocket(base.replace("http:", "ws:") + "/", { headers: { origin: "http://evil.example" } } as never);
  const opened = await new Promise((resolve) => {
    other.onopen = () => resolve(true);
    other.onerror = () => resolve(false);
  });
  expect(opened).toBe(false);
});

test("the preview of a Post opens its page wherever the site put it, and only for a Post in the Post Catalog", async () => {
  const res = await fetch(`${base}/preview/lorem-ipsum`, { redirect: "manual" });

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/blog/2026/lorem-ipsum/");
  expect((await fetch(`${base}/preview/other-post`, { redirect: "manual" })).status).toBe(404);
});
