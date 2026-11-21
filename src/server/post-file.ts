import { readFile, writeFile } from "node:fs/promises";
import type { Post } from "./post-catalog.ts";

// The whole file: the editor shows the front matter as its Front Matter Block.
export async function readPost(post: Post) {
  return readFile(post.file, "utf8");
}

export async function writePost(post: Post, text: string) {
  await writeFile(post.file, text);
}
