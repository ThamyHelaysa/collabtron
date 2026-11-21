# One `steps` message for accepted and missing Steps

The sync protocol of [ADR 0001](0001-central-authority-over-crdt.md) (issue #10) has three server messages over the WebSocket at `/ws/<post-id>`: `init` (instance ID, Version, document), `steps` and `heartbeat`. A `steps` message always means "these are the Steps from Version `version` on, with the Collaborator that made each". The Authority sends it in two cases: to every Collaborator of the Post when it accepts Steps, the sender included, and to the sender alone when its Steps were based on a stale Version. The client treats both the same way: it skips the Steps it already has, applies the rest with `prosemirror-collab`'s `receiveTransaction` (which confirms its own Steps and rebases the unconfirmed ones), then sends what is still unconfirmed.

## Considered Options

- **Separate `steps-accepted` and `steps-missing` messages**: rejected. The client would do the same thing for both, and a rejection often repeats Steps the broadcast already delivered, so the client needs the skip-by-Version logic anyway.
- **Rejecting with no Steps, since the broadcast delivers them**: rejected. Reconnecting clients (issue for M5) will not have been there for the broadcast.

## Consequences

- A client sends one batch at a time and waits for a `steps` message before the next. Every batch gets one, so it never waits forever while connected.
- A message that is not valid (a Step that does not apply, a Version the Authority never had) closes the socket; none of its Steps are accepted. A correct client never sends one.
- An Authority is loaded from the Post file when the first Collaborator joins and stays in memory until the Server stops, even with nobody connected: dropping it would lose the Step log.
- There is no auth yet, and browsers let any site open a WebSocket to localhost, so the upgrade is refused when `Origin` is not the editor's own page. Clients that send no `Origin` (tests, scripts) are let in. This check goes away only when the token handshake replaces it.
- The Save button still writes that tab's document with `PUT`; saving from the Authority is a later issue.
