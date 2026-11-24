// The Server and its preview against a small Eleventy site in a temp folder, the one Seam 3 uses: try the editor by hand
// with no .env and no real Post. The folder goes when the process stops.
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { startEleventy } from "../src/server/eleventy.ts";
import { startServer } from "../src/server/server.ts";
import { makeSite } from "../test/fixture-site.ts";

const site = await makeSite({ "lorem-ipsum": "---\ntitle: Lorem\n---\n\nIpsum dolor sit amet.\n" });
const eleventy = await startEleventy(site.dir);
// PORT keeps one origin across runs, and with it the browser's stored name; the OS picks one otherwise.
const server = await startServer({ host: "127.0.0.1", port: Number(process.env.PORT) || 0, catalog: site.catalog, eleventy });
console.log(`Post file: ${site.postsDir}/lorem-ipsum/index.md`);
console.log(`Share Link: http://127.0.0.1:${(server.address() as AddressInfo).port}/p/lorem-ipsum#token=${server.token}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void Promise.all([server.close(), eleventy.close()]).finally(() => rm(site.dir, { recursive: true, force: true }).finally(() => process.exit())));
}
