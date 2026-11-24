// Seam 2: the Server as a black box over WebSocket, driven by headless clients running the browser's own sync code.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collab } from "prosemirror-collab";
import { history, undo } from "prosemirror-history";
import { EditorState, TextSelection } from "prosemirror-state";
import { presence, presenceKey, type Presence } from "../client/presence.ts";
import { syncWithAuthority, type Editor, type Store } from "../client/sync.ts";
import { colors } from "../shared/collaborator.ts";
import { serialize } from "../shared/markdown.ts";
import { createPostCatalog } from "./post-catalog.ts";
import { startServer } from "./server.ts";

let postsDir: string;
let url: string;
let server: Awaited<ReturnType<typeof startServer>>;
const sockets: WebSocket[] = [];
const collaborators: { leave(): void }[] = [];

async function start(options: Partial<Parameters<typeof startServer>[0]> = {}) {
  const catalog = await createPostCatalog(postsDir, ["lorem-ipsum"]);
  server = await startServer({ host: "127.0.0.1", port: 0, catalog, heartbeatMs: 20, saveAfterMs: 20, saveEveryMs: 200, ...options });
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
  vi.restoreAllMocks();
  // Before the Server closes: a Collaborator whose connection drops tries again.
  for (const client of collaborators.splice(0)) client.leave();
  for (const socket of sockets.splice(0)) socket.close();
  await server.close();
  await rm(postsDir, { recursive: true, force: true });
});

function track(socket: WebSocket) {
  sockets.push(socket);
  return socket;
}

// A socket that opens with a token, as the editor's does: the Share Link's own by default, none with `null`.
function open(postId = "lorem-ipsum", token: string | null = server.token) {
  const socket = track(new WebSocket(url + postId));
  if (token !== null) socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })));
  return socket;
}

const until = (done: () => boolean) => expect.poll(done, { timeout: 2000, interval: 5 }).toBe(true);

// A raw client: every message the Server sent, in order, with Presence apart.
async function raw(postId?: string) {
  const socket = open(postId);
  const messages: any[] = [];
  const presence: any[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "presence") presence.push(message);
    else if (message.type !== "heartbeat") messages.push(message);
  });
  await until(() => messages.length > 0);
  return { socket, messages, presence, send: (message: unknown) => socket.send(JSON.stringify(message)) };
}

// A tab's storage for one Post, kept across reloads.
const tabStorage = (): Store => {
  let kept: string | null = null;
  return { load: () => kept, save: (value) => void (kept = value) };
};

// A headless Collaborator: real prosemirror-collab state, no DOM. It reaches the Server at `via` (the Server itself by default).
async function collaborator(name = "Ana", color = 0, { via, store = tabStorage() }: { via?: string; store?: Store } = {}) {
  let editor: Editor | undefined;
  // What it was offered back, as Markdown.
  const recovered: string[] = [];
  // The close code of each of its sockets.
  const closes: number[] = [];
  const sync = syncWithAuthority({
    connect() {
      const socket = via ? track(new WebSocket(via + "lorem-ipsum")) : open("lorem-ipsum", null);
      socket.addEventListener("close", (event) => closes.push(event.code));
      return socket;
    },
    token: server.token,
    me: { name, color },
    store,
    open: (doc, version, clientID) => {
      editor = {
        state: EditorState.create({ doc, plugins: [history(), collab({ version, clientID }), presence] }),
        dispatch(tr) {
          this.state = this.state.apply(tr);
          sync.push();
        },
      };
      return editor;
    },
    recover: (doc) => recovered.push(serialize(doc)),
  });
  await until(() => !!editor);
  const client = {
    get markdown() {
      return serialize(editor!.state.doc);
    },
    recovered,
    closes,
    // Types at the start (or end) of the last paragraph.
    type(text: string, where: "start" | "end" = "end") {
      const end = editor!.state.doc.content.size - 1;
      editor!.dispatch(editor!.state.tr.insertText(text, where === "end" ? end : end - editor!.state.doc.lastChild!.content.size));
    },
    undo: () => undo(editor!.state, (tr) => editor!.dispatch(tr)),
    select: (anchor: number, head: number) => editor!.dispatch(editor!.state.tr.setSelection(TextSelection.create(editor!.state.doc, anchor, head))),
    // The other Collaborators, where this one sees them.
    get others() {
      return [...presenceKey.getState(editor!.state)!.values()];
    },
    // Closes the tab.
    leave: sync.stop,
  };
  collaborators.push(client);
  return client;
}

