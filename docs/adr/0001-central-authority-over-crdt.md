# Central Authority instead of a CRDT

Sync uses ProseMirror with `prosemirror-collab` and a hand-written central Authority over WebSocket: the Authority owns the Version and the Step log, rejects Steps based on a stale Version, and clients rebase and resend. We chose this over a CRDT (Yjs) because the setup already has a single central server, and writing the protocol (versioning, rebase, reconnection, persistence) is the point of the project as a portfolio piece. Swapping in Yjs later is a planned Phase 2 comparison, not a fix.

## Consequences

- No offline-first editing: Steps only become official through the Authority. Pending Steps survive in the browser, but they are discarded if the Authority restarted (new instance ID).
- The Step log lives in memory; a Server restart starts a new Version history from the saved Markdown.
