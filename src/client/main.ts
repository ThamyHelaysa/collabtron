import { collab } from "prosemirror-collab";
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { wrapInList } from "prosemirror-schema-list";
import { EditorState, Plugin, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { frontMatterError, schema, serialize } from "../shared/markdown.ts";
import { keepFrontMatter } from "./front-matter.ts";
import { syncWithAuthority } from "./sync.ts";
import { exitCaption, insertDetails, insertImageContainer, insertVideoContainer, setQuoteVariant, shortcodeViews } from "./shortcode-blocks.ts";

const postId = decodeURIComponent(location.pathname.split("/")[2]);
const api = `/api/posts/${encodeURIComponent(postId)}`;
const status = document.querySelector<HTMLElement>("#status")!;
const yamlWarning = document.querySelector<HTMLElement>("#yaml-warning")!;

const showYamlWarning = (state: EditorState) => {
  const error = frontMatterError(state.doc);
  yamlWarning.hidden = !error;
  yamlWarning.textContent = error ? `Front matter is not valid YAML, the site build will fail:\n${error}` : "";
};
const yamlCheck = new Plugin({
  view: (view) => {
    showYamlWarning(view.state);
    return { update: (view, prev) => { if (view.state.doc !== prev.doc) showYamlWarning(view.state); } };
  },
});

const toggleLink: Command = (state, dispatch) => {
  const { link } = schema.marks;
  if (state.selection.empty) return false;
  if (state.doc.rangeHasMark(state.selection.from, state.selection.to, link)) return toggleMark(link)(state, dispatch);
  const href = prompt("Link URL");
  return href ? toggleMark(link, { href })(state, dispatch) : false;
};

const save: Command = (state) => {
  status.textContent = "Saving…";
  fetch(api, { method: "PUT", body: serialize(state.doc) }).then(
    (res) => (status.textContent = res.ok ? "Saved" : `Save failed (${res.status})`),
    () => (status.textContent = "Save failed (offline)"),
  );
  return true;
};

const bold = toggleMark(schema.marks.strong);
const italic = toggleMark(schema.marks.em);
const { heading, paragraph, bullet_list, ordered_list } = schema.nodes;
const tools: [string, Command][] = [
  ["Bold", bold],
  ["Italic", italic],
  ["Strikethrough", toggleMark(schema.marks.strikethrough)],
  ["Link", toggleLink],
  ["Inline code", toggleMark(schema.marks.code)],
  ["Paragraph", setBlockType(paragraph)],
  ["H2", setBlockType(heading, { level: 2 })],
  ["H3", setBlockType(heading, { level: 3 })],
  ["Bullet list", wrapInList(bullet_list)],
  ["Ordered list", wrapInList(ordered_list)],
  ["Quote", setQuoteVariant(null)],
  ["Error block", setQuoteVariant("error")],
  ["Warning block", setQuoteVariant("warning")],
  ["Details", insertDetails],
  ["Image", insertImageContainer],
  ["Video", insertVideoContainer],
  ["Save", save],
];

let view: EditorView | undefined;
const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${encodeURIComponent(postId)}`);
const push = syncWithAuthority(socket, (doc, version) => {
  view = new EditorView(document.querySelector("#editor"), {
    nodeViews: shortcodeViews,
    dispatchTransaction(tr) {
      view!.updateState(view!.state.apply(tr));
      push();
    },
    state: EditorState.create({
      doc,
      plugins: [
        // With collab, undo reverts only this Collaborator's Steps.
        history(),
        collab({ version }),
        yamlCheck,
        keepFrontMatter,
        keymap({ "Mod-z": undo, "Shift-Mod-z": redo, "Mod-b": bold, "Mod-i": italic, "Mod-s": save, Enter: exitCaption }),
        keymap(baseKeymap),
      ],
    }),
  });
  return view;
});
// No reconnect yet: after this, edits stay in this tab only.
socket.addEventListener("close", (event) => {
  status.textContent = view ? "Disconnected: reload to keep editing together" : `Could not open Post${event.reason ? `: ${event.reason}` : ""}`;
});

const toolbar = document.querySelector("#toolbar")!;
for (const [label, command] of tools) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.onmousedown = (e) => e.preventDefault(); // keep the editor's selection
  button.onclick = () => {
    if (!view) return;
    command(view.state, view.dispatch, view);
    view.focus();
  };
  toolbar.append(button);
}
