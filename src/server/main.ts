import { startEleventy } from "./eleventy.ts";
import { createPostCatalog } from "./post-catalog.ts";
import { startServer } from "./server.ts";

const mode = process.env.MODE ?? "dev";
if (mode !== "dev") throw new Error(`MODE=${mode} not supported yet; only dev`);

const host = process.env.HOST ?? "127.0.0.1";
// No auth yet: dev must never be reachable from the network.
if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error(`HOST=${host}: dev mode binds loopback only`);

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT=${process.env.PORT}: not a valid port`);

const siteDir = process.env.SITE_DIR;
if (!siteDir) throw new Error("SITE_DIR not set: the local clone of the Eleventy site");
const postsDir = process.env.POSTS_DIR;
if (!postsDir) throw new Error("POSTS_DIR not set: the site's posts directory");
const postId = process.argv[2];
if (!postId) throw new Error("usage: pnpm dev <post-id>");
const catalog = await createPostCatalog(postsDir, [postId]);

console.log("Building the site with its own Eleventy…");
const eleventy = await startEleventy(siteDir);
// Eleventy Dev Server 2 has no host option (ADR 0009).
console.warn(`The site's Eleventy dev server at ${eleventy.url} listens on every network interface: anyone on this network can read its pages, drafts included.`);
const server = await startServer({ host, port, catalog, eleventy });
console.log(`collabtron dev server on http://${host}:${port}/p/${postId}`);
// Ctrl-C and `node --watch` restarts: save what is pending before the process stops.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void Promise.all([server.close(), eleventy.close()]).finally(() => process.exit()));
