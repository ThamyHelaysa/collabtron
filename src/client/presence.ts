import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Collaborator } from "../shared/collaborator.ts";

// Where another Collaborator is, in this editor's document.
export type Presence = Collaborator & { anchor: number; head: number };
// Set as transaction meta by sync: with no `presence`, that Collaborator left.
export type PresenceUpdate = { id: number; presence?: Presence };

export const presenceKey = new PluginKey<Map<number, Presence>>("presence");

// The other Collaborators, by the id the Server gave each one's socket, kept on the same text as Steps change the document, and drawn.
export const presence = new Plugin<Map<number, Presence>>({
  key: presenceKey,
  state: {
    init: () => new Map(),
    apply(tr, others) {
      const update: PresenceUpdate | undefined = tr.getMeta(presenceKey);
      if (!tr.docChanged && !update) return others;
      const next = new Map([...others].map(([id, { anchor, head, ...who }]) => [id, { ...who, anchor: tr.mapping.map(anchor), head: tr.mapping.map(head) }]));
      if (update?.presence) next.set(update.id, update.presence);
      else if (update) next.delete(update.id);
      return next;
    },
  },
  props: {
    decorations: (state) =>
      DecorationSet.create(
        state.doc,
        [...presenceKey.getState(state)!].flatMap(([id, { name, color, anchor, head }]) => {
          const [from, to] = [Math.min(anchor, head), Math.max(anchor, head)];
          const node = state.doc.nodeAt(from);
          return [
            // A selected block, such as a Raw Block, may have no text to highlight.
            ...(node?.isBlock && from + node.nodeSize === to
              ? [Decoration.node(from, to, { class: `presence-block presence-color-${color}` })]
              : from < to
                ? [Decoration.inline(from, to, { class: `presence-selection presence-color-${color}` })]
                : []),
            // Between blocks, a caret would take a line of its own and push the text below down.
            ...(state.doc.resolve(head).parent.inlineContent ? [Decoration.widget(head, () => caret(name, color), { key: `${id} ${name} ${color}` })] : []),
          ];
        }),
      ),
  },
});

// Colours come from the page's classes, one per number in `colors`: never from a value written into CSS.
function caret(name: string, color: number) {
  const caret = document.createElement("span");
  caret.className = `presence presence-color-${color}`;
  caret.appendChild(document.createElement("span")).textContent = name;
  return caret;
}
