import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline, type Duplex } from "node:stream";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { colors, displayName } from "../shared/collaborator.ts";
import { parse, serialize } from "../shared/markdown.ts";
import { createAuthority, type Authority } from "./authority.ts";
import type { Post, PostCatalog } from "./post-catalog.ts";
import { readPost } from "./post-file.ts";
import { createPostSaver, type PostSaver } from "./post-saver.ts";

const clientDir = new URL("../../dist/client/", import.meta.url);

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>collabtron</title>
  <style>
    body { margin: 0; }
    #layout { display: grid; grid-template-columns: 1fr 1fr; gap: 1em; padding: 0 1em; }
    #preview { position: sticky; top: 0; width: 100%; height: 100vh; border: 0; border-left: 1px solid #ccc; }
    .ProseMirror { white-space: pre-wrap; word-wrap: break-word; outline: none; min-height: 50vh; }
    .raw-block, .raw-inline { font-family: monospace; background: #eee; color: #555; cursor: grab; }
    .raw-block { white-space: pre-wrap; padding: .5em; }
    .front-matter { font-family: monospace; background: #f4f4f4; padding: .5em; white-space: pre-wrap; }
    #recovery { margin: .5em 0; padding: .5em; border: 1px solid #e90; background: #fff6e5; }
    #recovery .ProseMirror { min-height: 0; }
    #yaml-warning, #save-warning { white-space: pre-wrap; font-family: monospace; color: #900; background: #fdeeee; border: 1px solid #d33; padding: .5em; }
    .ProseMirror-selectednode { outline: 2px solid #48f; }
    .shortcode-block { margin: 1em 0; padding: .5em; border: 1px solid #ccc; border-radius: 4px; }
    .shortcode-block fieldset { display: grid; gap: .25em; border: 0; padding: 0; margin: 0; }
    .shortcode-block label { display: grid; font-size: .85em; color: #555; }
    .shortcode-block figcaption { margin-top: .5em; }
    blockquote { border-left: 4px solid #ccc; margin-left: 0; padding-left: 1em; }
    .error-block { border-color: #d33; background: #fdeeee; }
    .warning-block { border-color: #e90; background: #fff6e5; }
    .details { border: 1px solid #ccc; border-radius: 4px; padding: .5em; }
    .details-summary { font-weight: bold; }
    .details-summary::before { content: "▸ "; }
    .presence { position: relative; margin: 0 -1px; border-left: 2px solid var(--presence); }
    .presence > span { position: absolute; bottom: 100%; left: -2px; padding: 0 .25em; border-radius: 2px; background: var(--presence); font: 11px/1.4 sans-serif; color: #fff; white-space: nowrap; pointer-events: none; user-select: none; }
    .presence-selection { background: color-mix(in srgb, var(--presence) 20%, transparent); }
    .presence-block { outline: 2px solid var(--presence); }
    ${colors.map((color, number) => `.presence-color-${number} { --presence: ${color}; }`).join("\n    ")}
  </style>
</head>
<body>
<div id="layout">
<div>
  <div id="toolbar" role="toolbar" aria-label="Formatting"></div>
  <output id="status"></output>
  <div id="yaml-warning" role="alert" hidden></div>
  <div id="save-warning" role="alert" hidden></div>
  <section id="recovery" aria-labelledby="recovery-title" hidden>
    <p id="recovery-title" role="alert">The Server started over from the saved Post, which lacks some of what this tab had. Here is this tab's text as it was: copy what is missing into the editor.</p>
    <div class="recovered"></div>
    <button type="button">Dismiss</button>
  </section>
  <div id="editor"></div>
</div>
  <iframe id="preview" title="The Post with the site layout"></iframe>
</div>
  <script type="module" src="/main.js"></script>
</body>
</html>
`;

const maxMessage = 4 * 1024 * 1024; // bytes

// In constant time, so how long a refusal takes tells nothing of the secret.
function matchesSecret(value: unknown, secret: string) {
  const given = Buffer.from(typeof value === "string" ? value : "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Where one Collaborator's cursor and selection are, at `version`.
type Presence = { id: number; name: string; color: number; version: number; anchor: number; head: number };
// Presence is kept per socket, beside the Authority: it never enters the Step log (ADR 0007).
type EditingSession = { instance: string; authority: Authority; sockets: Set<WebSocket>; presence: Map<WebSocket, Presence>; saver: PostSaver };

export async function startServer({
  host,
  port,
  catalog,
  heartbeatMs = 30_000,
  saveAfterMs = 1000,
  saveEveryMs = 10_000,
  authWithinMs = 10_000,
  eleventy,
}: {
  host: string;
  port: number;
  catalog: PostCatalog;
  // The site's own Eleventy dev server: every path the editor does not use is proxied to `url`,
  // and `page` says where it put a Post file (ADR 0009).
  eleventy?: { url: string; pageUrl(file: string): string | undefined; onBuild(listener: () => void): void };
  heartbeatMs?: number;
  saveAfterMs?: number;
  saveEveryMs?: number;
  authWithinMs?: number;
}) {
  // The Share Link's secret, new at every start: a link from before stops working (ADR 0010).
  const token = randomBytes(32).toString("base64url");
  // The preview's cookie: a secret of its own, so the token never travels with the site's pages.
  const previewKey = randomBytes(32).toString("base64url");
  const hasPreviewCookie = (req: IncomingMessage) => matchesSecret(req.headers.cookie?.match(/(?:^|;\s*)__Host-collabtron=([^;]*)/)?.[1], previewKey);
  // One Authority per open Post, loaded from the Post file when its first Collaborator joins.
  // Joining never waits between finding a loaded session here and entering it, so an ended one is never entered.
  const editingSessions = new Map<string, Promise<EditingSession>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessage });
  // Tells the others whose Presence a message is.
  let nextSocketId = 0;
  // The site's live reload sockets: closing the Server waits for every socket it upgraded, so it closes these too.
  const siteSockets = new Set<Duplex>();

  // Each build can move a Post's page: every Collaborator's preview follows it (ADR 0009).
  if (eleventy) {
    const { pageUrl } = eleventy;
    eleventy.onBuild(() => {
      for (const [id, entry] of editingSessions) {
        const url = pageUrl(catalog.get(id)!.file);
        if (url) void entry.then(({ sockets }) => sockets.forEach((socket) => socket.send(JSON.stringify({ type: "preview", url }))), () => {});
      }
    });
  }

  function editingSessionFor(post: Post) {
    let session = editingSessions.get(post.id);
    if (!session) {
      session = readPost(post).then((onDisk) => {
        const authority = createAuthority(parse(onDisk));
        const sockets = new Set<WebSocket>();
        const saver = createPostSaver({
          post,
          onDisk,
          markdown: () => serialize(authority.doc),
          report(error) {
            const message = JSON.stringify({ type: "save", error });
            for (const socket of sockets) socket.send(message);
          },
          afterMs: saveAfterMs,
          everyMs: saveEveryMs,
        });
        // New with every Editing Session, so with every Server start: tells a client coming back that its Versions belong to an Authority that is gone (ADR 0008).
        return { instance: randomUUID(), authority, sockets, presence: new Map(), saver };
      });
      editingSessions.set(post.id, session);
      // A Post that failed to open is retried by the next Collaborator.
      session.catch(() => editingSessions.delete(post.id));
    }
    return session;
  }

  // The Editing Session ends with its last Collaborator, once what they typed is saved: the next one reads the Post file again.
  // Whoever joins while it saves keeps it going; an earlier save may already have ended it and a new one taken its place.
  function endIfEmpty(post: Post, entry: Promise<EditingSession>, { sockets, saver }: EditingSession) {
    if (sockets.size) return;
    void saver.flush().then(() => {
      if (!sockets.size && editingSessions.get(post.id) === entry) editingSessions.delete(post.id);
    });
  }

  async function join(socket: WebSocket, post: Post) {
    const entry = editingSessionFor(post);
    let session: EditingSession;
    try {
      session = await entry;
    } catch (err) {
      console.error(err);
      socket.close(1011, "it has Markdown the editor cannot keep yet");
      return;
    }
    // Left while the Post was loading: it may have been the only one.
    if (socket.readyState !== socket.OPEN) return endIfEmpty(post, entry, session);
    const { instance, authority, sockets, presence, saver } = session;
    const id = nextSocketId++;
    // Sent at the current Version: every Collaborator has been sent the Steps up to it, so the positions mean the same to all.
    const presenceMessage = ({ version, anchor, head, ...rest }: Presence) => {
      const mapping = authority.mapping(version);
      return JSON.stringify({ type: "presence", ...rest, version: authority.version, anchor: mapping.map(anchor), head: mapping.map(head) });
    };
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (presence.delete(socket)) for (const other of sockets) other.send(JSON.stringify({ type: "presence", id, left: true }));
      endIfEmpty(post, entry, session);
    });
    socket.send(JSON.stringify({ type: "init", instance, version: authority.version, doc: authority.doc.toJSON() }));
    for (const other of presence.values()) socket.send(presenceMessage(other));
    // A Collaborator who joins while saving fails is told at once.
    if (saver.error) socket.send(JSON.stringify({ type: "save", error: saver.error }));

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message?.type === "presence") {
          const { version, anchor, head, name, color } = message;
          // Nothing else reaches the others: a name could hide or reorder text, a colour could carry CSS (ADR 0007).
          if (typeof name !== "string" || !name || displayName(name) !== name) throw new Error("not a display name");
          if (!Number.isInteger(color) || color < 0 || color >= colors.length) throw new Error("not a colour number");
          if (![anchor, head].every(Number.isInteger)) throw new Error("not a presence message");
          // Throws on a Version the Authority never had.
          const mapping = authority.mapping(version);
          const latest = { id, name, color, version: authority.version, anchor: mapping.map(anchor), head: mapping.map(head) };
          if (![latest.anchor, latest.head].every((pos) => pos >= 0 && pos <= authority.doc.content.size)) throw new Error("Presence outside the document");
          presence.set(socket, latest);
          const relayed = presenceMessage(latest);
          for (const other of sockets) if (other !== socket) other.send(relayed);
          return;
        }
        if (message?.type === "catch-up") {
          // A client back from a dropped connection: the Steps it missed (throws on a Version the Authority never had),
          // then where the others are, at the Version those Steps bring it to (ADR 0008).
          socket.send(JSON.stringify(authority.stepsSince(message.version)));
          for (const [other, latest] of presence) if (other !== socket) socket.send(presenceMessage(latest));
          return;
        }
        if (message?.type !== "steps" || !Array.isArray(message.steps) || !message.steps.length || !["string", "number"].includes(typeof message.clientID)) throw new Error("not a steps message");
        // Validates the Version too: throws before any Step is accepted.
        const missing = authority.stepsSince(message.version);
        if (authority.receive(message.version, message.steps, message.clientID)) {
          const accepted = JSON.stringify(authority.stepsSince(message.version));
          // The sender too: that is how it learns its Steps are confirmed.
          for (const collaborator of sockets) collaborator.send(accepted);
          saver.stepsAccepted();
        } else {
          socket.send(JSON.stringify(missing));
        }
      } catch (err) {
        console.error(err);
        socket.close(1008, "invalid message");
      }
    });
  }

  // Keeps a proxy in front of the Server from dropping idle connections.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) if (socket.readyState === socket.OPEN) socket.send('{"type":"heartbeat"}');
  }, heartbeatMs);

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end("server error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.url === "/api/auth") {
      if (req.method !== "POST") res.writeHead(405).end();
      // The editor page sends the token from its Share Link; the cookie opens the preview and the site's pages (ADR 0010).
      // `__Host-`: the browser refuses a cookie of that name set with another Path or a Domain, as a page on another port could.
      else if (!matchesSecret(req.headers.authorization, `Bearer ${token}`)) res.writeHead(403).end("not this Server's Share Link");
      else res.writeHead(204, { "set-cookie": `__Host-collabtron=${previewKey}; Path=/; HttpOnly; Secure; SameSite=Strict` }).end();
      return;
    }
    const route = req.url?.match(/^\/(p|preview)\/([^/?#]+)$/);
    // The editor page and its script hold nothing of the Post: the Share Link's token, in the fragment, is for the page alone.
    if (route?.[1] !== "p" && req.url !== "/main.js" && !hasPreviewCookie(req)) {
      // Seen in the preview only when the browser dropped the cookie: Safari keeps no `Secure` cookie over plain HTTP (ADR 0010).
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Only for a Collaborator: open the Share Link. Opened it already? This browser kept no cookie for the preview: over plain HTTP (dev mode), Safari keeps none, Chrome does.");
      return;
    }
    if (route) {
      const post = catalog.get(route[2]);
      if (!post) {
        res.writeHead(404).end("unknown Post");
        return;
      }
      if (route[1] === "p" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      } else if (route[1] === "preview" && req.method === "GET") {
        const pageUrl = eleventy?.pageUrl(post.file);
        // A header takes ASCII only; a permalink need not be.
        if (pageUrl) res.writeHead(302, { location: encodeURI(pageUrl) }).end();
        // Until the site's first build that worked: the preview asks again on its own.
        else res.writeHead(503, { "content-type": "text/plain; charset=utf-8", refresh: "2" }).end("The site has no page for this Post yet. Its build may still be running, or have failed (the terminal says why), or the site may not render this Post while serving. This retries on its own.");
      } else {
        res.writeHead(405).end();
      }
      return;
    }
    if (req.url === "/main.js") {
      try {
        const js = await readFile(new URL("main.js", clientDir));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        res.writeHead(404).end("client bundle missing: run pnpm build:client");
      }
      return;
    }
    if (!eleventy) {
      res.writeHead(404).end();
      return;
    }
    // At the root, not under a prefix: the site's pages use absolute URLs.
    const site = request(new URL(req.url!, eleventy.url), { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode!, answer.headers);
      // Either side closing early closes the other: a reset page ends, a closed tab frees the dev server.
      pipeline(answer, res, () => {});
    });
    site.on("error", (err) => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(`The site's Eleventy dev server did not answer: ${err.message}`);
    });
    req.pipe(site);
  }

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws/")) {
      if (!eleventy) return void socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      // The site's live reload sends its pages as they build: the same cookie as the pages (ADR 0010).
      if (!hasPreviewCookie(req)) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      siteSockets.add(socket);
      socket.once("close", () => siteSockets.delete(socket));
      proxyUpgrade(eleventy.url, req, socket, head);
      return;
    }
    const post = catalog.get(req.url.match(/^\/ws\/([^/?#]+)$/)?.[1] ?? "");
    if (!post) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The first message is the Share Link's token: before it, nothing of the Post is read or sent.
      // Any page can open a socket here, so one that sends nothing is closed too.
      const late = setTimeout(() => ws.close(4003, "not this Server's Share Link"), authWithinMs).unref();
      ws.once("message", (data) => {
        clearTimeout(late);
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {}
        if (message?.type === "auth" && matchesSecret(message.token, token)) void join(ws, post);
        else ws.close(4003, "not this Server's Share Link");
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    address: () => server.address(),
    token,
    // Saves what every Editing Session has pending, so stopping the process after it loses nothing that was accepted.
    close: async () => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      for (const socket of siteSockets) socket.destroy();
      await Promise.all([...editingSessions.values()].map((session) => session.then(({ saver }) => saver.flush(), () => {})));
      const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      // A browser keeps idle and preconnected sockets open; waiting for them would stall Ctrl-C and `node --watch` restarts.
      server.closeAllConnections();
      return closed;
    },
  };
}

// The site's live reload socket: Eleventy's reload client opens it at ws://<the page's host>/, so here.
function proxyUpgrade(siteUrl: string, req: IncomingMessage, socket: Duplex, head: Buffer) {
  // A tab closing resets its socket: routine, and each end closes the other below.
  socket.on("error", () => {});
  const site = request(new URL(req.url!, siteUrl), { headers: req.headers });
  socket.on("close", () => site.destroy());
  site.on("upgrade", (answer, siteSocket, siteHead) => {
    siteSocket.on("error", () => {}).on("close", () => socket.destroy());
    socket.on("close", () => siteSocket.destroy());
    const headers = answer.rawHeaders.flatMap((name, i) => (i % 2 ? [] : [`${name}: ${answer.rawHeaders[i + 1]}`]));
    socket.write(["HTTP/1.1 101 Switching Protocols", ...headers, "", ""].join("\r\n"));
    socket.write(siteHead);
    siteSocket.write(head);
    siteSocket.pipe(socket).pipe(siteSocket);
  });
  site.on("response", (answer) => {
    answer.resume();
    socket.end(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n\r\n`);
  });
  site.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  site.end();
}
