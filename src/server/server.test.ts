import { afterEach, beforeEach, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostCatalog } from "./post-catalog.ts";
import { startServer } from "./server.ts";

const postFile = "---\ntitle: Lorem\n---\n\n# Ipsum\n\nDolor sit amet.\n";

let postsDir: string;
let base: string;
let close: (() => Promise<void>) | undefined;

beforeEach(async () => {
  postsDir = await mkdtemp(join(tmpdir(), "collabtron-"));
  await mkdir(join(postsDir, "lorem-ipsum"));
  await writeFile(join(postsDir, "lorem-ipsum", "index.md"), postFile);
  await mkdir(join(postsDir, "other-post"));
  await writeFile(join(postsDir, "other-post", "index.md"), "other\n");

  const catalog = await createPostCatalog(postsDir, ["lorem-ipsum"]);
  const server = await startServer({ host: "127.0.0.1", port: 0, catalog });
  close = server.close;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await close?.();
  close = undefined;
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
    expect((await fetch(`${base}/api/posts/${id}`, { method: "PUT", body: "x" })).status).toBe(404);
  }
  expect(await readFile(join(postsDir, "other-post", "index.md"), "utf8")).toBe("other\n");
});

test("loads the whole Post file, front matter included", async () => {
  const res = await fetch(`${base}/api/posts/lorem-ipsum`);

  expect(res.status).toBe(200);
  expect(await res.text()).toBe(postFile);
});

test("saving writes the Markdown, front matter included, to the Post file", async () => {
  const saved = "---\ntitle: Ipsum\n---\n\n# Ipsum\n\nNew text.\n";
  const res = await fetch(`${base}/api/posts/lorem-ipsum`, { method: "PUT", body: saved });

  expect(res.status).toBe(204);
  expect(await readFile(join(postsDir, "lorem-ipsum", "index.md"), "utf8")).toBe(saved);
});

test("saving keeps multi-byte characters intact in a large Post", async () => {
  const body = "Lorem ipsum – çãé 🙂\n\n".repeat(20_000);
  await fetch(`${base}/api/posts/lorem-ipsum`, { method: "PUT", body });

  expect(await readFile(join(postsDir, "lorem-ipsum", "index.md"), "utf8")).toBe(body);
});
