import { readFile, writeFile } from "node:fs/promises";
import type { Post } from "./post-catalog.ts";

// Front matter stays on the Server untouched until the Front Matter Block exists (#9).
const frontMatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

function split(text: string) {
  const fm = text.match(frontMatter)?.[0] ?? "";
  return { fm, body: text.slice(fm.length) };
}

export async function readPostBody(post: Post) {
  return split(await readFile(post.file, "utf8")).body.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export async function writePostBody(post: Post, body: string) {
  const { fm } = split(await readFile(post.file, "utf8"));
  await writeFile(post.file, fm ? `${fm}\n${body}` : body);
}
