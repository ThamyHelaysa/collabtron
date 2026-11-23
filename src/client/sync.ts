import { getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";
import type { Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { Step } from "prosemirror-transform";
import type { Collaborator } from "../shared/collaborator.ts";
import { schema } from "../shared/markdown.ts";
import { presenceKey, type PresenceUpdate } from "./presence.ts";

// What sync needs from an editor; an EditorView is one, a bare state holder in tests is another.
export type Editor = { state: EditorState; dispatch(tr: Transaction): void };

// Keeps an editor in step with the Post's Authority over `socket`, and shows `me` to the other Collaborators.
// `open` builds the editor from the Authority's document; its state must carry `collab({ version })` and `presence`.
// Returns `push`: call it after every local transaction to send unconfirmed Steps, then this Collaborator's Presence.
export function syncWithAuthority(socket: WebSocket, me: Collaborator, open: (doc: Node, version: number) => Editor) {
  let editor: Editor | undefined;
  // One batch at a time: the Authority answers every batch, with our Steps accepted or with the ones we missed.
  let awaitingAnswer = false;
  let sentAs: unknown;
  // Our last Presence, in our document: remote Steps move it with our selection.
  let sent: { anchor: number; head: number } | undefined;

  const push = () => {
    if (!editor || awaitingAnswer || socket.readyState !== WebSocket.OPEN) return;
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
    sentAs = sendable.clientID;
    socket.send(JSON.stringify({ type: "steps", version: sendable.version, steps: sendable.steps.map((step) => step.toJSON()), clientID: sendable.clientID }));
  };

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "init") {
      editor = open(schema.nodeFromJSON(message.doc), message.version);
      push();
    } else if (message.type === "steps" && editor) {
      const known = getVersion(editor.state) - message.version;
      const isNews = known >= 0 && known < message.steps.length;
      // The answer to our batch is our own Steps accepted, or a rejection. A rejection brings nothing new:
      // the Steps we missed were broadcast when accepted, before the Authority got to our batch.
      if (!isNews || message.clientIDs.includes(sentAs)) awaitingAnswer = false;
      if (isNews) {
        const steps = message.steps.slice(known).map((json: unknown) => Step.fromJSON(schema, json));
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
  });

  return push;
}
