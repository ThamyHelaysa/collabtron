import MarkdownIt from "markdown-it";
import type { Node } from "prosemirror-model";
import { MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer, schema } from "prosemirror-markdown";

export { schema };

// Same tokenizer settings as the site. Tokens without a mapping (raw HTML, tables, ~~) throw, so a Post is refused rather than silently stripped.
const parser = new MarkdownParser(schema, MarkdownIt({ html: true }), defaultMarkdownParser.tokens);

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bullet_list(state, node, parent, index) {
      const marker = needsAltMarker(node, parent, index) ? "* " : "- ";
      state.renderList(node, "  ", () => marker);
    },
    ordered_list(state, node, parent, index) {
      const delim = needsAltMarker(node, parent, index) ? ") " : ". ";
      const start: number = node.attrs.order ?? 1;
      const width = String(start + node.childCount - 1).length;
      state.renderList(node, state.repeat(" ", width + 2), (i) => String(start + i).padStart(width) + delim);
    },
  },
  defaultMarkdownSerializer.marks,
);

// Odd position in a run of adjacent same-type lists: alternating markers keeps every list separate.
function needsAltMarker(node: Node, parent: Node, index: number) {
  let run = 0;
  while (index - run > 0 && parent.child(index - run - 1).type === node.type) run++;
  return run % 2 === 1;
}

export function parse(markdown: string): Node {
  return parser.parse(markdown);
}

export function serialize(doc: Node): string {
  return serializer.serialize(doc) + "\n";
}
