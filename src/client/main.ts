import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { wrapInList } from "prosemirror-schema-list";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parse, schema, serialize } from "../shared/markdown.ts";
import { exitCaption, insertDetails, insertImageContainer, insertVideoContainer, setQuoteVariant, shortcodeViews } from "./shortcode-blocks.ts";

const postId = decodeURIComponent(location.pathname.split("/")[2]);
const api = `/api/posts/${encodeURIComponent(postId)}`;
const status = document.querySelector<HTMLElement>("#status")!;

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

const res = await fetch(api);
if (!res.ok) {
  status.textContent = `Could not load Post (${res.status})`;
  throw new Error(status.textContent);
}
let doc;
try {
  doc = parse(await res.text());
} catch (err) {
  status.textContent = "This Post has Markdown the editor cannot keep yet (unsupported HTML or tables); not opened.";
  throw err;
}

const view = new EditorView(document.querySelector("#editor"), {
  nodeViews: shortcodeViews,
  state: EditorState.create({
    doc,
    plugins: [
      history(),
      keymap({ "Mod-z": undo, "Shift-Mod-z": redo, "Mod-b": bold, "Mod-i": italic, "Mod-s": save, Enter: exitCaption }),
      keymap(baseKeymap),
    ],
  }),
});

const toolbar = document.querySelector("#toolbar")!;
for (const [label, command] of tools) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.onmousedown = (e) => e.preventDefault(); // keep the editor's selection
  button.onclick = () => {
    command(view.state, view.dispatch, view);
    view.focus();
  };
  toolbar.append(button);
}
