// Seam 3: the editor in a real browser, two tabs on one Post, against the real Server. Needs Google Chrome installed.
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { createPostCatalog, type PostCatalog } from "../src/server/post-catalog.ts";
import { startServer } from "../src/server/server.ts";

let browser: Browser;
let postsDir: string;
let catalog: PostCatalog;
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  // The bundle the Server serves, as `pnpm build:client` makes it.
  await build({ entryPoints: ["src/client/main.ts"], bundle: true, format: "esm", outdir: "dist/client", logLevel: "warning" });
  postsDir = await mkdtemp(join(tmpdir(), "collabtron-"));
  await mkdir(join(postsDir, "lorem-ipsum"));
  await writeFile(join(postsDir, "lorem-ipsum", "index.md"), "---\ntitle: Lorem\n---\n\nIpsum\n");
  catalog = await createPostCatalog(postsDir, ["lorem-ipsum"]);
  server = await startServer({ host: "127.0.0.1", port: 0, catalog });
  browser = await chromium.launch({ channel: "chrome" });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await rm(postsDir, { recursive: true, force: true });
});

const paragraph = (page: Page) => page.locator("#editor .ProseMirror > p").last();
// Its text, without the others' carets and their name labels.
const text = (page: Page) =>
  paragraph(page).evaluate((p) => {
    const copy = p.cloneNode(true) as HTMLElement;
    for (const caret of copy.querySelectorAll(".presence")) caret.remove();
    return copy.textContent;
  });
const shows = (page: Page, expected: string) => expect.poll(() => text(page), { timeout: 5000 }).toBe(expected);

async function typeAtEnd(page: Page, text: string) {
  await paragraph(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

test("typing in one tab appears in the other, and what a tab typed while the Server was down is offered back after a restart", async () => {
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/p/lorem-ipsum`;
  const context = await browser.newContext();
  const [a, b] = [await context.newPage(), await context.newPage()];
  for (const page of [a, b]) await page.goto(url);

  await typeAtEnd(a, " dolor");
  await shows(b, "Ipsum dolor");

  await server.close();
  await typeAtEnd(a, " amet");
  // Leaves the page: only the tab's storage still has " amet".
  await a.goto("about:blank");
  server = await startServer({ host: "127.0.0.1", port, catalog });
  await a.goto(url);

  await expect.poll(() => a.locator("#recovery").isVisible()).toBe(true);
  expect(await a.locator("#recovery .recovered").textContent()).toContain("Ipsum dolor amet");
  await shows(a, "Ipsum dolor");
  // b reconnects on its own, and lost nothing.
  await expect.poll(() => b.locator("#status").textContent(), { timeout: 5000 }).toBe("Connected");
  await typeAtEnd(b, "!");
  await shows(a, "Ipsum dolor!");
  expect(await b.locator("#recovery").isVisible()).toBe(false);
}, 30_000);
