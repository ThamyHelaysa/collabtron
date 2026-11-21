import { afterEach, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { startServer } from "./server.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

test("serves the editor page on localhost", async () => {
  const server = await startServer({ host: "127.0.0.1", port: 0 });
  close = server.close;
  const { port } = server.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${port}/`);

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain('<div id="editor">');
});
