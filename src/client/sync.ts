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
  let sentAs: unknown;

  const push = () => {
    if (!editor || awaitingAnswer || socket.readyState !== WebSocket.OPEN) return;
    const sendable = sendableSteps(editor.state);
    if (!sendable) return;
    awaitingAnswer = true;
    sentAs = sendable.clientID;
    socket.send(JSON.stringify({ type: "steps", version: sendable.version, steps: sendable.steps.map((step) => step.toJSON()), clientID: sendable.clientID }));
  };

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "init") {
      editor = open(schema.nodeFromJSON(message.doc), message.version);
    } else if (message.type === "steps" && editor) {
      const known = getVersion(editor.state) - message.version;
      const isNews = known >= 0 && known < message.steps.length;
      // The answer to our batch is our own Steps accepted, or a rejection. A rejection brings nothing new:
      // the Steps we missed were broadcast when accepted, before the Authority got to our batch.
      if (!isNews || message.clientIDs.includes(sentAs)) awaitingAnswer = false;
      if (isNews) {
        const steps = message.steps.slice(known).map((json: unknown) => Step.fromJSON(schema, json));
        // Confirms our Steps among them and rebases our unconfirmed ones over the rest.
        editor.dispatch(receiveTransaction(editor.state, steps, message.clientIDs.slice(known)));
      }
      push();
    }
  });

  return push;
}