// Stands between a client and the Server, so a test can cut the connection as a network would, with no closing handshake.
async function relay() {
  const port = (server.address() as AddressInfo).port;
  const lines = new Set<[client: Socket, upstream: Socket]>();
  const relay = createServer((client) => {
    const upstream = connect(port, "127.0.0.1");
    lines.add([client, upstream]);
    for (const end of [client, upstream]) {
      end.on("error", () => {});
      end.on("close", () => (client.destroy(), upstream.destroy()));
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const address = relay.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}/ws/`,
    // The Server still hears its clients, they no longer hear it.
    mute() {
      for (const [client, upstream] of lines) upstream.unpipe(client);
    },
    cut() {
      for (const line of lines) for (const end of line) end.destroy();
      lines.clear();
    },
    // Takes no new connection; the ones open end with their clients.
    close: () => void relay.close(),
    // Takes new connections again, at the same address.
    reopen: () => new Promise<void>((resolve) => relay.listen(address.port, "127.0.0.1", resolve)),
  };
}

const converged = (clients: { markdown: string }[], markdown: string) => until(() => clients.every((client) => client.markdown === markdown));
const postFile = () => readFile(join(postsDir, "lorem-ipsum", "index.md"), "utf8");
const saved = (markdown: string) => expect.poll(postFile, { timeout: 2000, interval: 5 }).toBe(markdown);

test("typing by one Collaborator appears for the other", async () => {
  const [a, b] = [await collaborator(), await collaborator()];

  a.type(" dolor");

  await converged([a, b], "---\ntitle: Lorem\n---\n\nIpsum dolor\n");
});

test("concurrent edits in the same paragraph converge without loss", async () => {
  const clients = [await collaborator(), await collaborator(), await collaborator()];

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
  expect((await collaborator()).markdown).toBe(clients[0].markdown);
});

const insert = (text: string) => ({ stepType: "replace", from: 15, to: 15, slice: { content: [{ type: "text", text }] } });

test("Steps on a stale Version are rejected with the missing Steps", async () => {
  const [a, b, late] = [await raw(), await raw(), await collaborator()];
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
    { type: "steps", version: 7, steps: [insert("x")], clientID: "a" },
    { type: "steps", version: 0, steps: [], clientID: "a" },
    // Valid for the schema, but it deletes the Front Matter Block.
    { type: "steps", version: 0, steps: [{ stepType: "replace", from: 0, to: 14 }], clientID: "a" },
    { type: "steps", version: 0, steps: [insert("x")] },
    { type: "catch-up", version: 7 },
    { type: "catch-up" },
    "nonsense",
  ]) {
    const client = await raw();
    client.send(message);
    await until(() => client.socket.readyState === WebSocket.CLOSED);
  }

  expect((await raw()).messages).toMatchObject([{ type: "init", version: 0 }]);
  expect((await collaborator()).markdown).toBe("---\ntitle: Lorem\n---\n\nIpsum\n");
});

test("a Post nobody has open is read from the Post file again", async () => {
  const first = await collaborator();
  first.type(" saved");
  await converged([first, await collaborator()], "---\ntitle: Lorem\n---\n\nIpsum saved\n");
  await saved("---\ntitle: Lorem\n---\n\nIpsum saved\n");
  const observer = await raw();
  expect(observer.messages[0]).toMatchObject({ type: "init", version: 1 });

  for (const socket of sockets.splice(0)) socket.close();
  await writeFile(join(postsDir, "lorem-ipsum", "index.md"), "Changed on disk\n");

  // The closes may still be on their way to the Server: until then a newcomer joins the old Editing Session.
  await expect
    .poll(async () => {
      const newcomer = await raw();
      newcomer.socket.close();
      return newcomer.messages[0].version;
    })
    .toBe(0);
  expect((await collaborator()).markdown).toBe("Changed on disk\n");
});

test("undo reverts only the local Collaborator's Steps", async () => {
  const [a, b] = [await collaborator(), await collaborator()];
  a.type(" mine");
  await converged([a, b], "---\ntitle: Lorem\n---\n\nIpsum mine\n");
  b.type("Theirs ", "start");
  await converged([a, b], "---\ntitle: Lorem\n---\n\nTheirs Ipsum mine\n");

  a.undo();

  await converged([a, b], "---\ntitle: Lorem\n---\n\nTheirs Ipsum\n");
});

test("each Editing Session has its own instance ID, sent to every client, and a Server restart starts a new one", async () => {
  const [first, second] = [await raw(), await raw()];
  expect(first.messages[0].instance).toMatch(/\S{16,}/);
  expect(second.messages[0].instance).toBe(first.messages[0].instance);

  // Its Authority, Step log included, goes with the last Collaborator: Versions from it mean nothing to the next one.
  for (const socket of sockets.splice(0)) socket.close();
  await expect
    .poll(async () => {
      const newcomer = await raw();
      newcomer.socket.close();
      return newcomer.messages[0].instance;
    })
    .not.toBe(first.messages[0].instance);

  const third = await raw();
  await server.close();
  await start();

  expect((await raw()).messages[0].instance).not.toBe(third.messages[0].instance);
});

test("a Collaborator cut off while its Editing Session ends is offered back what it typed meanwhile, and follows the Post file", async () => {
  const line = await relay();
  const [a, b] = [await collaborator("Ana", 0, { via: line.url }), await collaborator("Bia", 1)];
  a.type(" dolor");
  await saved("---\ntitle: Lorem\n---\n\nIpsum dolor\n");
  const { instance } = (await raw()).messages[0];

  line.close();
  line.cut();
  a.type(" amet");
  b.leave();
  for (const socket of sockets.splice(0)) socket.close();
  // The closes may still be on their way to the Server: until then a newcomer joins the old Editing Session.
  await expect
    .poll(async () => {
      const newcomer = await raw();
      newcomer.socket.close();
      return newcomer.messages[0].instance;
    })
    .not.toBe(instance);
  const c = await collaborator("Cleo", 2);
  await line.reopen();

  await until(() => a.recovered.length === 1);
  expect(a.recovered).toEqual(["---\ntitle: Lorem\n---\n\nIpsum dolor amet\n"]);
  // Its unconfirmed Steps are gone: they belonged to the old Authority.
  await converged([a, c], "---\ntitle: Lorem\n---\n\nIpsum dolor\n");
  a.type(" sit");
  await converged([a, c], "---\ntitle: Lorem\n---\n\nIpsum dolor sit\n");
  // c lost nothing, so it is offered nothing.
  expect(c.recovered).toEqual([]);
  line.close();
});

test("after a Server restart, a tab with the Share Link from before is refused; opened with the new one, it is offered back what it typed while the Server was down", async () => {
  const store = tabStorage();
  const [a, b] = [await collaborator("Ana", 0, { store }), await collaborator("Bia", 1)];
  a.type(" dolor");
  await saved("---\ntitle: Lorem\n---\n\nIpsum dolor\n");

  await server.close();
  a.type(" amet");
  await start();

  // Both try again on their own, with the token of the Server that stopped.
  await until(() => a.closes.includes(4003) && b.closes.includes(4003));
  a.leave();
  const again = await collaborator("Ana", 0, { store });
  const other = await collaborator("Bia", 1);

  expect(again.recovered).toEqual(["---\ntitle: Lorem\n---\n\nIpsum dolor amet\n"]);
  await converged([again, other], "---\ntitle: Lorem\n---\n\nIpsum dolor\n");
  again.type(" sit");
  await converged([again, other], "---\ntitle: Lorem\n---\n\nIpsum dolor sit\n");
  expect(other.recovered).toEqual([]);
});

test("a Collaborator whose connection drops sends what it typed meanwhile once it is back, over what the others typed", async () => {
  const line = await relay();
  const [a, b] = [await collaborator("Ana", 0, { via: line.url }), await collaborator("Bia", 1)];
  a.type(" dolor");
  await converged([a, b], "---\ntitle: Lorem\n---\n\nIpsum dolor\n");

  line.cut();
  b.type("Lorem ", "start");
  a.type(" amet");

  await converged([a, b], "---\ntitle: Lorem\n---\n\nLorem Ipsum dolor amet\n");
  expect(a.recovered).toEqual([]);
  // Each sees the other again. The Presence sent to a on joining was at a Version a had not caught up to.
  await until(() => a.others.length === 1 && b.others.length === 1);
  expect([a.others, b.others]).toEqual([[expect.objectContaining({ name: "Bia" })], [expect.objectContaining({ name: "Ana" })]]);
  line.close();
});

test("a Collaborator who closes the tab while cut off sends what it typed once the tab is open again", async () => {
  const line = await relay();
  const store = tabStorage();
  const [a, b] = [await collaborator("Ana", 0, { via: line.url, store }), await collaborator("Bia", 1)];
  a.type(" dolor");
  await converged([a, b], "---\ntitle: Lorem\n---\n\nIpsum dolor\n");

  line.close();
  line.cut();
  b.type("Lorem ", "start");
  a.type(" amet");
  a.leave();
  const again = await collaborator("Ana", 0, { store });

  await converged([again, b], "---\ntitle: Lorem\n---\n\nLorem Ipsum dolor amet\n");
  expect(again.recovered).toEqual([]);
});

test("Steps the Authority accepted just before the tab closed are not sent again when it is open again", async () => {
  const line = await relay();
  const store = tabStorage();
  const [a, b] = [await collaborator("Ana", 0, { via: line.url, store }), await collaborator("Bia", 1)];

  line.mute();
  a.type(" dolor");
  // Accepted, but a never hears it: they are still unconfirmed when the tab closes.
  await converged([b], "---\ntitle: Lorem\n---\n\nIpsum dolor\n");
  line.close();
  line.cut();
  a.leave();
  const again = await collaborator("Ana", 0, { store });
  b.type("!");

  await converged([again, b], "---\ntitle: Lorem\n---\n\nIpsum dolor!\n");
});

test("a Collaborator who closes the tab while the Server is down is offered what it typed when the tab is open again", async () => {
  const store = tabStorage();
  const a = await collaborator("Ana", 0, { store });

  await server.close();
  a.type(" amet");
  a.leave();
  await start();
  const again = await collaborator("Ana", 0, { store });

  expect(again.recovered).toEqual(["---\ntitle: Lorem\n---\n\nIpsum amet\n"]);
  expect(again.markdown).toBe("---\ntitle: Lorem\n---\n\nIpsum\n");
});

test("a socket must open with the Share Link's token: with another, or none, it is closed before anything of the Post is sent", async () => {
  const messages: string[] = [];
  const refused = [open("lorem-ipsum", "x".repeat(server.token.length)), open("lorem-ipsum", "wrong"), open("lorem-ipsum", "é".repeat(server.token.length)), open("lorem-ipsum", null)];
  refused[3].addEventListener("open", () => refused[3].send(JSON.stringify({ type: "catch-up", version: 0 })));
  for (const socket of refused) socket.addEventListener("message", (event) => messages.push(event.data));

  await until(() => refused.every((socket) => socket.readyState === WebSocket.CLOSED));
  expect(messages.filter((message) => !message.includes("heartbeat"))).toEqual([]);
  expect((await raw()).messages).toMatchObject([{ type: "init", version: 0 }]);
});

test("the Server sends a heartbeat on its interval", async () => {
  let heartbeats = 0;
  open().addEventListener("message", (event) => {
    if (JSON.parse(event.data).type === "heartbeat") heartbeats++;
  });

  await until(() => heartbeats >= 2);
});

test("refuses a Post ID outside the Post Catalog, even with the token", async () => {
  const refused = [open("other-post"), open("missing")];
  const opened: WebSocket[] = [];
  for (const socket of refused) socket.addEventListener("open", () => opened.push(socket));

  await until(() => refused.every((socket) => socket.readyState === WebSocket.CLOSED));
  expect(opened).toEqual([]);
});

test("the Server saves the converged document to the Post file", async () => {
  const [a, b] = [await collaborator(), await collaborator()];

  a.type(" çã 🙂");
  b.type("Novo ", "start");

  await converged([a, b], "---\ntitle: Lorem\n---\n\nNovo Ipsum çã 🙂\n");
  await saved("---\ntitle: Lorem\n---\n\nNovo Ipsum çã 🙂\n");
});

test("the Server saves saveAfterMs after the last accepted Step, not the first", async () => {
  await server.close();
  await start({ saveAfterMs: 500, saveEveryMs: 60_000 });
  const a = await collaborator();

  for (let i = 0; i < 10; i++) {
    a.type("x");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // 1 s after the first Step, 100 ms after the last.
  expect(await postFile()).toBe("---\ntitle: Lorem\n---\n\nIpsum\n");
  await saved("---\ntitle: Lorem\n---\n\nIpsumxxxxxxxxxx\n");
});

test("the Server saves at most saveEveryMs apart during continuous typing", async () => {
  await server.close();
  await start({ saveAfterMs: 200, saveEveryMs: 300 });
  const a = await collaborator();

  // A Step every 20 ms never leaves the 200 ms pause that would save: only the 300 ms ceiling does.
  const typing = setInterval(() => a.type("x"), 20);
  try {
    await expect.poll(postFile, { timeout: 2000, interval: 5 }).not.toBe("---\ntitle: Lorem\n---\n\nIpsum\n");
  } finally {
    clearInterval(typing);
  }
  await saved(a.markdown);
});

test("the Server refuses to save over a change made outside the editor, and warns in the UI and the terminal", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const [a, watcher] = [await collaborator(), await raw()];
  a.type(" dolor");
  await saved("---\ntitle: Lorem\n---\n\nIpsum dolor\n");

  await writeFile(join(postsDir, "lorem-ipsum", "index.md"), "Changed outside\n");
  a.type(" amet");

  const refused = { type: "save", error: expect.stringContaining("changed outside the editor") };
  await until(() => watcher.messages.at(-1)?.type === "save" && !!watcher.messages.at(-1).error);
  expect(watcher.messages.filter((message) => message.type === "save")).toEqual([{ type: "save" }, refused]);
  expect(await postFile()).toBe("Changed outside\n");
  expect(await readdir(join(postsDir, "lorem-ipsum"))).toEqual(["index.md"]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(join(postsDir, "lorem-ipsum", "index.md")));
  // A Collaborator who joins later is warned too.
  const late = await raw();
  await until(() => late.messages.length === 2);
  expect(late.messages[1]).toEqual(refused);
});

test("the Server saves what is pending when the last Collaborator leaves, not before", async () => {
  await server.close();
  await start({ saveAfterMs: 60_000, saveEveryMs: 60_000 });
  const [a, b] = [await collaborator(), await collaborator()];
  a.type(" dolor");
  await converged([a, b], "---\ntitle: Lorem\n---\n\nIpsum dolor\n");
  expect(await postFile()).toBe("---\ntitle: Lorem\n---\n\nIpsum\n");

  for (const socket of sockets.splice(0)) socket.close();

  await saved("---\ntitle: Lorem\n---\n\nIpsum dolor\n");
});

test("the Server saves what is pending before it closes", async () => {
  await server.close();
  await start({ saveAfterMs: 60_000, saveEveryMs: 60_000 });
  const [a, b] = [await collaborator(), await collaborator()];
  a.type(" dolor");
  await converged([a, b], "---\ntitle: Lorem\n---\n\nIpsum dolor\n");

  await server.close();

  expect(await postFile()).toBe("---\ntitle: Lorem\n---\n\nIpsum dolor\n");
  await start();
});

test("a save that failed is tried again when the Editing Session ends", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const file = join(postsDir, "lorem-ipsum", "index.md");
  const [a, watcher] = [await collaborator(), await raw()];
  // Made read-only by its owner: replacing it by rename would get past that.
  await chmod(file, 0o444);

  a.type(" dolor");
  await until(() => watcher.messages.at(-1)?.error === "The Server could not save the Post file.");
  expect(await postFile()).toBe("---\ntitle: Lorem\n---\n\nIpsum\n");
  await chmod(file, 0o644);
  for (const socket of sockets.splice(0)) socket.close();

  await saved("---\ntitle: Lorem\n---\n\nIpsum dolor\n");
});

test("saving keeps the Post file's permissions and a symlink to it, and leaves no other file beside it", async () => {
  const folder = join(postsDir, "lorem-ipsum");
  const target = join(postsDir, "kept-elsewhere.md");
  await rename(join(folder, "index.md"), target);
  await symlink(target, join(folder, "index.md"));
  await chmod(target, 0o640);
  const a = await collaborator();

  a.type(" dolor");
  await saved("---\ntitle: Lorem\n---\n\nIpsum dolor\n");

  expect((await lstat(join(folder, "index.md"))).isSymbolicLink()).toBe(true);
  expect((await stat(target)).mode & 0o777).toBe(0o640);
  expect(await readdir(folder)).toEqual(["index.md"]);
});

test("a Collaborator who leaves while the Post is still loading does not keep its Editing Session open", async () => {
  const file = join(postsDir, "lorem-ipsum", "index.md");
  await rm(file);
  // A named pipe: the Server's read of the Post file waits until the test writes into it.
  execFileSync("mkfifo", [file]);
  try {
    const leaving = open();
    await new Promise((resolve) => leaving.addEventListener("open", resolve));
    leaving.close();
    await until(() => leaving.readyState === WebSocket.CLOSED);
  } finally {
    // Always ends the Server's read, or closing the Server would wait on it.
    await writeFile(file, "Loaded after its Collaborator left\n");
  }
  await rm(file);
  await writeFile(file, "Changed on disk\n");
  // shortcut: a fixed wait for the Server to finish that read, can fail on a very slow machine (never pass wrongly), upgrade if CI trips on it.
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect((await collaborator()).markdown).toBe("Changed on disk\n");
});

test("a save whose folder cannot be synced to disk does not stop saving", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const folder = join(postsDir, "lorem-ipsum");
  const a = await collaborator();
  // Files can be made in it, but it cannot be opened to sync it.
  await chmod(folder, 0o333);
  try {
    a.type(" dolor");
    await saved("---\ntitle: Lorem\n---\n\nIpsum dolor\n");
    a.type(" amet");
    await saved("---\ntitle: Lorem\n---\n\nIpsum dolor amet\n");
  } finally {
    await chmod(folder, 0o755);
  }
});

const presenceMessage = (version: number, anchor: number, head: number) => ({ type: "presence", version, anchor, head, name: "Ana", color: 0 });

test("Presence is relayed to the other Collaborators and never enters the Step log", async () => {
  const [a, b] = [await raw(), await raw()];

  a.send(presenceMessage(0, 15, 20));
  await until(() => b.presence.length === 1);
  const relayed = { ...presenceMessage(0, 15, 20), id: expect.any(Number) };
  expect(b.presence).toEqual([relayed]);
  a.send({ type: "steps", version: 0, steps: [insert("x")], clientID: "a" });
  await until(() => a.messages.length === 2);
  // Not sent back: it would have come before the sender's Steps.
  expect(a.presence).toEqual([]);
  // The Version counts the Step alone, and a newcomer is told where the others are.
  const late = await raw();
  expect(late.messages[0]).toMatchObject({ type: "init", version: 1 });
  await until(() => late.presence.length === 1);
  expect(late.presence).toEqual([{ ...relayed, version: 1, anchor: 16, head: 21 }]);
});

test("Presence that is not valid closes the socket and is not relayed", async () => {
  const watcher = await raw();
  for (const message of [
    // A colour is a number into the palette, never CSS.
    { ...presenceMessage(0, 15, 20), color: "#aa3300" },
    { ...presenceMessage(0, 15, 20), color: "red; background: url(x)" },
    { ...presenceMessage(0, 15, 20), color: "1" },
    { ...presenceMessage(0, 15, 20), color: 1.5 },
    { ...presenceMessage(0, 15, 20), color: -1 },
    { ...presenceMessage(0, 15, 20), color: colors.length },
    { ...presenceMessage(0, 15, 20), name: 7 },
    { ...presenceMessage(0, 15, 20), name: "" },
    { ...presenceMessage(0, 15, 20), name: " Ana" },
    { ...presenceMessage(0, 15, 20), name: "a".repeat(51) },
    { ...presenceMessage(0, 15, 20), name: "Ana\nBia" },
    // Right-to-left override and zero-width space: they hide or reorder what the others read.
    { ...presenceMessage(0, 15, 20), name: "\u202eanA" },
    { ...presenceMessage(0, 15, 20), name: "A\u200bna" },
    { ...presenceMessage(0, 15, 1.5) },
    { ...presenceMessage(0, 15, 999) },
    { ...presenceMessage(0, -1, 15) },
    { ...presenceMessage(7, 15, 15) },
  ]) {
    const client = await raw();
    client.send(message);
    await until(() => client.socket.readyState === WebSocket.CLOSED);
  }

  expect(watcher.presence).toEqual([]);
  // The limits themselves pass: 50 characters counted in code points, not UTF-16 units, and the last colour.
  const longest = await raw();
  longest.send({ ...presenceMessage(0, 15, 20), name: "Çã 🙂".repeat(10), color: colors.length - 1 });
  await until(() => watcher.presence.length === 1);
  expect(watcher.presence[0]).toMatchObject({ name: "Çã 🙂".repeat(10), color: colors.length - 1 });
});

test("the others are told when a Collaborator leaves, and a newcomer never hears of them", async () => {
  const [a, b] = [await raw(), await raw()];
  a.send(presenceMessage(0, 15, 20));
  await until(() => b.presence.length === 1);

  a.socket.close();

  await until(() => b.presence.length === 2);
  expect(b.presence[1]).toEqual({ type: "presence", id: b.presence[0].id, left: true });
  const late = await raw();
  late.send({ type: "steps", version: 0, steps: [insert("x")], clientID: "late" });
  await until(() => late.messages.length === 2);
  expect(late.presence).toEqual([]);
});

test("each Collaborator sees where the others are, once their Steps are confirmed", async () => {
  const [a, b] = [await collaborator("Ana", 0), await collaborator("Bia", 1)];
  await until(() => a.others.length === 1 && b.others.length === 1);
  expect(a.others).toEqual([expect.objectContaining({ name: "Bia", color: 1 })]);

  a.select(15, 20);
  await until(() => b.others[0].head === 20);
  expect(b.others).toEqual([{ name: "Ana", color: 0, anchor: 15, head: 20 }]);
  // `insertText` at a position collapses the selection: Ana's cursor ends after the new text.
  a.type("!");
  await until(() => b.others[0].anchor === 21);
  expect(b.others).toEqual([{ name: "Ana", color: 0, anchor: 21, head: 21 }]);

  a.leave();
  await until(() => b.others.length === 0);
});

test("the others' Presence follows remote edits", async () => {
  // A raw client sends its Presence once: after that, only mapping moves it.
  const a = await raw();
  const [b, c] = [await collaborator("Bia"), await collaborator("Caio")];
  const ana = (client: { others: Presence[] }) => client.others.find((other) => other.name === "Ana");

  a.send(presenceMessage(0, 16, 18));
  // Most likely still unconfirmed when Ana's Presence reaches b: it lands on the same text either way.
  b.type("XY", "start");
  await until(() => [b, c].every((client) => ana(client)?.anchor === 18));
  expect([ana(b), ana(c)]).toMatchObject([{ anchor: 18, head: 20 }, { anchor: 18, head: 20 }]);
  b.type("Z", "start");
  // At once, before the Authority answers.
  expect(ana(b)).toMatchObject({ anchor: 19, head: 21 });
  await until(() => ana(c)?.anchor === 19);
  expect(ana(c)).toMatchObject({ anchor: 19, head: 21 });
  // A newcomer gets it from the Authority, mapped over every Step since.
  const d = await collaborator("Davi");
  await until(() => !!ana(d));
  expect(ana(d)).toMatchObject({ anchor: 19, head: 21 });
});

test("a Collaborator whose selection only moved with the others' edits sends no Presence for it", async () => {
  const [a, b] = [await collaborator("Ana"), await collaborator("Bia")];
  b.select(20, 20);
  const watcher = await raw();
  const bia = () => watcher.presence.filter((message) => message.name === "Bia").map((message) => message.head);
  await until(() => bia().at(-1) === 20);

  a.type("x", "start");
  a.type("y", "start");
  await converged([a, b], "---\ntitle: Lorem\n---\n\nyxIpsum\n");
  // Sent on b's own socket after anything b sent while a typed.
  b.select(15, 15);

  await until(() => bia().at(-1) === 15);
  expect(bia().slice(-2)).toEqual([20, 15]);
});
