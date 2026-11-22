# Atomic Post save

Research for the Server's save path (`src/server/post-saver.ts`, `src/server/post-file.ts`, [ADR 0006](../adr/0006-server-saves-never-over-outside-changes.md)). Read in November 2026. Source links are permalinks to the commits listed under [Sources](#sources).

## Question

`writePost` calls `fs.promises.writeFile`, which opens the Post with `O_TRUNC` and then writes in place. If the process dies, the power goes or the disk fills during that write, the Post is left empty or truncated (item 1). The hash check and the write are two steps, so a write from outside that lands between them is overwritten (item 2). Is write-temp-then-rename the only fix for item 1? What do editors and tools do? Can item 2 be closed?

## Short answer

- For readers that don't cooperate (Eleventy, Vim, git), `rename(2)` is the only POSIX primitive that swaps a whole file in one step. So temp+rename, or a flag variant of it (`renameat2`, `renamex_np`), is the only way to make a save atomic for them. The alternatives add durability (fsync, `F_FULLFSYNC`), make a failed save recoverable without making it atomic (backup copy, then write in place), or are atomic only for readers that read the journal (SQLite).
- Tools split three ways. Temp+rename: Emacs `file-precious-flag` (opt-in), Sublime Text 3 `atomic_save` (opt-in), write-file-atomic, Git lockfiles, VS Code for its own state files, JetBrains for large files. Backup, then write: Vim (`writebackup` with `backupcopy=auto`), Emacs by default, JetBrains "safe write" (copy, then write in place). Plain write in place: VS Code text saves (`O_TRUNC`, then `fdatasync`).
- Item 1 is fully closed by four steps: write a temp file in the same folder, fsync it, rename it over the Post, then fsync the folder. Node 24 `fs` has all four, and on macOS Node's fsync already issues `F_FULLFSYNC`.
- Item 2 cannot be closed. Every tool checks (mtime, size, etag or hash) and then writes. Locks only bind writers that take them, and no OS has "rename only if the target is still inode X". The window can be narrowed: prepare the temp file first, and check right before the rename.

## Techniques

