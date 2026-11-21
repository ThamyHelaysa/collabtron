import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { parse } from "../shared/markdown.ts";
import { createAuthority, type Authority } from "./authority.ts";
import type { Post, PostCatalog } from "./post-catalog.ts";
import { readPost, writePost } from "./post-file.ts";

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
    #yaml-warning { white-space: pre-wrap; font-family: monospace; color: #900; background: #fdeeee; border: 1px solid #d33; padding: .5em; }
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
  <div id="editor"></div>
  <script type="module" src="/main.js"></script>
</body>
</html>
`;

const maxBody = 4 * 1024 * 1024; // bytes

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new Error("body too large");
    chunks.push(chunk);
  }
  // Decode once: a multi-byte character can straddle two chunks.
  return Buffer.concat(chunks).toString("utf8");
}

type EditingSession = { authority: Authority; sockets: Set<WebSocket> };

export async function startServer({ host, port, catalog, heartbeatMs = 30_000 }: { host: string; port: number; catalog: PostCatalog; heartbeatMs?: number }) {
  // New on every start: tells clients their Versions belong to an Authority that is gone.
  const instance = randomUUID();
  // One Authority per open Post, loaded from the Post file when its first Collaborator joins.
  // Joining never waits between finding a loaded session here and entering it, so an ended one is never entered.
  const editingSessions = new Map<string, Promise<EditingSession>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBody });

  function editingSessionFor(post: Post) {
    let session = editingSessions.get(post.id);
    if (!session) {
      session = readPost(post).then((markdown) => ({ authority: createAuthority(parse(markdown)), sockets: new Set<WebSocket>() }));
      editingSessions.set(post.id, session);
      // A Post that failed to open is retried by the next Collaborator.
      session.catch(() => editingSessions.delete(post.id));
    }
    return session;
  }

  async function join(socket: WebSocket, post: Post) {
    let session: EditingSession;
    try {
      session = await editingSessionFor(post);
    } catch (err) {
      console.error(err);
      socket.close(1011, "it has Markdown the editor cannot keep yet");
      return;
    }
    if (socket.readyState !== socket.OPEN) return;
    const { authority, sockets } = session;
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      // The Editing Session ends with its last Collaborator: the next one reads the Post file again.
      if (!sockets.size) editingSessions.delete(post.id);
    });
    socket.send(JSON.stringify({ type: "init", instance, version: authority.version, doc: authority.doc.toJSON() }));

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
      } else if (route[1] === "api/posts" && req.method === "PUT") {
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          res.writeHead(413, { connection: "close" }).end();
          return;
        }
        await writePost(post, body);
        res.writeHead(204).end();
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
    close: () => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
