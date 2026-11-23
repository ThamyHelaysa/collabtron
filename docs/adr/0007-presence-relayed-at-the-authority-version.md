# Presence is relayed at the Authority's Version, never logged

Presence (issue #12) has its own message on the Post's WebSocket. A client sends `{ type: "presence", version, anchor, head, name, color }` only when none of its Steps is unconfirmed: its document is then the Authority's document at `version`, so the positions mean the same to the Authority. The Server keeps the latest Presence of each socket beside the Authority, never in the Step log. It relays it to the other Collaborators, not back to the sender, with an `id` it gave the socket. A Collaborator who joins gets the others' latest Presence right after `init`. When one leaves, the others get `{ type: "presence", id, left: true }`.

The Server sends positions at its current Version: it maps them over the Steps accepted since the client's `version` (`mapping` in `src/server/authority.ts`). Every Collaborator has been sent the Steps up to that Version before the Presence message, so the message arrives at the receiver's confirmed Version. The receiver maps the positions over its own unconfirmed Steps, then over every later transaction, so a cursor stays on the same text while edits arrive (`src/client/presence.ts`).

## Considered Options

- **Positions in the sender's own document, unconfirmed Steps included**: rejected. Nobody else has those Steps yet.
- **The Server relays positions as sent, unmapped**: rejected. A newcomer, or a Collaborator who got other Steps in between, would need a Step history of its own to map them.
- **Presence as Steps, or in the Step log**: rejected. Presence is ephemeral and never part of the Post (`GLOSSARY.md`).

## Consequences

- A Collaborator's cursor reaches the others one round trip after they type, once their Steps are confirmed.
- A client resends its Presence when remote Steps only moved its selection, though the others map it themselves. Only exact repeats are skipped (a `shortcut:` in `src/client/sync.ts`).
- A Presence message that is not valid closes the socket, as Steps do: a colour other than `#rrggbb` (it goes into a style attribute), a name that is not a string, positions that are not integers or fall outside the document, a Version the Authority never had. The name is drawn as text, never as HTML.
- Name and colour live in the browser's `localStorage` (`name`, `color`), so tabs of one browser share them. The name is asked with `prompt()` on the first visit, and again on the next one if it was left empty. Until the token handshake, the Server takes them as sent, like `clientID` ([ADR 0005](0005-one-steps-message.md)).
