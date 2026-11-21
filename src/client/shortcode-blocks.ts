import type { Node } from "prosemirror-model";
import { TextSelection, type Command } from "prosemirror-state";
import type { EditorView, NodeView, NodeViewConstructor, ViewMutationRecord } from "prosemirror-view";
import { schema } from "../shared/markdown.ts";

// Optional arguments save as null when emptied, the site treats null and "" alike for them; others save as "".
type Field = { label: string; optional?: true };
const fields: Record<string, Record<string, Field>> = {
  image_container: {
    src: { label: "Image file" },
    mobileSrc: { label: "Mobile file (optional)", optional: true },
    alt: { label: "Alt text" },
    caption: { label: "Caption" },
  },
  video_container: {
    src: { label: "Video file" },
    mobileSrc: { label: "Mobile file (optional)", optional: true },
    props: { label: "Video attributes (optional)", optional: true },
  },
};

class ShortcodeView implements NodeView {
  dom: HTMLElement;
  contentDOM?: HTMLElement;
  private inputs = new Map<string, HTMLInputElement>();
  private node: Node;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.dom = document.createElement("figure");
    this.dom.className = `shortcode-block ${node.type.name.replace("_", "-")}`;
    const form = this.dom.appendChild(document.createElement("fieldset"));
    form.contentEditable = "false";
    for (const [name, { label, optional }] of Object.entries(fields[node.type.name])) {
      const wrapper = form.appendChild(document.createElement("label"));
      wrapper.textContent = label;
      const input = wrapper.appendChild(document.createElement("input"));
      input.value = node.attrs[name] ?? "";
      input.oninput = () => {
        const pos = getPos();
        if (pos != null) view.dispatch(view.state.tr.setNodeAttribute(pos, name, input.value || (optional ? null : "")));
      };
      this.inputs.set(name, input);
    }
    if (!node.isAtom) this.contentDOM = this.dom.appendChild(document.createElement("figcaption"));
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    for (const [name, input] of this.inputs) {
      const value = node.attrs[name] ?? "";
      if (input.value !== value) input.value = value; // Rewriting an unchanged value would move the caret.
    }
    return true;
  }

  // Typing in a field belongs to the field, not to the editor.
  stopEvent(event: Event) {
    return event.target instanceof HTMLInputElement;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    return !this.contentDOM?.contains(mutation.target);
  }
}

const shortcodeView: NodeViewConstructor = (node, view, getPos) => new ShortcodeView(node, view, getPos);
export const shortcodeViews = { image_container: shortcodeView, video_container: shortcodeView };

// A caption is one block: Enter would split it into two copies of the video, so continue in a paragraph after the card.
export const exitCaption: Command = (state, dispatch) => {
  const { $head } = state.selection;
  if ($head.parent.type !== schema.nodes.video_container) return false;
  if (dispatch) {
    const pos = $head.after();
    const tr = state.tr.insert(pos, schema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView());
  }
  return true;
};

function insertAfterBlock(node: Node): Command {
  return (state, dispatch) => {
    const { $to } = state.selection;
    dispatch?.(state.tr.insert($to.depth ? $to.after(1) : $to.pos, node).scrollIntoView());
    return true;
  };
}

export const insertImageContainer = insertAfterBlock(schema.nodes.image_container.create());
export const insertVideoContainer = insertAfterBlock(schema.nodes.video_container.create());
