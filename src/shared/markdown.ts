import MarkdownIt from "markdown-it";
import { parseFragment } from "parse5";
import { Schema, type Attrs, type Mark, type Node } from "prosemirror-model";
import { MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer, schema as baseSchema } from "prosemirror-markdown";

export const schema = new Schema({
  nodes: baseSchema.spec.nodes.update("paragraph", {
    ...baseSchema.spec.nodes.get("paragraph")!,
    attrs: { htmlBlock: { default: false } },
  }),
  marks: baseSchema.spec.marks.remove("link").addToStart("link", {
    ...baseSchema.spec.marks.get("link")!,
    toDOM: (mark) => ["a", {
      ...mark.attrs,
      ...(isExternal(mark.attrs.href) ? { rel: "noreferrer", target: "_blank" } : {}),
    }, 0],
  }).addBefore("em", "strikethrough", {
    parseDOM: [{ tag: "s" }],
    toDOM: () => ["s", 0],
  }),
});

const tokenizer = MarkdownIt({ html: true });
const breakTag = /^<(?:br\s*\/?|\/br\s*)>$/i;
const htmlTokenizer = MarkdownIt({ html: true });
htmlTokenizer.inline.ruler.enableOnly(["text", "html_inline", "newline", "entity"]);
tokenizer.core.ruler.after("inline", "house_style", (state) => {
  // HTML blocks treat Markdown syntax literally, including after a leading break.
  state.tokens = state.tokens.flatMap((block) => {
    if (block.type !== "html_block" || !breakTag.test(block.content.split("\n", 1)[0].trim())) return [block];
    const inline = new state.Token("inline", "", 0);
    inline.meta = { htmlBlock: true };
    inline.children = [];
    htmlTokenizer.inline.parse(block.content.trimEnd(), htmlTokenizer, state.env, inline.children);
    for (const token of inline.children) {
      if (token.type === "softbreak") {
        token.type = "text";
        token.content = "\n";
      }
    }
    return [new state.Token("html_paragraph_open", "p", 1), inline, new state.Token("html_paragraph_close", "p", -1)];
  });
  for (const block of state.tokens) {
    const stack: string[] = [];
    for (const token of block.children ?? []) {
      if (token.type === "html_inline" && breakTag.test(token.content)) {
        token.type = "hardbreak";
        continue;
      }
      const opening = token.type === "html_inline" ? /^<(s|a|strong|em|code)(?:\s|>)/i.exec(token.content) : null;
      const closing = token.type === "html_inline" ? /^<\/(s|a|strong|em|code)\s*>$/i.exec(token.content) : null;
      const tag = (opening || closing)?.[1].toLowerCase();
      if (tag && !["s", "a"].includes(tag) && !block.meta?.htmlBlock) continue;
      if (opening) {
        const element = parseFragment(token.content).childNodes[0];
        if (!element || !("tagName" in element)) throw new Error("Invalid house-style tag");
        if (tag !== "a" && element.attrs.length) throw new Error("Unsupported mark attributes");
        if (tag === "a") {
          if (element.attrs.some(({ name }) => !["href", "title", "rel", "target"].includes(name)))
            throw new Error("Unsupported link attributes");
          const attrs = Object.fromEntries(element.attrs.map(({ name, value }) => [name, value]));
          if (attrs.href == null || !state.md.validateLink(attrs.href) ||
              (!isExternal(attrs.href) && (attrs.rel != null || attrs.target != null)) ||
              (attrs.rel != null && attrs.rel !== "noreferrer") ||
              (attrs.target != null && attrs.target !== "_blank")) throw new Error("Unsupported link");
          token.attrs = [["href", attrs.href]];
          if (attrs.title != null) token.attrs.push(["title", attrs.title]);
        }
        token.type = `${tag === "a" ? "link" : tag === "code" ? "html_code" : tag}_open`;
      } else if (closing) {
        token.type = `${tag === "a" ? "link" : tag === "code" ? "html_code" : tag}_close`;
      }
      const mark = /^(s|link|strong|em|html_code)_(open|close)$/.exec(token.type);
      if (mark?.[2] === "open") {
        if (stack.includes(mark[1])) throw new Error("Nested house-style mark is not supported");
        stack.push(mark[1]);
      } else if (mark && stack.pop() !== mark[1]) throw new Error("Unmatched house-style tag");
    }
    if (stack.length) throw new Error("Unclosed house-style tag");
  }
});

