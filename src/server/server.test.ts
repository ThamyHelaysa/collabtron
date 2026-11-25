import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostCatalog } from "./post-catalog.ts";
import { startServer } from "./server.ts";

const postFile = "---\ntitle: Lorem\n---\n\n# Ipsum\n\nDolor sit amet.\n";

let postsDir: string;
let base: string;
let token: string;
// The preview's cookie, as the editor page gets it with the Share Link's token.
let cookie: string;
let close: (() => Promise<void>) | undefined;
// Stands in for the site's own `eleventy --serve`: answers every request with where it was asked.
let eleventy: Server;

beforeEach(async () => {
  eleventy = createServer((req, res) => {
    // Its live reload, which the reload client reads with an EventSource: one event, then the stream stays open.
    if (req.url === "/.ba/events") return void res.writeHead(200, { "content-type": "text/event-stream" }).write("data: reload\n\n");
    res.writeHead(200, { "content-type": "text/html", "x-site": "yes" }).end(`site page ${req.method} ${req.url}`);
  });
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
      pageUrl: (file) => (file === join(postsDir, "lorem-ipsum", "index.md") ? "/blog/2026/lorem-ipsum/" : undefined),
      onBuild: () => {},
    },
  });
  close = server.close;
  token = server.token;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = (await fetch(`${base}/api/auth`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).headers.get("set-cookie")?.split(";")[0] ?? "";
});

const withCookie = () => ({ headers: { cookie } });
// The site's live reload, through the Server: its first event, read while the stream is still open.
async function reloadStream() {
  const reader = (await fetch(`${base}/.ba/events`, withCookie())).body!.getReader();
  return { first: new TextDecoder().decode((await reader.read()).value), reader };
}

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
    expect((await fetch(`${base}/preview/${id}`, withCookie())).status).toBe(404);
  }
});

test("the Share Link's token gets the preview's cookie, kept from the page's scripts and from other sites; another token gets none", async () => {
  const res = await fetch(`${base}/api/auth`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

  expect(res.status).toBe(204);
  expect(res.headers.get("set-cookie")!.split("; ")).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "Secure", "SameSite=Strict"]));
  expect(token).toMatch(/^[\w-]{43}$/); // 32 bytes
  for (const authorization of ["Bearer wrong", `Bearer ${token}x`, `Bearer ${"é".repeat(43)}`, token, ""]) {
    const refused = await fetch(`${base}/api/auth`, { method: "POST", headers: { authorization } });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();
  }
});

test("the preview and every page of the site are refused without the cookie, the site's live reload too", async () => {
  for (const headers of [{}, { cookie: "__Host-collabtron=wrong" }, { cookie: `__Host-collabtron=${token}` }] as Record<string, string>[]) {
    expect((await fetch(`${base}/blog/2026/lorem-ipsum/`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/preview/lorem-ipsum`, { headers, redirect: "manual" })).status).toBe(403);
    expect((await fetch(`${base}/.ba/events`, { headers })).status).toBe(403);
  }
  // The editor page itself holds nothing of the Post: the token is in the link's fragment, which only the page reads.
  expect((await fetch(`${base}/p/lorem-ipsum`)).status).toBe(200);
});

test("saving is the Server's alone: a tab cannot write the Post file", async () => {
  await fetch(`${base}/api/posts/lorem-ipsum`, { ...withCookie(), method: "PUT", body: "x" });
  expect(await readFile(join(postsDir, "lorem-ipsum", "index.md"), "utf8")).toBe(postFile);
});

test("a path the editor does not use is the site's own, from its Eleventy dev server", async () => {
  const res = await fetch(`${base}/blog/2026/lorem-ipsum/?x=1`, withCookie());

  expect(res.status).toBe(200);
  expect(res.headers.get("x-site")).toBe("yes");
  expect(await res.text()).toBe("site page GET /blog/2026/lorem-ipsum/?x=1");
});

test("the site's live reload reaches the tab as its dev server sends it, not when the stream ends", async () => {
  const { first, reader } = await reloadStream();
  expect(first).toBe("data: reload\n\n");
  await reader.cancel();
});

test("the preview of a Post opens its page wherever the site put it, and only for a Post in the Post Catalog", async () => {
  const res = await fetch(`${base}/preview/lorem-ipsum`, { ...withCookie(), redirect: "manual" });

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/blog/2026/lorem-ipsum/");
  expect((await fetch(`${base}/preview/other-post`, { ...withCookie(), redirect: "manual" })).status).toBe(404);
});

test("closing the Server ends the site's live reload streams it proxies", async () => {
  const { reader } = await reloadStream();
  const ended = reader.read().catch(() => {});

  const started = Date.now();
  await close!();
  close = undefined;
  await ended;
  expect(Date.now() - started).toBeLessThan(1000);
}, 10_000);