| Technique | Never partial? | Survives power loss? | Cost, trade-offs | Node 24 `fs` |
|---|---|---|---|---|
| In-place `writeFile` (today) | No. `O_TRUNC` comes first, then the write. A Post under 512 KiB is a single write call ([promises.js][n-wf], [utils.js][n-chunk]). | No fsync. ext4's default `auto_da_alloc` forces the data of "replace-via-truncate" out at the next journal commit ([ext4.rst][ext4]). APFS: no documented equivalent (unverified). | Keeps the inode, links, owner, xattrs. | Yes (current code). |
| fsync / fdatasync of the file | Gives durability, not atomicity. | Yes for the data. Linux `fdatasync` skips metadata that a later read doesn't need ([fsync(2)][l-fsync]). | macOS `fsync` does not flush the drive cache ([Apple fsync(2)][m-fsync]). | `filehandle.sync()`/`datasync()`, or `writeFile(..., { flush: true })` ([fs.md][n-flush]). On macOS libuv tries `F_FULLFSYNC`, then `F_BARRIERFSYNC`, then `fsync`, for both calls ([fs.c][uv-fsync]). |
| fsync of the folder | Gives durability, not atomicity. | Makes the new folder entry (the rename) durable: "an explicit fsync() on a file descriptor for the directory is also needed" ([fsync(2)][l-fsync]). | One more syscall. | `open(dir, "r")` then `sync()`. It worked on APFS here (Node 24.12.0). |
| macOS `F_FULLFSYNC` | Gives durability, not atomicity. | Yes: it flushes the drive's buffered data. "The operation may take quite a while" ([fcntl(2)][m-fcntl]). | Latency on every save. | Automatic in `sync()`/`datasync()` ([fs.c][uv-fsync]). |
| Temp + `rename` | Yes. POSIX: `new` "shall remain visible ... and refer either to the file referred to by new or old" ([POSIX rename][posix-rename]). Apple: "an instance of new will always exist, even if the system should crash" ([rename(2)][m-rename]). | Only if the temp file is fsynced before the rename. Otherwise delayed allocation can commit the rename before the data: ext4 calls this the "zero-length" problem ([ext4.rst][ext4]). | New inode. Other hard links keep the old file ([rename(2)][l-rename]). A symlink at the target is replaced, not followed ([rename(2)][l-rename]). Some attributes are lost and links are not kept ([Vim 'backupcopy'][vim-bkc]). A process holding the old file open keeps seeing the old file ([Vim 'backupcopy'][vim-bkc], `crontab` note). A temp file is left behind if the process crashes. Needs write permission on the folder. | Yes: `rename`. |
| Backup copy, then write in place | No: readers can see a partial file. A backup exists to recover from. | Only with fsync on the backup and the file. Vim: "on some filesystems ... in a crash you lose both the backup and the newly written file" ([editing.txt][vim-bt]). | Keeps the inode, links, owner, ACLs, xattrs. Two writes. A recovery step after a crash. | Yes: `copyFile`, `writeFile`, `sync`. |
| APFS `clonefile` / Linux `FICLONE` (copy-on-write) | No. It only makes the backup cheap. The clone keeps the source's xattrs ([clonefile(2)][m-clone]). | n/a | ext4 has no reflinks (unverified; [FICLONE(2const)][l-ficlone] only lists the errors). | Not on macOS: Node 24.12's libuv clones only via the Linux `FICLONE` ioctl. `COPYFILE_FICLONE` silently does a byte copy, and `COPYFILE_FICLONE_FORCE` fails with `ENOSYS` ([fs.c][uv-clone]; reproduced on APFS here). |
| Linux `renameat2` `RENAME_EXCHANGE` / `RENAME_NOREPLACE` | Exchange swaps two paths atomically. NoReplace fails if the target exists ([rename(2)][l-rename]). | Like rename. | Linux only. NoReplace needs filesystem support (ext4 since Linux 3.15). | No: `fs.rename` has no flags, and libuv calls `rename()` ([fs.c][uv-rename]). |
| macOS `renamex_np` `RENAME_SWAP` / `RENAME_EXCL` | Same pair as Linux ([rename(2)][m-rename-flags]). | Like rename. | Needs volume support (`VOL_CAP_INT_RENAME_SWAP`). | No. |
| `exchangedata(2)` | Swapped data with identity kept. | n/a | Not supported on APFS, deprecated since macOS 10.13. Apple says to use `rename`/`renamex_np` instead ([exchangedata(2)][m-xchg]). | No. |
| `O_TMPFILE` + `linkat` | An unnamed temp, so nothing is left behind after a crash. `linkat` won't overwrite an existing path, so a rename is still needed ([open(2)][l-open], [link(2)][l-link]). | Like temp + rename. | Linux 3.11+ only. | No: there is no `O_TMPFILE` in [node_constants.cc][n-const], and `fs.link` is plain `link()` ([fs.c][uv-rename]). |
| `fallocate` / `posix_fallocate` | No. Only "subsequent writes ... are guaranteed not to fail because of lack of disk space" ([fallocate(2)][l-falloc]). | n/a | Covers ENOSPC only. It is no help against a crash in the middle of the write. | No API. |
| Write-ahead log / rollback journal | Yes, for readers that know the journal. SQLite writes the original pages to a journal, fsyncs, writes in place, and the commit happens when the journal is deleted. WAL appends to a separate file instead ([atomiccommit][sq-ac], [wal][sq-wal]). | Yes, with SQLite's fsyncs. | Useless for a `.md` file: Eleventy, Vim and git read the file, not a journal. | Hand-written. |

With temp + rename, the steps cover:

- **Process death:** rename alone is enough, because the kernel does the rename or doesn't ([POSIX][posix-rename]).
- **Power loss:** fsync the temp file before the rename, so the rename can't be committed before the data.
- **The rename itself surviving:** fsync the folder after the rename. Without that, a power loss can bring back the old file. You get the old Post, not a partial one (inferred from the rename guarantee above).
- **ENOSPC:** a full disk fails the temp write and leaves the Post as it was ([Emacs `file-precious-flag`][el-precious]).

## What real tools do

