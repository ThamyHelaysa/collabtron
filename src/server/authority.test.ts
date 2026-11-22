// Seam 2: the Server as a black box over WebSocket, driven by headless clients running the browser's own sync code.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
async function collaborator() {
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
