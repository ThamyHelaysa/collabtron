# The Share Link's token opens the socket, and a cookie the preview

Only someone with the Share Link reads or edits the Post, its preview included (issue #15).

At each start, the Server makes a token of 32 random bytes, in base64url, and prints the Share Link: `/p/<post-id>#token=<token>`. The token is in the fragment, which the browser never sends, so no proxy or server log has it. The editor page reads it from there and leaves it in the address bar, so a reload still has it.

**The socket.** The first message on `/ws/<post-id>` must be `{ type: "auth", token }`. The Server compares the token in constant time (`timingSafeEqual`) and closes the socket with code `4003` on anything else, and when no message comes within 10 s: any page can open a socket here. Before that message, the Server reads nothing of the Post and sends nothing but heartbeats. `syncWithAuthority` sends it first on every socket, reconnects included. A Post ID outside the Post Catalog is refused at the upgrade, before any token.

**The preview.** An iframe cannot send a header, and the site's own code requests its scripts and its live reload. So the editor page posts the token to `/api/auth` as `Authorization: Bearer <token>`, and the Server answers `204` with the cookie `__Host-collabtron=<key>; Path=/; HttpOnly; Secure; SameSite=Strict`. Cookies are not kept per port, so a page on another port of the same host could set one of the same name; the `__Host-` prefix makes the browser refuse it with another `Path` or with a `Domain`. Every path except the editor page (`/p/<post-id>`), its script (`/main.js`) and `/api/auth` itself needs that cookie: `/preview/<post-id>` and every path proxied to the site's Eleventy, its live reload stream included. Without it the answer is `403`. The cookie holds a second random secret, not the token. The site's requests are forwarded to its Eleventy with their headers, and the token stays out of them.

The page asks for the cookie as soon as it loads, beside the socket, not after `init`. The endpoint checks the token itself, so waiting for the socket would add nothing. The iframe gets its `src` only once the cookie is there, and so does each `preview` message ([ADR 0009](0009-preview-is-the-sites-own-eleventy.md)). The status says "Connected" on `init`, not when the socket opens: an open socket can still be refused.

The `Origin` check of [ADR 0005](0005-one-steps-message.md) is gone. The token replaces it on `/ws/`, and the cookie replaces it on the site's live reload.

## Considered Options

- **The token as the cookie's value**: rejected. Every request to the site's Eleventy would carry the token that edits the Post.
- **The token in the query string**: rejected. Query strings end up in proxy and server logs.
- **The socket setting the cookie**: not possible. A WebSocket message cannot set an `HttpOnly` cookie, and the token arrives after the upgrade.
- **Keeping the `Origin` check beside the token**: rejected by the owner. `SameSite` compares sites, not origins, and a page on another port of the same host (`http://127.0.0.1:<other port>`) is the same site, so its requests carry the cookie. CORS stops its `fetch` from reading the answers. With Eleventy 3 a WebSocket, which has no CORS, carried the site's live reload; since #37 it is Server-Sent Events, a plain HTTP response that CORS covers too ([ADR 0009](0009-preview-is-the-sites-own-eleventy.md)). Reconsider before public mode, where sibling subdomains are the same site too.
- **A token that survives restarts, from `.env`, for `node --watch`**: rejected. An old link must stop working once the Server stops.

## Consequences

- A Server restart, including each `node --watch` restart of `pnpm dev`, makes every open link stop working. A tab that reconnects with the old token is refused with `4003` and does not retry. Its status asks the Collaborator to open the new Share Link in the same tab. The new link differs only in its fragment, which on its own would not reload the page, so the page reloads on `hashchange`. The tab keeps its `sessionStorage`, and the text the new Authority lacks is offered back ([ADR 0008](0008-reconnect-catches-up-or-offers-the-text-back.md)). A new link opened in another tab does not offer it.
- `GET /api/posts/<post-id>` is gone. Nothing used it, and it would have let anyone read the Post without the token.
- Over plain HTTP, Chrome keeps the `Secure` cookie on `http://127.0.0.1` (Seam 3 checks this). Safari keeps no `Secure` cookie at all, on `localhost` either (checked with Safari 26.2), so in dev mode Safari's Preview shows the `403` text. Accepted: dev mode is the owner's own tabs, and a Share Link is shared in public mode, over HTTPS (#16), where `Secure` and `__Host-` hold. Dropping `Secure` in dev mode was rejected: the spec asks for it, and on loopback it changes nothing but this. Firefox is not checked.
- The token stays in the address bar and in the browser history of whoever opened the link.
- Until the token arrives, a socket gets only heartbeats.
- A Post ID is checked before the token: `/p/<post-id>` and `/ws/<post-id>` answer differently for a Post ID outside the Post Catalog, so a page that guesses a Post ID can tell whether it is the one open. `/p/` did so before this ADR too.
- Two Servers on one host share the cookie's name, so they overwrite each other's: only the last Share Link opened shows its preview.
- The page asks for the cookie once. If that request fails, the preview stays empty until a reload.
- `clientID`, the display name and the colour are taken as sent ([ADR 0005](0005-one-steps-message.md), [ADR 0007](0007-presence-relayed-at-the-authority-version.md)). Only a Collaborator with the token can send them, and every Collaborator is trusted.
- The cookie guards the Server's port only. The site's Eleventy dev server listens on its own port, on loopback only (#37).
- `/api/auth` hides a site page at that path, like the editor's other paths ([ADR 0009](0009-preview-is-the-sites-own-eleventy.md)).
