import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
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
    .ProseMirror { white-space: pre-wrap; word-wrap: break-word; outline: none; min-height: 50vh; }
    .raw-block, .raw-inline { font-family: monospace; background: #eee; color: #555; cursor: grab; }
    .raw-block { white-space: pre-wrap; padding: .5em; }
    .front-matter { font-family: monospace; background: #f4f4f4; padding: .5em; white-space: pre-wrap; }
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
  </style>
</head>
<body>
  <div id="toolbar" role="toolbar" aria-label="Formatting"></div>
  <output id="status"></output>
  <div id="yaml-warning" role="alert" hidden></div>
  <div id="save-warning" role="alert" hidden></div>
  <div id="editor"></div>
  <script type="module" src="/main.js"></script>
</body>
</html>
`;

const maxMessage = 4 * 1024 * 1024; // bytes

type EditingSession = { authority: Authority; sockets: Set<WebSocket>; saver: PostSaver };

export async function startServer({
  host,
  port,
  catalog,
  heartbeatMs = 30_000,
  saveAfterMs = 1000,
  saveEveryMs = 10_000,
}: {
  host: string;
  port: number;
  catalog: PostCatalog;
  heartbeatMs?: number;
  saveAfterMs?: number;
  saveEveryMs?: number;
}) {
  // New on every start: tells clients their Versions belong to an Authority that is gone.
  const instance = randomUUID();
  // One Authority per open Post, loaded from the Post file when its first Collaborator joins.
  // Joining never waits between finding a loaded session here and entering it, so an ended one is never entered.
  const editingSessions = new Map<string, Promise<EditingSession>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessage });

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
        return { authority, sockets, saver };
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
    const { authority, sockets, saver } = session;
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      endIfEmpty(post, entry, session);
    });
    socket.send(JSON.stringify({ type: "init", instance, version: authority.version, doc: authority.doc.toJSON() }));
    // A Collaborator who joins while saving fails is told at once.
    if (saver.error) socket.send(JSON.stringify({ type: "save", error: saver.error }));

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
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
    const route = req.url?.match(/^\/(p|api\/posts)\/([^/?#]+)$/);
    if (route) {
      const post = catalog.get(route[2]);
      if (!post) {
        res.writeHead(404).end("unknown Post");
        return;
      }
      if (route[1] === "p" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      } else if (route[1] === "api/posts" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(await readPost(post));
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
    res.writeHead(404).end();
  }

  server.on("upgrade", (req, socket, head) => {
    const post = catalog.get(req.url?.match(/^\/ws\/([^/?#]+)$/)?.[1] ?? "");
    // Browsers do not stop another site's page from opening a WebSocket here; with no auth yet, the Origin check does.
    const origin = req.headers.origin;
    if (!post || (origin !== undefined && origin !== `http://${req.headers.host}`)) {
      socket.end(`HTTP/1.1 ${post ? "403 Forbidden" : "404 Not Found"}\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => void join(ws, post));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    address: () => server.address(),
    // Saves what every Editing Session has pending, so stopping the process after it loses nothing that was accepted.
    close: async () => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await Promise.all([...editingSessions.values()].map((session) => session.then(({ saver }) => saver.flush(), () => {})));
      const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      // A browser keeps idle and preconnected sockets open; waiting for them would stall Ctrl-C and `node --watch` restarts.
      server.closeAllConnections();
      return closed;
    },
  };
}
