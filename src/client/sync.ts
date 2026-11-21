import { getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";
import type { Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { Step } from "prosemirror-transform";
import { schema } from "../shared/markdown.ts";

// What sync needs from an editor; an EditorView is one, a bare state holder in tests is another.
export type Editor = { state: EditorState; dispatch(tr: Transaction): void };

// Keeps an editor in step with the Post's Authority over `socket`.
// `open` builds the editor from the Authority's document; its state must carry `collab({ version })`.
// Returns `push`: call it after every local transaction to send unconfirmed Steps.
export function syncWithAuthority(socket: WebSocket, open: (doc: Node, version: number) => Editor) {
  let editor: Editor | undefined;
  // One batch at a time: the Authority answers every batch, with our Steps accepted or with the ones we missed.
  let awaitingAnswer = false;

  const push = () => {
    if (!editor || awaitingAnswer || socket.readyState !== WebSocket.OPEN) return;
    const sendable = sendableSteps(editor.state);
    if (!sendable) return;
    awaitingAnswer = true;
    socket.send(JSON.stringify({ type: "steps", version: sendable.version, steps: sendable.steps.map((step) => step.toJSON()), clientID: sendable.clientID }));
  };

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "init") {
      editor = open(schema.nodeFromJSON(message.doc), message.version);
    } else if (message.type === "steps" && editor) {
      // A rejection repeats Steps the broadcast already delivered: skip those.
      const known = getVersion(editor.state) - message.version;
      awaitingAnswer = false;
      if (known >= 0 && known < message.steps.length) {
        const steps = message.steps.slice(known).map((json: unknown) => Step.fromJSON(schema, json));
        // Rebases our unconfirmed Steps over the ones we missed.
        editor.dispatch(receiveTransaction(editor.state, steps, message.clientIDs.slice(known)));
      }
      push();
    }
  });

  return push;
}
