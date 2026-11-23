# The Server saves, never over a change made outside the editor

The Post file follows the Authority's document (issue #11). The Server saves `saveAfterMs` (1 s) after the last accepted Step, and at most `saveEveryMs` (10 s) after the first Step not yet saved, so continuous typing still reaches the disk. It also saves what is pending when the last Collaborator leaves, before the Editing Session ends, and when it stops (`close()`, Ctrl-C, `node --watch` restarts).

The Post file is the site owner's: they edit it in their own editor, `git checkout` it, and so on. So the Server remembers the SHA-256 of what it last wrote (at first, of what it read when the Editing Session began) and reads the file before every save. If the hash differs, it does not write: it warns in the terminal when saving stops, and sends `{ type: "save", error }` to every Collaborator after each refused save, and to each one who joins while saving is stopped. A save that fails for another reason (the file cannot be read or written) reports an error the same way and is tried again at the next accepted Step or when the Editing Session ends. A save that worked sends `{ type: "save" }`. The code is `createPostSaver` in `src/server/post-saver.ts`.

A save never leaves the Post half written (`writePost` in `src/server/post-file.ts`, researched in [atomic-post-save](../research/atomic-post-save.md)). It writes the new text to a file beside the Post and fsyncs it. Then it checks the hash and renames the new file over the Post, and fsyncs the folder. A crash, a power loss or a full disk leaves the old Post or the new one, never a mix. The hash check comes right before the rename, so the window for an outside write is one read, one hash and one rename. A hard link keeps the replaced file. An editor that saved in place inside that window (VS Code does) wrote into it, so its text is put back and the save counts as refused. When the Server cannot read the replaced file, it puts it back too. If putting it back fails, the replaced file stays beside the Post, so an outside save is never deleted.

Once the rename is done, the save counts as done. If the folder cannot be synced afterwards, the Server only warns in the terminal. Treating that save as failed would leave the Server unaware of its own write, and it would refuse every later save.

## Considered Options

- **Saving from the tab with `PUT`, as before**: rejected, and the route and the Save button are gone. A tab's document can be behind the Authority's, and its write would bypass the hash check. `Mod-s` does nothing now, so the browser's Save dialog stays away.
- **Comparing modification times instead of a hash**: rejected. Touching the file, or an editor saving it unchanged, would stop saving for nothing.
- **Saving on every accepted Step**: rejected. Every save makes the site rebuild the Post.

## Consequences

- After a refusal, saving stays stopped for the rest of the Editing Session, unless the file goes back to exactly what the Server last wrote. The edits made since are only in the Collaborators' tabs. The next Editing Session reads the file again, and a tab that comes back to it is offered them ([ADR 0008](0008-reconnect-catches-up-or-offers-the-text-back.md)).
- An editor that saves by rename (Vim's default, `git checkout`) between the check and the rename is still overwritten. No call Node offers closes that window. Other editors take no lock that could be shared, and no OS can rename only if the target is still the file that was checked. Once Node exposes `RENAME_EXCHANGE` (Linux) or `RENAME_SWAP` (macOS), the Server can exchange the files, verify the one it displaced, and swap back.
- Each save makes a new file: hard links to the Post stop following it, and extended attributes (macOS Finder tags) are dropped. Its permissions are copied over, and a symlink to the Post is kept, because the file it points to is the one replaced. The owner is the Server's user, the same user in dev.
- The files written beside the Post are named `.index.md.<role>.<uuid>~`: Eleventy's watcher (chokidar) ignores names ending in `~`. After a hard crash one can be left behind; `git status` shows it. A `.replaced.` one can hold an outside save that landed during the crashed save, so read it before deleting it.
- A Post file its owner made read-only is never saved over: every save fails until it is writable again, then the pending edits are saved.
- On a filesystem without hard links (exFAT, some network mounts) every save fails, and the error is shown to the Collaborators.
- A folder the Server cannot create files in makes every save fail, even when the Post file itself is writable.
- An Editing Session whose last Collaborator left stays loaded until its pending save is done. Whoever joins meanwhile keeps it going instead of reading the file.
- The first save of a Post can change bytes the site renders the same (see Round-trip in the glossary).
