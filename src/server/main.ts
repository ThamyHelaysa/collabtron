import { relative } from "node:path";
import { startEleventy } from "./eleventy.ts";
import { createPostCatalog } from "./post-catalog.ts";
import { startServer } from "./server.ts";

const mode = process.env.MODE ?? "dev";
if (mode !== "dev") throw new Error(`MODE=${mode} not supported yet; only dev`);

const host = process.env.HOST ?? "127.0.0.1";
// Plain HTTP: the token and the cookie would cross the network in clear text.
if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error(`HOST=${host}: dev mode binds loopback only`);

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT=${process.env.PORT}: not a valid port`);

const siteDir = process.env.SITE_DIR;
if (!siteDir) throw new Error("SITE_DIR not set: the local clone of the Eleventy site");
const postsDir = process.env.POSTS_DIR;
if (!postsDir) throw new Error("POSTS_DIR not set: the site's posts directory");
// Eleventy knows a Post's page by its path inside the site.
if (relative(siteDir, postsDir).startsWith("..")) throw new Error("POSTS_DIR is not inside SITE_DIR: the preview could never find a Post");
const postId = process.argv[2];
if (!postId) throw new Error("usage: pnpm dev <post-id>");
const catalog = await createPostCatalog(postsDir, [postId]);

console.log("Building the site with its own Eleventy…");
const eleventy = await startEleventy(siteDir);
const server = await startServer({ host, port, catalog, eleventy });
// New at every start: send it again to the Collaborators after a restart (ADR 0010).
console.log(`Share Link: http://${host}:${port}/p/${postId}#token=${server.token}`);
// Ctrl-C and `node --watch` restarts: save what is pending before the process stops.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void Promise.all([server.close(), eleventy.close()]).finally(() => process.exit()));
