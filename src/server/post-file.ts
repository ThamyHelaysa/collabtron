import { randomUUID } from "node:crypto";
import { link, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Post } from "./post-catalog.ts";

// The whole file: the editor shows the front matter as its Front Matter Block.
export async function readPost(post: Post) {
  return readFile(post.file, "utf8");
}

// Replaces the Post file in one step, so it is never left half written, and only while `unchanged`
// says it still holds what the Server last wrote; false when it was changed outside the editor
// (ADR 0006, docs/research/atomic-post-save.md).
export async function writePost(post: Post, text: string, unchanged: (onDisk: string) => boolean) {
  // The file a symlink points to, so the link stays; the new file goes beside it, as rename works within a folder.
  const file = await realpath(post.file);
  const folder = dirname(file);
  // chokidar, which Eleventy watches with, ignores names ending in `~`.
  const beside = (role: string) => join(folder, `.${basename(file)}.${role}.${randomUUID()}~`);
  const next = beside("next");
  const replaced = beside("replaced");
  let saved = false;
  try {
    const handle = await open(next, "wx");
    try {
      await handle.chmod((await stat(file)).mode & 0o7777);
      await handle.writeFile(text);
      // On power loss the rename could otherwise land before the text does.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Keeps the file being replaced: an editor saving in place after the check writes into it.
    await link(file, replaced);
    // shortcut: an editor that saves by rename (Vim, git checkout) between this check and ours is overwritten;
    // no OS call Node offers can close it, exchange-then-verify could once Node exposes RENAME_EXCHANGE/RENAME_SWAP.
    if (!unchanged(await readFile(file, "utf8"))) return false;
    await rename(next, file);
    if (unchanged(await readFile(replaced, "utf8"))) saved = true;
    else await rename(replaced, file);
  } finally {
    await unlink(next).catch(() => {});
    await unlink(replaced).catch(() => {});
  }
  // Makes the rename itself survive a power loss.
  const handle = await open(folder, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return saved;
}
