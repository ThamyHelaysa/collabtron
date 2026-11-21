import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const clientDir = new URL("../../dist/client/", import.meta.url);

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>collabtron</title>
</head>
<body>
  <div id="editor"></div>
  <script type="module" src="/main.js"></script>
</body>
</html>
`;

export async function startServer({ host, port }: { host: string; port: number }) {
  const server = createServer(async (req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      return;
    }
    if (req.url === "/main.js") {
      try {
        const js = await readFile(new URL("main.js", clientDir));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        res.writeHead(404).end("client bundle missing: run npm run build:client");
      }
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    address: () => server.address(),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
