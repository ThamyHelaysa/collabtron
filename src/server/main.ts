import { createPostCatalog } from "./post-catalog.ts";
import { startServer } from "./server.ts";

const mode = process.env.MODE ?? "dev";
if (mode !== "dev") throw new Error(`MODE=${mode} not supported yet; only dev`);

const host = process.env.HOST ?? "127.0.0.1";
// No auth yet: dev must never be reachable from the network.
if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error(`HOST=${host}: dev mode binds loopback only`);

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT=${process.env.PORT}: not a valid port`);

const postsDir = process.env.POSTS_DIR;
if (!postsDir) throw new Error("POSTS_DIR not set: the site's posts directory");
const postId = process.argv[2];
if (!postId) throw new Error("usage: pnpm dev <post-id>");
const catalog = await createPostCatalog(postsDir, [postId]);

const server = await startServer({ host, port, catalog });
console.log(`collabtron dev server on http://${host}:${port}/p/${postId}`);
// Ctrl-C and `node --watch` restarts: save what is pending before the process stops.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void server.close().finally(() => process.exit()));
