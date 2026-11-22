import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import matter from "@11ty/gray-matter";
import { parse, serialize } from "../src/shared/markdown.ts";
import { normalizeHtml } from "../test/normalize-html.ts";
import { readPost, writePost } from "../src/server/post-file.ts";
import { createPostCatalog } from "../src/server/post-catalog.ts";

type Page = { inputPath: string; outputPath: string; content: string };

function inside(root: string, path: string) {
  const part = relative(root, path);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("Configured directory is outside its parent");
  return part;
}

async function check() {
  if (!process.env.SITE_DIR || !process.env.POSTS_DIR) throw new Error("Set SITE_DIR and POSTS_DIR in .env");
  const site = await realpath(resolve(process.env.SITE_DIR));
  const posts = await realpath(resolve(process.env.POSTS_DIR));
  const repo = execFileSync("git", ["-C", site, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const sitePart = inside(repo, site);
  const postsPart = inside(site, posts);
  if (!postsPart) throw new Error("POSTS_DIR must be a directory inside SITE_DIR");
  const temp = await realpath(await mkdtemp(join(tmpdir(), "collabtron-roundtrip-")));
  const worktree = join(temp, "worktree");
  let added = false;
  try {
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", worktree, "HEAD"], { stdio: "pipe" });
    added = true;
    const workSite = join(worktree, sitePart);
    const workPosts = join(workSite, postsPart);
    inside(worktree, await realpath(workSite));
    inside(worktree, await realpath(workPosts));
    await symlink(join(site, "node_modules"), join(workSite, "node_modules"), "dir");
    const fixtureDir = new URL("../test/fixtures/roundtrip/", import.meta.url);
    for (const name of (await readdir(fixtureDir)).filter(name => name.endsWith(".md"))) {
      const folder = join(workPosts, `collabtron-fixture-${name.slice(0, -3)}`);
      await mkdir(folder); // Never overwrite a real Post with a fixture.
      const fixture = matter(await readFile(new URL(name, fixtureDir), "utf8"));
      // Fixtures get pages, but must not alter the site's collections or pagination.
      await writeFile(join(folder, "index.md"), matter.stringify(fixture.content, {
        title: `Fixture ${name.slice(0, -3)}`, date: "2000-01-01", ...fixture.data, eleventyExcludeFromCollections: true,
      }));
    }
    const published = new Set<string>();
    for (const entry of await readdir(workPosts, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(workPosts, entry.name, "index.md");
      await realpath(file).then(path => inside(workPosts, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (text !== undefined && matter(text).data.draft !== true) published.add(file);
    }
    const ids = [...published].map(file => relative(workPosts, dirname(file)));
    const catalog = await createPostCatalog(workPosts, ids);

    // The site's build owns URLs and layouts; collect its result manifest through Eleventy's public hook.
    const config = join(temp, "eleventy.config.mjs");
    const manifest = join(temp, "pages.json");
    await writeFile(config, `
      import configure from ${JSON.stringify(pathToFileURL(join(workSite, "eleventy.config.ts")).href)};
      import { writeFile } from "node:fs/promises";
      export default async function(config) {
        const result = await configure(config);
        config.on("eleventy.after", ({ results }) => writeFile(${JSON.stringify(manifest)},
          JSON.stringify(results.map(({inputPath, outputPath, content}) => ({inputPath, outputPath, content})))));
        return result;
      }
    `);
    const require = createRequire(join(workSite, "package.json"));
    async function build() {
      execFileSync(process.execPath, [require.resolve("tsx/cli"), join(workSite, "node_modules/@11ty/eleventy/cmd.cjs"), `--config=${config}`, "--quiet"], {
        cwd: workSite, stdio: "inherit",
      });
      const results: Page[] = JSON.parse(await readFile(manifest, "utf8"));
      const pages = new Map<string, string>();
      for (const page of results) {
        if (published.has(resolve(workSite, page.inputPath)) && typeof page.outputPath === "string" && page.outputPath.endsWith(".html")) {
          pages.set(relative(workSite, resolve(workSite, page.outputPath)), normalizeHtml(page.content));
        }
      }
      const missing = [...published].filter(file => !results.some(page => resolve(workSite, page.inputPath) === file &&
        typeof page.outputPath === "string" && page.outputPath.endsWith(".html")));
      for (const file of missing) console.error(`No Post page built for ${relative(workSite, file)}`);
      return { pages, missing };
    }

    console.log("Build A");
    const before = await build();
    let failures = 0;
    for (const id of ids) {
      const post = catalog.get(id)!;
      try {
        const markdown = await readPost(post);
        if (!(await writePost(post, serialize(parse(markdown)), (onDisk) => onDisk === markdown))) throw new Error("changed while saving");
      } catch {
        console.error(`Round-trip failed: ${post.id}`);
        failures++;
      }
    }
    console.log("Build B");
    const after = await build();
    let differences = 0;
    for (const path of new Set([...before.pages.keys(), ...after.pages.keys()])) {
      if (before.pages.get(path) !== after.pages.get(path)) {
        console.error(`HTML differs: ${path}`);
        differences++;
      }
    }
    if (failures || differences || before.missing.length || after.missing.length) {
      console.error(`${before.pages.size} Post pages compared; ${differences} HTML differences; ${failures} Round-trip failures`);
      process.exitCode = 1;
    } else console.log(`${before.pages.size} Post pages match (published Posts + synthetic fixtures)`);
  } finally {
    try {
      if (added) execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { stdio: "pipe" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

await check().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
