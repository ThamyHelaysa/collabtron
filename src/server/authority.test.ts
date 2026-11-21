// Seam 2: the Server as a black box over WebSocket, driven by headless clients running the browser's own sync code.
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collab } from "prosemirror-collab";
import { history, undo } from "prosemirror-history";
import { EditorState } from "prosemirror-state";
import { syncWithAuthority, type Editor } from "../client/sync.ts";
import { serialize } from "../shared/markdown.ts";
import { createPostCatalog } from "./post-catalog.ts";
import { startServer } from "./server.ts";

let postsDir: string;
let url: string;
let server: Awaited<ReturnType<typeof startServer>>;
const sockets: WebSocket[] = [];

async function start() {
  const catalog = await createPostCatalog(postsDir, ["lorem-ipsum"]);
  server = await startServer({ host: "127.0.0.1", port: 0, catalog, heartbeatMs: 20 });
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/`;
}

beforeEach(async () => {
  postsDir = await mkdtemp(join(tmpdir(), "collabtron-"));
  for (const id of ["lorem-ipsum", "other-post"]) {
    await mkdir(join(postsDir, id));
    await writeFile(join(postsDir, id, "index.md"), "---\ntitle: Lorem\n---\n\nIpsum\n");
  }
  await start();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await server.close();
  await rm(postsDir, { recursive: true, force: true });
});

function open(postId = "lorem-ipsum", options?: ConstructorParameters<typeof WebSocket>[1]) {
  const socket = new WebSocket(url + postId, options);
  sockets.push(socket);
  return socket;
}

const until = (done: () => boolean) => expect.poll(done, { timeout: 2000, interval: 5 }).toBe(true);

// A raw client: every message the Server sent, in order.
async function raw(postId?: string) {
  const socket = open(postId);
  const messages: any[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "heartbeat") messages.push(message);
  });
  await until(() => messages.length > 0);
  return { socket, messages, send: (message: unknown) => socket.send(JSON.stringify(message)) };
}

// A headless Collaborator: real prosemirror-collab state, no DOM.
async function join_() {
  let editor: Editor | undefined;
  const push = syncWithAuthority(open(), (doc, version) => {
    editor = {
      state: EditorState.create({ doc, plugins: [history(), collab({ version })] }),
      dispatch(tr) {
        this.state = this.state.apply(tr);
        push();
      },
    };
    return editor;
  });
  await until(() => !!editor);
  const client = editor!;
  return {
    get markdown() {
      return serialize(client.state.doc);
    },
    // Types at the start (or end) of the last paragraph.
    type(text: string, where: "start" | "end" = "end") {
      const end = client.state.doc.content.size - 1;
      client.dispatch(client.state.tr.insertText(text, where === "end" ? end : end - client.state.doc.lastChild!.content.size));
    },
    undo: () => undo(client.state, (tr) => client.dispatch(tr)),
  };
}

const converged = (clients: { markdown: string }[], markdown: string) => until(() => clients.every((client) => client.markdown === markdown));

test("typing by one Collaborator appears for the other", async () => {
  const [a, b] = [await join_(), await join_()];

  a.type(" dolor");

  await converged([a, b], "---\ntitle: Lorem\n---\n\nIpsum dolor\n");
});

test("concurrent edits in the same paragraph converge without loss", async () => {
  const clients = [await join_(), await join_(), await join_()];

  // All typed before any answer from the Authority: two of the three are based on a stale Version.
  clients[0].type("A", "start");
  clients[1].type("B", "end");
  clients[2].type("C", "end");
  clients[0].type("a", "start");
  clients[1].type("b", "end");

  await until(() => clients.every((client) => client.markdown === clients[0].markdown && client.markdown.length === "---\ntitle: Lorem\n---\n\nIpsum\n".length + 5));
  const paragraph = clients[0].markdown.split("\n").at(-2)!;
  expect(paragraph).toMatch(/^aAIpsum[BbC]{3}$/);
  expect(paragraph).toContain("Bb");
  // A late Collaborator gets the converged document, not the Post file.
  expect((await join_()).markdown).toBe(clients[0].markdown);
});

const insert = (text: string) => ({ stepType: "replace", from: 15, to: 15, slice: { content: [{ type: "text", text }] } });

test("Steps on a stale Version are rejected with the missing Steps", async () => {
  const [a, b, late] = [await raw(), await raw(), await join_()];
  expect(a.messages).toMatchObject([{ type: "init", version: 0 }]);

  a.send({ type: "steps", version: 0, steps: [insert("x")], clientID: "a" });
  await until(() => b.messages.length === 2);
  b.send({ type: "steps", version: 0, steps: [insert("y")], clientID: "b" });
  await until(() => b.messages.length === 3);

  const accepted = { type: "steps", version: 0, steps: [insert("x")], clientIDs: ["a"] };
  // Broadcast of a's Steps, then the rejection: the Steps b was missing.
  expect(b.messages.slice(1)).toEqual([accepted, accepted]);
  expect(a.messages.slice(1)).toEqual([accepted]);
  expect((await raw()).messages).toMatchObject([{ type: "init", version: 1 }]);
  await converged([late], "---\ntitle: Lorem\n---\n\nxIpsum\n");
});

test("Steps that do not apply close the socket and change nothing", async () => {
  for (const message of [
    { type: "steps", version: 0, steps: [insert("x"), { ...insert("y"), from: 999, to: 999 }], clientID: "a" },
    { type: "steps", version: 7, steps: [], clientID: "a" },
    { type: "steps", version: 0, steps: [insert("x")] },
    "nonsense",
  ]) {
    const client = await raw();
    client.send(message);
    await until(() => client.socket.readyState === WebSocket.CLOSED);
  }

  expect((await raw()).messages).toMatchObject([{ type: "init", version: 0 }]);
  expect((await join_()).markdown).toBe("---\ntitle: Lorem\n---\n\nIpsum\n");
});

test("undo reverts only the local Collaborator's Steps", async () => {
  const [a, b] = [await join_(), await join_()];
  a.type(" mine");
  await converged([a, b], "---\ntitle: Lorem\n---\n\nIpsum mine\n");
  b.type("Theirs ", "start");
  await converged([a, b], "---\ntitle: Lorem\n---\n\nTheirs Ipsum mine\n");

  a.undo();

  await converged([a, b], "---\ntitle: Lorem\n---\n\nTheirs Ipsum\n");
});

test("each Server start has its own instance ID, sent to every client", async () => {
  const [first, second] = [await raw(), await raw()];
  expect(first.messages[0].instance).toMatch(/\S{16,}/);
  expect(second.messages[0].instance).toBe(first.messages[0].instance);

  await server.close();
  await start();

  expect((await raw()).messages[0].instance).not.toBe(first.messages[0].instance);
});

test("the Server sends a heartbeat on its interval", async () => {
  let heartbeats = 0;
  open().addEventListener("message", (event) => {
    if (JSON.parse(event.data).type === "heartbeat") heartbeats++;
  });

  await until(() => heartbeats >= 2);
});

test("refuses a Post ID outside the Post Catalog and a page from another origin", async () => {
  const refused = [open("other-post"), open("missing"), open("lorem-ipsum", { headers: { origin: "http://evil.example" } } as never)];
  const opened: WebSocket[] = [];
  for (const socket of refused) socket.addEventListener("open", () => opened.push(socket));

  await until(() => refused.every((socket) => socket.readyState === WebSocket.CLOSED));
  expect(opened).toEqual([]);
  // The editor's own page is let in.
  const own = open("lorem-ipsum", { headers: { origin: url.replace("ws:", "http:").slice(0, -"/ws/".length) } } as never);
  await until(() => own.readyState === WebSocket.OPEN);
});