// Unmapped tokens still throw, so a Post is refused rather than silently stripped.
const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  s: { mark: "strikethrough" },
  html_paragraph: { block: "paragraph", attrs: { htmlBlock: true } },
  html_code: { mark: "code" },
});

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    paragraph(state, node, parent, index) {
      const startsWithBreakLine = node.firstChild?.type.name === "hard_break" &&
        (node.childCount === 1 || node.child(1).text?.startsWith("\n"));
      if (!node.attrs.htmlBlock || !startsWithBreakLine)
        return defaultMarkdownSerializer.nodes.paragraph(state, node, parent, index);
      state.write(serializeHtmlInline(node));
      state.closeBlock(node);
    },
    hard_break(state) {
      state.write("</br>");
    },
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
  {
    ...defaultMarkdownSerializer.marks,
    strikethrough: { open: "<s>", close: "</s>", mixable: true },
    link: {
      ...defaultMarkdownSerializer.marks.link,
      open(state, mark, parent, index) {
        if (isExternal(mark.attrs.href)) {
          const escape = tokenizer.utils.escapeHtml;
          const title = mark.attrs.title == null ? "" : ` title="${escape(mark.attrs.title)}"`;
          return `<a href="${escape(mark.attrs.href)}" rel="noreferrer" target="_blank"${title}>`;
        }
        const { open } = defaultMarkdownSerializer.marks.link;
        return typeof open === "string" ? open : open(state, mark, parent, index);
      },
      close(state, mark, parent, index) {
        if (isExternal(mark.attrs.href)) return "</a>";
        const { close } = defaultMarkdownSerializer.marks.link;
        return typeof close === "string" ? close : close(state, mark, parent, index);
      },
    },
  },
);

function isExternal(href: string): boolean {
  return /^(?:https?:)?\/\//i.test(href);
}

function htmlAttributes(attrs: Attrs): string {
  return Object.entries(attrs).filter(([, value]) => value != null)
    .map(([name, value]) => ` ${name}="${tokenizer.utils.escapeHtml(String(value))}"`).join("");
}

function serializeHtmlInline(paragraph: Node): string {
  const active: { mark: Mark; close: string }[] = [];
  let html = "";
  paragraph.forEach((node) => {
    let keep = 0;
    while (keep < active.length && keep < node.marks.length && active[keep].mark.eq(node.marks[keep])) keep++;
    while (active.length > keep) html += active.pop()!.close;
    for (const mark of node.marks.slice(keep)) {
      if (mark.type.name === "link" && !tokenizer.validateLink(mark.attrs.href)) throw new Error("Unsupported link");
      const spec = mark.type.spec.toDOM!(mark, true);
      if (!Array.isArray(spec) || typeof spec[0] !== "string") throw new Error("Unsupported HTML mark");
      const attrs = typeof spec[1] === "object" ? htmlAttributes(spec[1]) : "";
      html += `<${spec[0]}${attrs}>`;
      active.push({ mark, close: `</${spec[0]}>` });
    }
    if (node.isText) html += tokenizer.utils.escapeHtml(node.text!);
    else if (node.type.name === "hard_break") html += "</br>";
    else if (node.type.name === "image") html += `<img${htmlAttributes(node.attrs)}>`;
    else throw new Error(`Unsupported HTML inline node: ${node.type.name}`);
  });
  while (active.length) html += active.pop()!.close;
  return html;
}

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
