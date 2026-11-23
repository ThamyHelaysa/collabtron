# Presence is relayed at the Authority's Version, never logged

Presence (issue #12) has its own message on the Post's WebSocket. A client sends `{ type: "presence", version, anchor, head, name, color }` only when none of its Steps is unconfirmed: its document is then the Authority's document at `version`, so the positions mean the same to the Authority. The Server keeps the latest Presence of each socket beside the Authority, never in the Step log. It relays it to the other Collaborators, not back to the sender, with an `id` it gave the socket. A Collaborator who joins gets the others' latest Presence right after `init`. When one leaves, the others get `{ type: "presence", id, left: true }`.

The Server sends positions at its current Version: it maps them over the Steps accepted since the client's `version` (`mapping` in `src/server/authority.ts`). Every Collaborator has been sent the Steps up to that Version before the Presence message, so the message arrives at the receiver's confirmed Version. The receiver maps the positions over its own unconfirmed Steps, then over every later transaction, so a cursor stays on the same text while edits arrive (`src/client/presence.ts`).

## Considered Options

- **Positions in the sender's own document, unconfirmed Steps included**: rejected. Nobody else has those Steps yet.
- **The Server relays positions as sent, unmapped**: rejected. A newcomer, or a Collaborator who got other Steps in between, would need a Step history of its own to map them.
- **Presence as Steps, or in the Step log**: rejected. Presence is ephemeral and never part of the Post (`GLOSSARY.md`).

## Consequences

- A Collaborator's cursor reaches the others one round trip after they type, once their Steps are confirmed.
- A client does not resend its Presence when remote Steps only moved its selection: it maps its last Presence over them, as the others do. It sends again when its selection moves any other way, and after its own Steps are confirmed.
- A Presence message that is not valid closes the socket, as Steps do: a colour that is not a number into the palette, a name `displayName` would change, positions that are not integers or fall outside the document, a Version the Authority never had.
- `color` is a number into a fixed palette, `colors` in `src/shared/collaborator.ts`, never a colour. The page has one class per number that sets the CSS variable `--presence`, and the caret, the highlight and the outline use only those classes. Nothing a client sends is written into CSS, so it cannot carry any.
- A name is at most 50 code points, trimmed, with no control, format or line-breaking characters (Unicode `C`, `Zl`, `Zp`): those can hide or reorder text, such as a right-to-left override or a zero-width space. The Server accepts only a name `displayName` leaves unchanged, and the client cleans its own with the same function. Emoji built with a zero-width joiner lose it and show as their parts. The name is drawn as text, never as HTML, and never enters the Post.
- A caret is drawn only inside text: between blocks it would take a line of its own. A selected block, such as a Raw Block, is outlined in the Collaborator's colour instead.
- Name and colour number live in the browser's `localStorage` (`collabtron.name`, `collabtron.color`), so tabs of one browser share them. A stored name is cleaned and a stored number outside the palette is picked again, or the socket would close on every visit. The name is asked with `prompt()` on the first visit, and again on the next one if it was left empty. Until the token handshake, the Server takes them as sent, like `clientID` ([ADR 0005](0005-one-steps-message.md)).
