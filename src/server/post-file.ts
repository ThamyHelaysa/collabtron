import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Post } from "./post-catalog.ts";

// The whole file: the editor shows the front matter as its Front Matter Block.
export async function readPost(post: Post) {
  return readFile(post.file, "utf8");
}

// Replaces the Post file in one step, so it is never left half written, and only while `unchanged` says it still holds
// what the Server last wrote (ADR 0006, docs/research/atomic-post-save.md).
// true: the file holds `text`. false: it changed outside the editor and holds that change.
// Throws with the file as it was; if an outside save made meanwhile could not be put back, it is kept beside the Post.
export async function writePost(post: Post, text: string, unchanged: (onDisk: string) => boolean) {
  // The file a symlink points to, so the link stays; the new file goes beside it, as rename works within a folder.
  const file = await realpath(post.file);
  // A rename would replace even a file its owner made read-only.
  await access(file, constants.W_OK);
  const folder = dirname(file);
  // chokidar, which Eleventy watches with, ignores names ending in `~`.
  const tempName = (role: string) => join(folder, `.${basename(file)}.${role}.${randomUUID()}~`);
  const next = tempName("next");
  // A second name for the file being replaced: an editor saving in place after the check writes into it.
  const replaced = tempName("replaced");
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
    await link(file, replaced);
    // shortcut: an editor that saves by rename (Vim, git checkout) between this check and our rename is overwritten;
    // no OS call Node offers can close it, exchange-then-verify could once Node exposes RENAME_EXCHANGE/RENAME_SWAP.
    if (!unchanged(await readFile(file, "utf8"))) {
      await unlink(replaced);
      return false;
    }
    await rename(next, file);
  } catch (err) {
    // Not replaced yet: `replaced` is only a second name for the Post.
    await unlink(replaced).catch(() => {});
    throw err;
  } finally {
    await unlink(next).catch(() => {});
  }

  // The Post holds `text` now. Unless the file it replaced is known to be the Server's last write, it is put back;
  // if that fails, `replaced` stays where it is, so an outside save is never deleted.
  let saved: boolean;
  try {
    saved = unchanged(await readFile(replaced, "utf8"));
  } catch (err) {
    await rename(replaced, file);
    throw err;
  }
  if (saved) await unlink(replaced).catch(() => {});
  else await rename(replaced, file);
  // Makes the rename survive a power loss. Failing that, the save still happened: reporting it as failed
  // would leave the Server unaware of its own write and refuse every later save.
  await syncFolder(folder).catch((err) => console.warn(`${folder} not synced to disk after saving ${post.id}:`, err));
  return saved;
}

async function syncFolder(folder: string) {
  const handle = await open(folder, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
