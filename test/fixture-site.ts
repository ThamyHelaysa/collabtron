import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPostCatalog } from "../src/server/post-catalog.ts";

// A small Eleventy site: its own layout, a Post URL only Eleventy knows (front matter can move it), and drafts left out of a build.
export async function makeSite(posts: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "collabtron-site-"));
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
  await mkdir(join(dir, "_includes"));
  await writeFile(join(dir, "_includes", "post.njk"), "<!doctype html>\n<html><head><title>{{ title }}</title></head><body><main class=\"site-layout\">{{ content | safe }}</main></body></html>\n");
  const postsDir = join(dir, "src", "posts");
  await mkdir(postsDir, { recursive: true });
  await writeFile(
    join(postsDir, "posts.11tydata.js"),
    'export default { layout: "post.njk", eleventyComputed: { permalink: (data) => (data.draft && process.env.ELEVENTY_RUN_MODE === "build" ? false : `/blog/${data.section ? `${data.section}/` : ""}${data.page.fileSlug}/`) } };\n',
  );
  for (const [id, text] of Object.entries(posts)) {
    await mkdir(join(postsDir, id));
    await writeFile(join(postsDir, id, "index.md"), text);
  }
  return { dir, postsDir, catalog: await createPostCatalog(postsDir, Object.keys(posts)) };
}
