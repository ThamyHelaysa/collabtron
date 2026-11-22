import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("an outside write that cannot be put back is kept beside the Post", async () => {
  let calls = 0;
  const unchanged = (onDisk: string) => {
    calls++;
    if (calls === 1) writeFileSync(post.file, "Saved by another editor\n");
    // Something takes the Post's path before the outside write can be put back there.
    if (calls === 2) {
      rmSync(post.file);
      mkdirSync(post.file);
      writeFileSync(join(post.file, "blocking"), "");
    }
    return onDisk === "Last written by the Server\n";
  };

  await expect(writePost(post, "From the editor\n", unchanged)).rejects.toThrow();

  const kept = (await readdir(folder)).filter((name) => name !== "index.md");
  expect(kept).toHaveLength(1);
  expect(await readFile(join(folder, kept[0]), "utf8")).toBe("Saved by another editor\n");
});
