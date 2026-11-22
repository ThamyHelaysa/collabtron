import { afterEach, beforeEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Post } from "./post-catalog.ts";
import { writePost } from "./post-file.ts";

let folder: string;
let post: Post;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "collabtron-"));
  post = { id: "lorem-ipsum", file: join(folder, "index.md") };
  await writeFile(post.file, "Last written by the Server\n");
});

afterEach(() => rm(folder, { recursive: true, force: true }));

test("an outside write that lands in place after the check is put back, and nothing is saved", async () => {
  let checked = false;
  const unchanged = (onDisk: string) => {
    // Like an editor saving in place right after the Server read the file, before it replaces it.
    if (!checked) writeFileSync(post.file, "Saved by another editor\n");
    checked = true;
    return onDisk === "Last written by the Server\n";
  };

  expect(await writePost(post, "From the editor\n", unchanged)).toBe(false);

  expect(await readFile(post.file, "utf8")).toBe("Saved by another editor\n");
  expect(await readdir(folder)).toEqual(["index.md"]);
});
