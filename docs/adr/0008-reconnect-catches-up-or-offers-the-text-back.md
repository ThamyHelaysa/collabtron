# Reconnect catches up on the same Authority, or offers the text back

A dropped connection or a stopped Server must not lose a Collaborator's text (issue #13). The client (`src/client/sync.ts`) opens a new socket 1 s after one closes without a closing handshake: a network drop, a stopped Server, a refused connection. It does not when the Server closed it on purpose (an invalid message, a Post file it cannot read): trying again would get the same answer. A refused upgrade is tried again: a Server started for another Post may be started for this one again, and the tab keeps its text meanwhile.

`init` carries the instance ID of the Editing Session, not of the Server process. An Authority, Step log included, is dropped when its last Collaborator leaves ([ADR 0005](0005-one-steps-message.md)), so a Version only means something within one Editing Session. A Server start gives every Editing Session a new ID too.

On `init`, the client compares what it has with the Authority:

- **Same instance ID, and its Version is not ahead of the Authority's**: it sends `{ type: "catch-up", version }`. The Server answers with a `steps` message from that Version, then the other Collaborators' latest Presence: the Presence sent on joining was at a Version the client had not reached yet, so the client dropped it ([ADR 0007](0007-presence-relayed-at-the-authority-version.md)). The client rebases its unconfirmed Steps over the ones it missed and sends them as usual. A `catch-up` at a Version the Authority never had closes the socket, like Steps do.
- **Anything else**: a new Authority. Steps based on the old one cannot apply, so they are dropped. The editor is built again from the new document. If this tab's text, as Markdown, differs from the new document's, the page shows it read-only in `#recovery`, to copy from. Copying from a ProseMirror view keeps the formatting and the Shortcode Blocks when pasted into the editor.

After every transaction, the client keeps in `sessionStorage`, under `collabtron.post.<post-id>`, the instance ID, its Version, the Authority's document at that Version and its unconfirmed Steps with their `clientID`. A reloaded tab reads it before it builds the editor. With the same instance ID and unconfirmed Steps, it rebuilds the editor as it was and catches up as above; with a new instance ID, it offers the text back as above.

## Considered Options

- **Instance ID per Server start, as the spec said**: rejected. The Server drops an Authority with its last Collaborator, so a client returning to the same process would resend Steps on Versions of an Authority that is gone.
- **Keeping an Authority alive for a while after its last Collaborator leaves**: rejected for now. It would make a lone Collaborator's network drop invisible too, but it changes when the Post file is read again ([ADR 0005](0005-one-steps-message.md)) and when saving ends ([ADR 0006](0006-server-saves-never-over-outside-changes.md)).
- **Resending pending Steps on reconnect without a catch-up**: rejected. Their rejection brings the missing Steps, but not the others' Presence at the new Version.
- **`localStorage`**: rejected. Two tabs of one browser on the same Post would overwrite each other's Steps, and a reload could resend the other tab's.
- **Recovered text as Markdown in a text box**: rejected. Collaborators do not see Markdown elsewhere; pasted, it would arrive as literal `**` and shortcode syntax.

## Consequences

- A client recognises the answer to its batch, or to a `catch-up`, by its `version`: the one it sent. This replaces "a rejection brings nothing new" in [ADR 0005](0005-one-steps-message.md), which is false for a client that was away. A broadcast from that same Version is the batch that beat ours; the client sends its rebased Steps at once, and the rejection that follows brings nothing new.
- A reloaded tab reuses its `clientID`. The Authority may have accepted Steps whose confirmation never reached the tab; when they come back with that `clientID`, `prosemirror-collab` confirms them instead of rebasing a second copy over them.
- A lone Collaborator whose connection drops ends the Editing Session: the Server saves and drops the Authority. On reconnect the instance ID is new, so anything typed while away is offered back instead of sent. With two Collaborators, the Editing Session lives on and the drop is invisible.
- The text is offered back whenever it differs from the new document, even with no unconfirmed Steps: a Server that died before saving loses confirmed Steps too. After a save refused for an outside change ([ADR 0006](0006-server-saves-never-over-outside-changes.md)), a tab that comes back to the next Editing Session is offered its edits the same way.
- `sessionStorage` survives a reload and a tab restored after closing or a crash, not a Share Link opened in a new tab. The recovered text itself is not kept: reloading while `#recovery` shows loses it, and a second recovery replaces the first.
- Duplicating a tab copies its `sessionStorage`. A duplicate made while the tab has unconfirmed Steps (so, while it is cut off) takes the same `clientID`, and each of the two then takes the other's Steps for its own and drops them. A duplicate made while connected has nothing unconfirmed and gets its own `clientID`. Telling a duplicate from a reload needs a lock only a live tab holds (Web Locks), left for when it happens.
- A tab with no unconfirmed Steps can be offered a document that is only older, for example after sleeping through someone else's edits in an Editing Session that has since ended. The message says to copy what is missing, not to paste it all back.
- A connection the operating system does not report as closed (a laptop waking up, a silent network) stays open until TCP gives up. The heartbeat is sent, but the client does not watch for it yet.
- Every reconnect attempt the browser cannot make logs an error in the console, once a second while the Server is down.
- Seam 3 (`test/two-tabs.test.ts`) drives the installed Google Chrome through `playwright-core`, a new dev dependency that downloads no browser. It runs inside `pnpm test`; GitHub's Ubuntu runners have Chrome installed.
