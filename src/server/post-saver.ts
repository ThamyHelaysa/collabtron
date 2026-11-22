import { createHash } from "node:crypto";
import type { Post } from "./post-catalog.ts";
import { readPost, writePost } from "./post-file.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const changedOutside = "The Post file changed outside the editor. Saving is stopped so that change is not overwritten: edits made here are not saved.";

// Keeps a Post file following an Editing Session's document, never over a change made outside the editor (ADR 0006).
// `onDisk` is the file as the Editing Session loaded it; `report` gets every save's outcome, an error to show Collaborators or none.
export function createPostSaver({
  post,
  onDisk,
  markdown,
  report,
  afterMs,
  everyMs,
}: {
  post: Post;
  onDisk: string;
  markdown: () => string;
  report: (error?: string) => void;
  afterMs: number;
  everyMs: number;
}) {
  let writtenHash = hash(onDisk);
  let error: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let unsavedSince: number | undefined;
  // One save at a time: a save that read the file while another was writing it would see a change made outside.
  let saving = Promise.resolve();

  async function save() {
    clearTimeout(timer);
    if (unsavedSince === undefined) return;
    unsavedSince = undefined;
    try {
      const text = markdown();
      // shortcut: a write landing between this check and ours is lost, upgrade to a file lock if that window ever matters.
      if (hash(await readPost(post)) !== writtenHash) {
        if (error !== changedOutside) console.warn(`${post.file} changed outside the editor: not saving Post ${post.id} over it`);
        error = changedOutside;
      } else {
        await writePost(post, text);
        writtenHash = hash(text);
        error = undefined;
      }
    } catch (err) {
      console.error(err);
      // Tried again at the next accepted Step, or when the Editing Session ends.
      unsavedSince ??= Date.now();
      error = "The Server could not save the Post file.";
    }
    report(error);
  }

  // Never rejects.
  const flush = () => (saving = saving.then(save));

  return {
    // The last save's error, while saving is failing.
    get error() {
      return error;
    },
    // Saves `afterMs` after the last accepted Step, and at most `everyMs` after the first unsaved one.
    stepsAccepted() {
      unsavedSince ??= Date.now();
      clearTimeout(timer);
      timer = setTimeout(flush, Math.min(afterMs, unsavedSince + everyMs - Date.now()));
    },
    flush,
  };
}

export type PostSaver = ReturnType<typeof createPostSaver>;
