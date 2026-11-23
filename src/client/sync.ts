import { getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";
import type { Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { Step, Transform } from "prosemirror-transform";
import type { Collaborator } from "../shared/collaborator.ts";
import { schema, serialize } from "../shared/markdown.ts";
import { presenceKey, type PresenceUpdate } from "./presence.ts";

// What sync needs from an editor; an EditorView is one, a bare state holder in tests is another.
export type Editor = { state: EditorState; dispatch(tr: Transaction): void };
// Where a tab keeps, for one Post, what it would lose with its connection or a reload.
export type Store = { load(): string | null; save(value: string): void };

const reconnectMs = 1000;

// Keeps an editor in step with the Post's Authority, over a socket from `connect` and a new one each time it drops,
// and shows `me` to the other Collaborators (ADR 0008).
// `open` builds the editor; its state must carry `collab({ version, clientID })` and `presence`. It is called again, for a
// new editor, when the Authority is a new one: what this tab had and the new document lacks is then given to `recover`.
// Returns `push`: call it after every transaction to keep and send unconfirmed Steps, then this Collaborator's Presence.
export function syncWithAuthority({
  connect,
  me,
  store,
  open,
  recover,
}: {
  connect: () => WebSocket;
  me: Collaborator;
  store: Store;
  open: (doc: Node, version: number, clientID?: number | string) => Editor;
  recover: (doc: Node) => void;
}) {
  let socket: WebSocket;
  let editor: Editor | undefined;
  // The Editing Session our Version belongs to, and its document at our Version.
  let instance: string | undefined;
  let confirmed: Node;
  // One batch at a time: the Authority answers every batch, with our Steps accepted or with the ones we missed.
  let awaitingAnswer = false;
  let sentVersion: number | undefined;
  // Our last Presence, in our document: remote Steps move it with our selection.
  let sent: { anchor: number; head: number } | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  // After every change, so a reload or a crash loses nothing that is not on the Authority.
  const keep = () => {
    const sendable = sendableSteps(editor!.state);
    try {
      store.save(JSON.stringify({ instance, version: getVersion(editor!.state), doc: confirmed.toJSON(), steps: sendable?.steps.map((step) => step.toJSON()) ?? [], clientID: sendable?.clientID }));
    } catch (err) {
      // Storage full or blocked: sending goes on.
      console.warn("could not keep the Post in browser storage", err);
    }
  };

  // What this tab kept before a reload, if it can still be read: the Authority's document at `version` and the Steps on top.
  const load = () => {
    try {
      const { instance, version, doc, steps, clientID } = JSON.parse(store.load() ?? "null");
      const kept = { instance, version, clientID, doc: schema.nodeFromJSON(doc), steps: steps.map((json: unknown) => Step.fromJSON(schema, json)) as Step[] };
      // Throws on a Step that does not apply.
      return { ...kept, local: kept.steps.reduce((tr, step) => tr.step(step), new Transform(kept.doc)).doc };
    } catch {
      return undefined; // Nothing kept, or kept in a form this editor no longer reads.
    }
  };

  const push = () => {
    if (!editor) return;
    keep();
    if (awaitingAnswer || socket.readyState !== WebSocket.OPEN) return;
    const sendable = sendableSteps(editor.state);
    if (!sendable) {
      // Only with none of our Steps unconfirmed do our positions mean the same in the Authority's document (ADR 0007).
      const { anchor, head } = editor.state.selection;
      // Moved only by remote Steps: the others map it over the same Steps.
      if (sent?.anchor === anchor && sent.head === head) return;
      sent = { anchor, head };
      socket.send(JSON.stringify({ type: "presence", version: getVersion(editor.state), anchor, head, ...me }));
      return;
    }
    awaitingAnswer = true;
    sentVersion = sendable.version;
    socket.send(JSON.stringify({ type: "steps", version: sendable.version, steps: sendable.steps.map((step) => step.toJSON()), clientID: sendable.clientID }));
  };

  // Back on the same Authority: first the Steps we missed, and where the others are at the Version they bring us to.
  // The Presence sent on joining is at a Version we may not have reached.
  const catchUp = () => {
    awaitingAnswer = true;
    sentVersion = getVersion(editor!.state);
    socket.send(JSON.stringify({ type: "catch-up", version: sentVersion }));
  };

  const receive = (event: MessageEvent) => {
    const message = JSON.parse(event.data);
    if (message.type === "init") {
      // The answer to a batch sent on a socket that dropped never comes.
      awaitingAnswer = false;
      sent = undefined;
      // Versions only grow: a smaller one is another Authority's.
      const onSameAuthority = (kept: unknown, version: number) => kept === message.instance && version <= message.version;
      const kept = editor ? undefined : load();
      if (kept && onSameAuthority(kept.instance, kept.version) && kept.steps.length) {
        // A reload: the editor as it was. Under the same clientID, Steps the Authority accepted before the reload are known as ours when they come back.
        instance = kept.instance;
        confirmed = kept.doc;
        editor = open(kept.doc, kept.version, kept.clientID);
        catchUp();
        editor.dispatch(kept.steps.reduce((tr, step) => tr.step(step), editor.state.tr));
        return;
      }
      if (editor && onSameAuthority(instance, getVersion(editor.state))) {
        catchUp();
        // Some may have left while we were away: the catch-up brings the ones still here.
        for (const id of presenceKey.getState(editor.state)!.keys()) editor.dispatch(editor.state.tr.setMeta(presenceKey, { id }));
        return;
      }
      // A new Authority: Steps based on the old one cannot apply. The editor follows the new document, and what this tab had is offered back.
      const local = editor?.state.doc ?? (kept && !onSameAuthority(kept.instance, kept.version) ? kept.local : undefined);
      instance = message.instance;
      editor = open(schema.nodeFromJSON(message.doc), message.version);
      confirmed = editor.state.doc;
      if (local && serialize(local) !== serialize(confirmed)) recover(local);
      push();
    } else if (message.type === "steps" && editor) {
      const known = getVersion(editor.state) - message.version;
      // The answer to our batch, or to a catch-up, is the Steps from the Version we sent it at: ours accepted, or the ones we missed.
      // A broadcast from that Version is the batch that beat ours: ours, rebased over it, can go at once (ADR 0008).
      if (message.version === sentVersion) awaitingAnswer = false;
      if (known >= 0 && known < message.steps.length) {
        const steps: Step[] = message.steps.slice(known).map((json: unknown) => Step.fromJSON(schema, json));
        confirmed = steps.reduce((doc, step) => step.apply(doc).doc!, confirmed);
        // Confirms our Steps among them and rebases our unconfirmed ones over the rest.
        const tr = receiveTransaction(editor.state, steps, message.clientIDs.slice(known));
        if (sent) sent = { anchor: tr.mapping.map(sent.anchor), head: tr.mapping.map(sent.head) };
        editor.dispatch(tr);
      }
      push();
    } else if (message.type === "presence" && editor) {
      const { id, left, version, anchor, head, name, color } = message;
      let update: PresenceUpdate = { id };
      if (!left) {
        // The Authority sends positions at the Version it has sent us Steps up to: our confirmed document. Ours unconfirmed come on top.
        if (version !== getVersion(editor.state)) return;
        const unconfirmed = sendableSteps(editor.state)?.steps ?? [];
        const local = (pos: number) => unconfirmed.reduce((pos, step) => step.getMap().map(pos), pos);
        update = { id, presence: { name, color, anchor: local(anchor), head: local(head) } };
      }
      editor.dispatch(editor.state.tr.setMeta(presenceKey, update));
    }
  };

  const reconnect = () => {
    socket = connect();
    socket.addEventListener("message", receive);
    // A network drop or a stopped Server. The Server closes cleanly only on purpose, such as on an invalid message: trying again would not help.
    socket.addEventListener("close", (event) => {
      if (!event.wasClean && !stopped) retry = setTimeout(reconnect, reconnectMs);
    });
  };
  reconnect();

  return {
    push,
    // Stops following the Authority, as closing the tab would.
    stop() {
      stopped = true;
      clearTimeout(retry);
      socket.close();
    },
  };
}
