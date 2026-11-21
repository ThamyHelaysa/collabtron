import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PostCatalog } from "./post-catalog.ts";
import { readPostBody, writePostBody } from "./post-file.ts";

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
    .ProseMirror-selectednode { outline: 2px solid #48f; }
    .shortcode-block { margin: 1em 0; padding: .5em; border: 1px solid #ccc; border-radius: 4px; }
    .shortcode-block fieldset { display: grid; gap: .25em; border: 0; padding: 0; margin: 0; }
    .shortcode-block label { display: grid; font-size: .85em; color: #555; }
    .shortcode-block figcaption { margin-top: .5em; }
  </style>
</head>
<body>
  <div id="toolbar" role="toolbar" aria-label="Formatting"></div>
  <output id="status"></output>
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

export async function startServer({ host, port, catalog }: { host: string; port: number; catalog: PostCatalog }) {
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
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(await readPostBody(post));
      } else if (route[1] === "api/posts" && req.method === "PUT") {
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          res.writeHead(413, { connection: "close" }).end();
          return;
        }
        await writePostBody(post, body);
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    address: () => server.address(),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
