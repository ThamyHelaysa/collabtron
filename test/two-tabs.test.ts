// Seam 3: the editor in a real browser, against the real Server and a real Eleventy site. Needs Google Chrome installed.
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { startEleventy } from "../src/server/eleventy.ts";
import type { PostCatalog } from "../src/server/post-catalog.ts";
import { startServer } from "../src/server/server.ts";
import { makeSite } from "./fixture-site.ts";

let browser: Browser;
let siteDir: string;
let catalog: PostCatalog;
let eleventy: Awaited<ReturnType<typeof startEleventy>>;
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  // The bundle the Server serves, as `pnpm build:client` makes it.
  await build({ entryPoints: ["src/client/main.ts"], bundle: true, format: "esm", outdir: "dist/client", logLevel: "warning" });
  const site = await makeSite({
    "lorem-ipsum": "---\ntitle: Lorem\n---\n\nIpsum\n",
    "lorem-draft": "---\ntitle: Draft\ndraft: true\n---\n\nIpsum\n",
    "lorem-moving": "---\nsection: one\n---\n\nIpsum\n",
  });
  ({ dir: siteDir, catalog } = site);
  eleventy = await startEleventy(siteDir);
  server = await startServer({ host: "127.0.0.1", port: 0, catalog, eleventy });
  browser = await chromium.launch({ channel: "chrome" });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await eleventy?.close();
  await rm(siteDir, { recursive: true, force: true });
});

// The Share Link the Server printed, for one Post.
const shareLink = (postId: string, { address, token }: { address(): unknown; token: string } = server) => `http://127.0.0.1:${(address() as AddressInfo).port}/p/${postId}#token=${token}`;

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

test("typing in one tab appears in the other; after a Server restart each tab needs its new Share Link, and what a tab typed while the Server was down is offered back", async () => {
  const { port } = server.address() as AddressInfo;
  const context = await browser.newContext();
  const [a, b] = [await context.newPage(), await context.newPage()];
  for (const page of [a, b]) await page.goto(shareLink("lorem-ipsum"));

  await typeAtEnd(a, " dolor");
  await shows(b, "Ipsum dolor");

  await server.close();
  await typeAtEnd(a, " amet");
  // Leaves the page: only the tab's storage still has " amet".
  await a.goto("about:blank");
  server = await startServer({ host: "127.0.0.1", port, catalog, eleventy });
  // b tries again on its own, with the token of the Server that stopped.
  await expect.poll(() => b.locator("#status").textContent(), { timeout: 5000 }).toContain("open its new Share Link in this tab");
  await a.goto(shareLink("lorem-ipsum"));

  await expect.poll(() => a.locator("#recovery").isVisible()).toBe(true);
  expect(await a.locator("#recovery .recovered").textContent()).toContain("Ipsum dolor amet");
  await shows(a, "Ipsum dolor");
  // The new link in the same tab changes only the fragment; b lost nothing.
  await b.goto(shareLink("lorem-ipsum"));
  await expect.poll(() => b.locator("#status").textContent(), { timeout: 5000 }).toBe("Connected");
  await typeAtEnd(b, "!");
  await shows(a, "Ipsum dolor!");
  expect(await b.locator("#recovery").isVisible()).toBe(false);
}, 30_000);

test("a link with another token opens neither the Post nor its preview", async () => {
  const page = await browser.newPage();
  await page.goto(shareLink("lorem-ipsum").replace(/#token=.*/, "#token=wrong"));

  await expect.poll(() => page.locator("#status").textContent(), { timeout: 5000 }).toContain("does not open the Post");
  expect(await page.locator("#editor").innerHTML()).toBe("");
  expect(await page.locator("#preview").getAttribute("src")).toBeNull();
  await page.close();
});

test("the preview shows a draft Post with the site layout, and the site's live reload refreshes it after each save", async () => {
  const page = await browser.newPage();
  await page.goto(shareLink("lorem-draft"));
  const preview = page.frameLocator("#preview").locator(".site-layout p");

  await expect.poll(() => preview.textContent(), { timeout: 10_000 }).toBe("Ipsum");
  await typeAtEnd(page, " dolor");
  await expect.poll(() => preview.textContent(), { timeout: 10_000 }).toBe("Ipsum dolor");
  await page.close();
}, 30_000);

test("the preview follows the Post when an edit moves its page", async () => {
  const page = await browser.newPage();
  await page.goto(shareLink("lorem-moving"));
  const preview = page.locator("#preview");
  await expect.poll(() => preview.evaluate((frame: HTMLIFrameElement) => frame.contentWindow?.location.pathname), { timeout: 10_000 }).toBe("/blog/one/lorem-moving/");

  await page.locator("#editor .front-matter").click();
  await page.keyboard.press("End");
  await page.keyboard.type("s");
  await expect.poll(() => preview.evaluate((frame: HTMLIFrameElement) => frame.contentWindow?.location.pathname), { timeout: 10_000 }).toBe("/blog/ones/lorem-moving/");
  await expect.poll(() => page.frameLocator("#preview").locator(".site-layout p").textContent(), { timeout: 5000 }).toBe("Ipsum");
  await page.close();
}, 30_000);

test("the editor opens even when the site's first build fails, and the preview comes once a fix lets the site build", async () => {
  const site = await makeSite({ "lorem-broken": "---\ntitle: Broken\nlayout: missing.njk\n---\n\nIpsum\n" });
  const brokenEleventy = await startEleventy(site.dir);
  const brokenServer = await startServer({ host: "127.0.0.1", port: 0, catalog: site.catalog, eleventy: brokenEleventy });
  try {
    const page = await browser.newPage();
    await page.goto(shareLink("lorem-broken", brokenServer));
    await expect.poll(() => paragraph(page).textContent(), { timeout: 5000 }).toBe("Ipsum");
    await expect.poll(() => page.frameLocator("#preview").locator("body").textContent(), { timeout: 10_000 }).toContain("no page for this Post yet");

    await writeFile(join(site.postsDir, "lorem-broken", "index.md"), "---\ntitle: Broken\n---\n\nFixed\n");
    await expect.poll(() => page.frameLocator("#preview").locator(".site-layout p").textContent(), { timeout: 15_000 }).toBe("Fixed");
    await page.close();
  } finally {
    await brokenServer.close();
    await brokenEleventy.close();
    await rm(site.dir, { recursive: true, force: true });
  }
}, 30_000);
