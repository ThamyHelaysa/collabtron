# The Server saves, never over a change made outside the editor

The Post file follows the Authority's document (issue #11). The Server saves `saveAfterMs` (1 s) after the last accepted Step, and at most `saveEveryMs` (10 s) after the first Step not yet saved, so continuous typing still reaches the disk. It also saves what is pending when the last Collaborator leaves, before the Editing Session ends, and when it stops (`close()`, Ctrl-C, `node --watch` restarts).

The Post file is the site owner's: they edit it in their own editor, `git checkout` it, and so on. So the Server remembers the SHA-256 of what it last wrote (at first, of what it read when the Editing Session began) and reads the file before every save. If the hash differs, it does not write: it warns in the terminal when saving stops, and sends `{ type: "save", error }` to every Collaborator after each refused save, and to each one who joins while saving is stopped. A save that fails for another reason (the file cannot be read or written) reports an error the same way and is tried again at the next accepted Step or when the Editing Session ends. A save that worked sends `{ type: "save" }`. The code is `createPostSaver` in `src/server/post-saver.ts`.

## Considered Options

- **Saving from the tab with `PUT`, as before**: rejected, and the route and the Save button are gone. A tab's document can be behind the Authority's, and its write would bypass the hash check. `Mod-s` does nothing now, so the browser's Save dialog stays away.
- **Comparing modification times instead of a hash**: rejected. Touching the file, or an editor saving it unchanged, would stop saving for nothing.
- **Saving on every accepted Step**: rejected. Every save makes the site rebuild the Post.

## Consequences

- After a refusal, saving stays stopped for the rest of the Editing Session, unless the file goes back to exactly what the Server last wrote. The edits made since are only in the Collaborators' tabs, and they are lost when the Editing Session ends. The next Editing Session reads the file again. Offering to recover them is the browser-storage work (issue #13).
- The check and the write are two steps: a write from outside that lands between them is overwritten. Closing that window needs a file lock.
- An Editing Session whose last Collaborator left stays loaded until its pending save is done. Whoever joins meanwhile keeps it going instead of reading the file.
- The first save of a Post can change bytes the site renders the same (see Round-trip in the glossary).