| Tool | Default save technique | External-change detection | Documented trade-offs |
|---|---|---|---|
| VS Code, text files | In place: `O_WRONLY\|O_CREAT\|O_TRUNC`, write, `fdatasync` on close ([diskFileSystemProvider.ts][vsc-trunc], [close][vsc-sync]). The text save passes no `atomic` option ([textFileEditorModel.ts][vsc-save]). There is no atomic-save setting in [files.contribution.ts][vsc-setting]. | On save: mtime newer, then etag = mtime+size ([files.ts][vsc-etag]), then a content compare if the size is equal ([fileService.ts][vsc-check]). `files.saveConflictResolution`: `askUser` (default) or `overwriteFileOnDisk` ([files.contribution.ts][vsc-setting]). | The code says an mtime-only check gave false positives, and that the size check can miss a change of the same length ([fileService.ts][vsc-check]). |
| VS Code, its own state | Temp `<name>.vsctmp`, then rename ([provider][vsc-atomic], [fileUserDataProvider.ts][vsc-ud], [stateService.ts][vsc-state]). | n/a | Refuses atomic writes on a symlink, because the rename might cross disks ([provider][vsc-atomic]). |
| Vim | `writebackup` on ([options.txt][vim-wb]). `backupcopy`: Vim default `auto`, Vi default on Unix `yes` ([options.txt][vim-bkc]). `auto` renames the original to the backup and writes a new file, unless the file is a hard or symbolic link or the owner can't be kept ([bufwrite.c][vim-auto]); otherwise it copies, then writes in place. `fsync` on ([options.txt][vim-fsync]). | mtime at write: "WARNING: The file has been changed since reading it!!!" ([bufwrite.c][vim-mtime]). Also notices timestamp, mode and size changes ([editing.txt][vim-ts]). | `yes`: slower, but keeps links, attributes and resource forks. `no`: fast, can lose attributes, the new file is not a link. Watchers holding the fd see the backup ([options.txt][vim-bkc]). webpack tells Vim users to `set backupcopy=yes` ([development.mdx][webpack]). |
| Emacs | The first save in a session renames the original to `file~` and writes a new file. It copies instead if the file is linked (`backup-by-copying-when-linked`) or the owner would change (`backup-by-copying-when-mismatch`, default t) ([files.texi][el-copy], [backup once][el-once]). Later saves in that session write straight into the file ([files.el][el-direct]). Optional `file-precious-flag`: temp `file.tmp`, then rename ([files.el][el-precious-src]). No fsync by default (`write-region-inhibit-fsync` is t, [files.texi][el-fsync]). | `verify-visited-file-modtime` ([buffers.texi][el-modtime]). A lock symlink `.#file` while the buffer is modified (`create-lockfiles`) ([files.texi][el-lock]). | Precious "breaks all hard links" ([lispref][el-precious]). Renaming changes the owner and group ([files.texi][el-copy]). Locks go by file name only ([files.texi][el-lock]). |
| Sublime Text | ST3 build 3211: `"atomic_save": false`, "Save via writing to an alternate file, and then renaming it over the original file" ([default settings](#sources)). Not in ST4 build 4215's defaults, and the changelog doesn't mention it. | Not researched. | None documented by Sublime. webpack tells ST3 users to set it to false ([development.mdx][webpack]). |
| JetBrains IDEs | "Back up files before saving" ("safe write"), on by default ([docs][jb-doc], [GeneralSettings.kt][jb-default]). The code copies to `file~`, overwrites in place with `SYNC`, deletes the backup, and restores it on an `IOException` ([SafeFileOutputStream.java][jb-safe]). Only large files use temp `.tmp` + `ATOMIC_MOVE` ([Preemptive...java][jb-pre], [LocalFileSystemBase.java][jb-select]). | Reloads changed files on window switch or while idle ([docs][jb-doc]); the save-time check was not researched. | Its own comment assumes that after a crash, either the target is intact or a backup exists ([SafeFileOutputStream.java][jb-safe]). webpack's guide still says to uncheck "Use safe write" ([development.mdx][webpack]). |
| npm write-file-atomic | `realpath`, then temp `name.<murmurhash>`, mode and owner copied from the old file, write, `fsync` (default on), `chown`, `chmod`, `rename` ([README][wfa-readme], [index.js][wfa-src]). No folder fsync. | None. It only queues writes from its own process ([README][wfa-readme]). | The temp file is cleaned up on error and on exit (`signal-exit`) ([index.js][wfa-src]). Node core: issue [#49886][n-49886] led to the `flush` option (v21.0.0, v20.10.0). An open PR, [#65754][n-65754], adds `atomic` to `writeFile`, still without a folder fsync. |
| Git | `<file>.lock` opened `O_CREAT\|O_EXCL`, written, renamed into place ([lockfile.h][git-lock], [tempfile.c][git-excl]). `core.fsync` defaults to `committed,-loose-object`. `core.fsyncMethod` defaults to `writeout-only` on macOS, which "may not be durable" ([core.adoc][git-fsync]). Checkout unlinks the work-tree file ([entry.c][git-entry]) and creates a new one with `O_EXCL` ([entry.c][git-create]). | The lock itself: a second writer fails on `O_EXCL`. | "Lockfiles only block other writers"; readers see the old or new file "assuming that the filesystem implements rename(2) atomically" ([lockfile.h][git-lock]). |
| SQLite | Rollback journal or WAL (see Techniques). | POSIX advisory locks ([lockingv3][sq-lock]). | Assumes fsync works "as advertised" ([atomiccommit][sq-ac]). |

### What Eleventy's watcher sees

- **Eleventy 3.1.8** (npm `latest`) depends on `@11ty/chokidar-with-glob-support` ^1.1.0 ([package.json][el11-pkg]), which depends on `chokidar` ^4.0.3 (npm metadata). It sets `ignoreInitial: true` and `awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 }`. It leaves `atomic` at chokidar's default ([Eleventy.js][el11-cfg]), and so does 4.0.0-alpha.12 ([Watch.js][el11-4]). On `add`/`change` it rebuilds; on `unlink` it logs "File deleted" ([Eleventy.js][el11-ev]). It watches template globs ([EleventyFiles.js][el11-globs]) and ignores `.gitignore`d files ([docs][el11-docs]).
- **chokidar 4:** `atomic` defaults to true unless polling is on. An `unlink` followed by an `add` within 100 ms becomes one `change` ([README][ch-readme], [index.ts][ch-atomic]). With `atomic` on, it also ignores any path matching `/\..*\.(sw[px])$|~$|\.subl.*\.tmp/`, so every path ending in `~` ([index.ts][ch-dot]). `awaitWriteFinish` holds `add`/`change` until the size has been stable for the threshold ([README][ch-readme]). chokidar v6 documents the same behaviour ([README][ch6]).
- **Observed here** (macOS 15.7.3, APFS, Node 24.12.0, chokidar 4.0.3 with Eleventy's options, watching the folder): an in-place `writeFile` gave one `change`. `index.md.tmp` + rename gave one `change`, and no event for the temp file. `.index.md.123~` + rename gave one `change`. Not tested on Linux (inotify).

## TOCTOU (item 2)

- **Every tool checks, then writes.** VS Code's only lock is an in-memory `Barrier` map, so it serializes VS Code's own writes and nothing else ([provider][vsc-lock]). Vim prompts on an mtime mismatch and then writes. Emacs compares the modtime at save time. None of them closes the window.
- **Locks bind only the processes that take them:**
  - `flock()`: "places advisory locks only; ... a process is free to ignore the use of flock() and perform I/O on the file" ([flock(2)][l-flock]).
  - `fcntl` record locks: "not enforced and are useful only between cooperating processes". Mandatory locking is gone since Linux 5.15 ([F_SETLK(2const)][l-setlk]).
  - macOS: advisory locks "do not guarantee consistency" ([flock(2)][m-flock]).
  - Git's `.lock`, Emacs's `.#file` and SQLite's locks are protocols among Git, Emacs and SQLite processes, respectively.
  - No editor on this list takes a lock on the Markdown file that collabtron could join.
- **There is no compare-and-swap rename.** The Linux flags are `RENAME_NOREPLACE`, `RENAME_EXCHANGE` and `RENAME_WHITEOUT` ([rename(2)][l-rename]). The macOS flags are `RENAME_SWAP`, `RENAME_EXCL`, `RENAME_NOFOLLOW_ANY` and `RENAME_RESOLVE_BENEATH` ([rename(2)][m-rename-flags]). None of them checks the target's identity.
- **The closest patterns:**
  - **Exchange, then verify:** `RENAME_EXCHANGE`/`RENAME_SWAP` puts the new file in place and leaves the displaced one at the temp name. Nothing is destroyed: you can hash the displaced file and swap back. Readers may see collabtron's version for a moment, and an editor still holding the old fd writes into the displaced file. Not available from Node.
  - **Link, then compare (possible in Node):** `fs.link(file, pin)` keeps the inode that is about to be replaced. After the `rename`, hash `pin`. If it no longer matches the last written hash, an in-place write landed after the check, and its content is in `pin`. A rename-style save that lands between the link and the rename is still lost: Vim `auto`, Emacs's first save, and `git checkout` (unlink, then create) all produce a new inode, which our rename unlinks.
  - **Narrowing:** write and fsync the temp file first, then read, hash and rename back to back. That leaves a window of one small read, one hash and one `rename` (inferred from the steps, not measured).

## Options for collabtron

**A. Temp + fsync + rename + folder fsync, with the hash check moved to just before the rename.**

- **Fixes:** item 1 in all three cases (process death, power loss, ENOSPC). It also shrinks item 2's window from "write the whole file" to "read, hash, rename".
- **Costs:** a new inode on every save. Hard links to the Post break, xattrs and ACLs are dropped (Node has no xattr API, so macOS Finder tags are lost), and the owner becomes the Server's user (the same user in dev).
- **Other costs:** a `.index.md.<pid>~` file is left behind after a hard crash. chokidar ignores `*~`, but `git status` may show it. Each save pays `F_FULLFSYNC` latency on macOS, at most once every 1–10 s (ADR 0006).
- **Code shape** (about 20 lines, no dependency):

```ts
// post-file.ts. `unchanged(onDisk)` is the saver's hash comparison; false means "changed outside".
export async function writePost(post: Post, text: string, unchanged: (onDisk: string) => boolean) {
  const file = await realpath(post.file); // replace the target, not a symlink to it
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}~`); // chokidar's atomic mode ignores *~
  const { mode } = await stat(file);
  const fh = await open(tmp, "wx"); // O_CREAT|O_EXCL
  try {
    try {
      await fh.chmod(mode & 0o7777); // open()'s mode is masked by umask
      await fh.writeFile(text);
      await fh.sync(); // F_FULLFSYNC on macOS
    } finally {
      await fh.close();
    }
    if (!unchanged(await readFile(file, "utf8"))) return false; // check last: smallest window
    await rename(tmp, file);
  } finally {
    await unlink(tmp).catch(() => {}); // already gone after the rename
  }
  const dir = await open(dirname(file), "r"); // makes the rename durable
  try { await dir.sync(); } finally { await dir.close(); }
  return true;
}
```

**B. Backup copy, then write in place (the JetBrains and Vim `backupcopy=yes` approach).**

- **Fixes:** a failed save becomes recoverable. It keeps the inode, links and xattrs.
- **Costs:** saves are not atomic, so Eleventy can read a partial file; `awaitWriteFinish` only narrows that. It needs a recovery path when the Server starts (a leftover backup means the last save may be partial), with tests for it. It writes twice and fsyncs twice. Item 2 is unchanged.
- **Code shape:** `copyFile(file, bak)`, sync `bak`, `writeFile(file, text, { flush: true })`, `unlink(bak)`, plus the recovery path at startup.

**C. A, plus link-then-compare.**

- **Adds:** about 8 lines and a second short-lived `~` file per save. It catches an outside in-place write (VS Code's save path) that lands in the window, and keeps that content to restore. It does not catch rename-style saves.
- **Code shape:** `link(file, pin)` before the check. After `rename`, if `hash(await readFile(pin, "utf8")) !== writtenHash`, put `pin` back and report a conflict. Finally `unlink(pin)`.

**D. The `write-file-atomic` dependency.** It does A without the folder fsync and without the check ordering, which costs a dependency to save about 15 lines. Not recommended.

**Pick: A.** It is the only option that closes item 1 in every failure mode, and it is the same pattern as Git, write-file-atomic, Emacs precious files and VS Code's state files. On macOS Eleventy saw one `change`. Item 2 stays a narrowed, documented window. Add C only if losses from in-place writers show up.

## Sources

Code was read at these commits, and the line links above point to them:

| Repo | Commit / version |
|---|---|
| [apple-oss-distributions/xnu](https://github.com/apple-oss-distributions/xnu/tree/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea) | `f6217f8` (man pages in `bsd/man/man2/`) |
| [nodejs/node](https://github.com/nodejs/node/tree/70f6b58ac655234435a99d72b857dd7b316d34bf) | v24.12.0 `70f6b58` (libuv 1.51.0 in `deps/uv`) |
| [microsoft/vscode](https://github.com/microsoft/vscode/tree/733a99842b0e0e14c3593dfab31fff2035478ba0) | `733a998` |
| [vim/vim](https://github.com/vim/vim/tree/b8e10a2b578eb87a2f3f0c18c089a8106c72c91e) | `b8e10a2` |
| [emacs-mirror/emacs](https://github.com/emacs-mirror/emacs/tree/aaa70b935a2222725dd048e4429f099ced9c0605) | `aaa70b9` |
| [JetBrains/intellij-community](https://github.com/JetBrains/intellij-community/tree/aac269f41b10472bda9c45d90d87ea9e3bdb87a7) | `aac269f` |
| [npm/write-file-atomic](https://github.com/npm/write-file-atomic/tree/23e111d95367e1d987c1b4d7823791eaaf6b21df) | `23e111d` |
| [git/git](https://github.com/git/git/tree/f7de81456940dd6f3274e461149bba12965de609) | `f7de814` |
| [paulmillr/chokidar](https://github.com/paulmillr/chokidar/tree/1182965a0d3d884f15db423009262778ddba0ac4) | 4.0.3 `1182965`; v6 README at `e4021d8` |
| [11ty/eleventy](https://github.com/11ty/buildawesome/tree/a496c71c3e919d3d414b6b85f261a4de9511d636) (now `11ty/buildawesome`) | v3.1.8 `a496c71`; 4.0.0-alpha.12 `7c44651` |
| [torvalds/linux](https://github.com/torvalds/linux/blob/f802b6558eb81bd5888d761a0cdc8afe5fd8c941/Documentation/admin-guide/ext4.rst#L318-L329) | `f802b65` |
| Sublime Text default settings | `Packages/Default.sublime-package` → `Preferences.sublime-settings` L222-224 in [build 3211](https://download.sublimetext.com/sublime_text_3_build_3211_x64.tar.bz2); absent in [build 4215](https://download.sublimetext.com/sublime_text_build_4215_x64.tar.xz); [changelog](https://www.sublimetext.com/download) |

Specs, manuals and docs: [POSIX rename][posix-rename], [Linux man pages (man7.org)](https://man7.org/linux/man-pages/), [SQLite atomic commit][sq-ac], [SQLite WAL][sq-wal], [JetBrains System settings][jb-doc], [Eleventy watch and serve][el11-docs], [webpack development guide][webpack].

[posix-rename]: https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html
[m-rename]: https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/rename.2#L76-L81
[m-rename-flags]: https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/rename.2#L118-L155
[m-fsync]: https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/fsync.2#L56-L85
[m-fcntl]: https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/fcntl.2#L207-L245
[m-clone]: https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/clonefile.2#L44-L80
[m-xchg]: https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/exchangedata.2#L68-L83
[m-flock]: https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/flock.2#L70-L74
[l-rename]: https://man7.org/linux/man-pages/man2/rename.2.html#DESCRIPTION
[l-fsync]: https://man7.org/linux/man-pages/man2/fsync.2.html#DESCRIPTION
[l-open]: https://man7.org/linux/man-pages/man2/open.2.html#DESCRIPTION
[l-link]: https://man7.org/linux/man-pages/man2/link.2.html#DESCRIPTION
[l-falloc]: https://man7.org/linux/man-pages/man2/fallocate.2.html#DESCRIPTION
[l-ficlone]: https://man7.org/linux/man-pages/man2/FICLONE.2const.html
[l-flock]: https://man7.org/linux/man-pages/man2/flock.2.html#NOTES
[l-setlk]: https://man7.org/linux/man-pages/man2/F_SETLK.2const.html
[ext4]: https://github.com/torvalds/linux/blob/f802b6558eb81bd5888d761a0cdc8afe5fd8c941/Documentation/admin-guide/ext4.rst#L318-L329
[uv-fsync]: https://github.com/nodejs/node/blob/70f6b58ac655234435a99d72b857dd7b316d34bf/deps/uv/src/unix/fs.c#L170-L202
[uv-clone]: https://github.com/nodejs/node/blob/70f6b58ac655234435a99d72b857dd7b316d34bf/deps/uv/src/unix/fs.c#L1357-L1376
[uv-rename]: https://github.com/nodejs/node/blob/70f6b58ac655234435a99d72b857dd7b316d34bf/deps/uv/src/unix/fs.c#L1712-L1724
[n-flush]: https://github.com/nodejs/node/blob/70f6b58ac655234435a99d72b857dd7b316d34bf/doc/api/fs.md#L1904-L1905
[n-const]: https://github.com/nodejs/node/blob/70f6b58ac655234435a99d72b857dd7b316d34bf/src/node_constants.cc
[n-wf]: https://github.com/nodejs/node/blob/70f6b58ac655234435a99d72b857dd7b316d34bf/lib/internal/fs/promises.js#L480-L505
[n-chunk]: https://github.com/nodejs/node/blob/70f6b58ac655234435a99d72b857dd7b316d34bf/lib/internal/fs/utils.js#L144
[n-49886]: https://github.com/nodejs/node/issues/49886
[n-65754]: https://github.com/nodejs/node/pull/65754
[vsc-lock]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/platform/files/node/diskFileSystemProvider.ts#L187-L216
[vsc-atomic]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/platform/files/node/diskFileSystemProvider.ts#L277-L336
[vsc-trunc]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/platform/files/node/diskFileSystemProvider.ts#L423
[vsc-sync]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/platform/files/node/diskFileSystemProvider.ts#L592-L606
[vsc-check]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/platform/files/common/fileService.ts#L505-L536
[vsc-etag]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/platform/files/common/files.ts#L1600-L1606
[vsc-save]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/workbench/services/textfile/common/textFileEditorModel.ts#L1033-L1039
[vsc-setting]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/workbench/contrib/files/browser/files.contribution.ts#L376-L389
[vsc-ud]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/platform/userData/common/fileUserDataProvider.ts#L136-L142
[vsc-state]: https://github.com/microsoft/vscode/blob/733a99842b0e0e14c3593dfab31fff2035478ba0/src/vs/platform/state/node/stateService.ts#L141
[vim-bkc]: https://github.com/vim/vim/blob/b8e10a2b578eb87a2f3f0c18c089a8106c72c91e/runtime/doc/options.txt#L1181-L1243
[vim-fsync]: https://github.com/vim/vim/blob/b8e10a2b578eb87a2f3f0c18c089a8106c72c91e/runtime/doc/options.txt#L4343-L4358
[vim-wb]: https://github.com/vim/vim/blob/b8e10a2b578eb87a2f3f0c18c089a8106c72c91e/runtime/doc/options.txt#L10887-L10903
[vim-bt]: https://github.com/vim/vim/blob/b8e10a2b578eb87a2f3f0c18c089a8106c72c91e/runtime/doc/editing.txt#L1037-L1057
[vim-ts]: https://github.com/vim/vim/blob/b8e10a2b578eb87a2f3f0c18c089a8106c72c91e/runtime/doc/editing.txt#L1666-L1670
[vim-mtime]: https://github.com/vim/vim/blob/b8e10a2b578eb87a2f3f0c18c089a8106c72c91e/src/bufwrite.c#L537-L550
[vim-auto]: https://github.com/vim/vim/blob/b8e10a2b578eb87a2f3f0c18c089a8106c72c91e/src/bufwrite.c#L1181-L1198
[el-once]: https://github.com/emacs-mirror/emacs/blob/aaa70b935a2222725dd048e4429f099ced9c0605/doc/emacs/files.texi#L575-L579
[el-copy]: https://github.com/emacs-mirror/emacs/blob/aaa70b935a2222725dd048e4429f099ced9c0605/doc/emacs/files.texi#L728-L799
[el-fsync]: https://github.com/emacs-mirror/emacs/blob/aaa70b935a2222725dd048e4429f099ced9c0605/doc/emacs/files.texi#L835-L853
[el-lock]: https://github.com/emacs-mirror/emacs/blob/aaa70b935a2222725dd048e4429f099ced9c0605/doc/emacs/files.texi#L857-L935
[el-precious]: https://github.com/emacs-mirror/emacs/blob/aaa70b935a2222725dd048e4429f099ced9c0605/doc/lispref/files.texi#L494-L507
[el-modtime]: https://github.com/emacs-mirror/emacs/blob/aaa70b935a2222725dd048e4429f099ced9c0605/doc/lispref/buffers.texi#L635-L646
[el-precious-src]: https://github.com/emacs-mirror/emacs/blob/aaa70b935a2222725dd048e4429f099ced9c0605/lisp/files.el#L6335-L6393
[el-direct]: https://github.com/emacs-mirror/emacs/blob/aaa70b935a2222725dd048e4429f099ced9c0605/lisp/files.el#L6422-L6429
[jb-doc]: https://www.jetbrains.com/help/idea/system-settings.html
[jb-default]: https://github.com/JetBrains/intellij-community/blob/aac269f41b10472bda9c45d90d87ea9e3bdb87a7/platform/ide-core/src/com/intellij/ide/GeneralSettings.kt#L248
[jb-safe]: https://github.com/JetBrains/intellij-community/blob/aac269f41b10472bda9c45d90d87ea9e3bdb87a7/platform/util/src/com/intellij/util/io/SafeFileOutputStream.java#L28-L138
[jb-pre]: https://github.com/JetBrains/intellij-community/blob/aac269f41b10472bda9c45d90d87ea9e3bdb87a7/platform/util/src/com/intellij/util/io/PreemptiveSafeFileOutputStream.java#L18-L31
[jb-select]: https://github.com/JetBrains/intellij-community/blob/aac269f41b10472bda9c45d90d87ea9e3bdb87a7/platform/vfs-impl/src/com/intellij/openapi/vfs/impl/local/LocalFileSystemBase.java#L478-L483
[webpack]: https://github.com/webpack/webpack.js.org/blob/684605583e68c26a49c6a4e2f25de41656ffe995/src/content/guides/development.mdx#L441-L449
[wfa-readme]: https://github.com/npm/write-file-atomic/blob/23e111d95367e1d987c1b4d7823791eaaf6b21df/README.md#L34-L53
[wfa-src]: https://github.com/npm/write-file-atomic/blob/23e111d95367e1d987c1b4d7823791eaaf6b21df/lib/index.js#L80-L160
[git-lock]: https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/lockfile.h#L9-L30
[git-excl]: https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/tempfile.c#L142
[git-fsync]: https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/Documentation/config/core.adoc#L671-L728
[git-entry]: https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/entry.c#L577
[git-create]: https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/entry.c#L86-L89
[sq-ac]: https://www.sqlite.org/atomiccommit.html
[sq-wal]: https://www.sqlite.org/wal.html
[sq-lock]: https://www.sqlite.org/lockingv3.html
[ch-readme]: https://github.com/paulmillr/chokidar/blob/1182965a0d3d884f15db423009262778ddba0ac4/README.md#L189-L218
[ch-atomic]: https://github.com/paulmillr/chokidar/blob/1182965a0d3d884f15db423009262778ddba0ac4/src/index.ts#L616-L634
[ch-dot]: https://github.com/paulmillr/chokidar/blob/1182965a0d3d884f15db423009262778ddba0ac4/src/index.ts#L80
[ch6]: https://github.com/paulmillr/chokidar/blob/e4021d84b99008481e1d40e01716e2076e41ad02/README.md#L157-L166
[el11-pkg]: https://github.com/11ty/buildawesome/blob/a496c71c3e919d3d414b6b85f261a4de9511d636/package.json#L127
[el11-cfg]: https://github.com/11ty/buildawesome/blob/a496c71c3e919d3d414b6b85f261a4de9511d636/src/Eleventy.js#L1167-L1188
[el11-ev]: https://github.com/11ty/buildawesome/blob/a496c71c3e919d3d414b6b85f261a4de9511d636/src/Eleventy.js#L1281-L1303
[el11-globs]: https://github.com/11ty/buildawesome/blob/a496c71c3e919d3d414b6b85f261a4de9511d636/src/EleventyFiles.js#L442-L454
[el11-4]: https://github.com/11ty/buildawesome/blob/7c4465157465ed78a319d1d5ad478dcb0a3726bd/src/Watch.js#L23-L30
[el11-docs]: https://www.11ty.dev/docs/watch-serve/#ignore-watching-files
