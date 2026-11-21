import MarkdownIt, { type Token } from "markdown-it";
import { parseFragment } from "parse5";
import { Fragment, Schema, type Attrs, type Mark, type Node } from "prosemirror-model";
import { MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer, schema as baseSchema } from "prosemirror-markdown";

export const schema = new Schema({
  nodes: baseSchema.spec.nodes.update("paragraph", {
    ...baseSchema.spec.nodes.get("paragraph")!,
    attrs: { htmlBlock: { default: false } },
  }).update("heading", {
    ...baseSchema.spec.nodes.get("heading")!,
    content: "(text | image | raw_inline)*",
  }).addToEnd("raw_block", {
    group: "block",
    attrs: { content: {} },
    draggable: true,
    toDOM: (node) => ["pre", { class: "raw-block" }, node.attrs.content],
    parseDOM: [{ tag: "pre.raw-block", priority: 60, getAttrs: (dom) => ({ content: dom.textContent }) }],
  }).addBefore("hard_break", "raw_inline", {
    inline: true,
    group: "inline",
    attrs: { content: {} },
    draggable: true,
    toDOM: (node) => ["span", { class: "raw-inline" }, node.attrs.content],
    parseDOM: [{ tag: "span.raw-inline", getAttrs: (dom) => ({ content: dom.textContent }) }],
  }),
  marks: baseSchema.spec.marks.remove("link").addToStart("link", {
    ...baseSchema.spec.marks.get("link")!,
    // wrapped: marks covering exactly this link were written outside it.
    attrs: { ...baseSchema.spec.marks.get("link")!.attrs, wrapped: { default: false } },
    toDOM: ({ attrs: { wrapped, ...attrs } }) => ["a", {
      ...attrs,
      ...(isExternal(attrs.href) ? { rel: "noreferrer", target: "_blank" } : {}),
    }, 0],
  }).addBefore("em", "strikethrough", {
    parseDOM: [{ tag: "s" }],
    toDOM: () => ["s", 0],
  }),
});

const tokenizer = MarkdownIt({ html: true });
tokenizer.block.ruler.before("fence", "nunjucks_block", (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4 || !state.src.startsWith("{%", start)) return false;
  const end = nunjucksBlockEnd(state.src, start);
  let line = startLine;
  while (line < endLine && state.eMarks[line] < end) line++;
  if (end < 0 || line === endLine) return false;
  if (silent) return true;
  // Like an HTML block, run on until a blank line so separating it never changes how the site renders.
  do line++; while (line < endLine && !state.isEmpty(line));
  const token = state.push("raw_block", "", 0);
  token.content = state.getLines(startLine, line, state.blkIndent, true);
  token.map = [startLine, line];
  state.line = line;
  return true;
});
const breakTag = /^<(?:br\s*\/?|\/br\s*)>$/i;
const htmlTokenizer = MarkdownIt({ html: true });
for (const md of [tokenizer, htmlTokenizer]) md.inline.ruler.before("text", "nunjucks_inline", (state, silent) => {
  const tag = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/y;
  tag.lastIndex = state.pos;
  if (!tag.exec(state.src) || tag.lastIndex > state.posMax) return false;
  if (!silent) state.push("raw_inline", "", 0).content = state.src.slice(state.pos, tag.lastIndex);
  state.pos = tag.lastIndex;
  return true;
});
htmlTokenizer.inline.ruler.enableOnly(["nunjucks_inline", "text", "html_inline", "newline", "entity"]);
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
    // A Markdown break ends its line: keep that newline so the site still renders <br> plus whitespace.
    block.children &&= block.children.flatMap((token) =>
      token.type === "hardbreak" ? [token, new state.Token("softbreak", "br", 0)] : [token]);
    let previous = "";
    for (const token of block.children ?? []) {
      // Alt text is plain text, so a raw piece in it would be dropped.
      if (token.children?.some(({ type }) => type === "raw_inline" || type === "html_inline"))
        throw new Error("Unsupported Nunjucks or HTML in image alt text");
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
      if (token.type === "link_open" && /^(s|strong|em)_open$/.test(previous)) token.meta = { wrapped: true };
      previous = token.type;
      const mark = /^(s|link|strong|em|html_code)_(open|close)$/.exec(token.type);
      if (mark?.[2] === "open") {
        if (stack.includes(mark[1])) throw new Error("Nested house-style mark is not supported");
        stack.push(mark[1]);
      } else if (mark && stack.pop() !== mark[1]) throw new Error("Unmatched house-style tag");
    }
    if (stack.length) throw new Error("Unclosed house-style tag");
  }
});

const rawInline = { node: "raw_inline", getAttrs: (tok: Token) => ({ content: tok.content }) };
const rawBlock = { node: "raw_block", getAttrs: (tok: Token) => ({ content: tok.content.replace(/\n$/, "") }) };
// Unmapped tokens still throw, so a Post is refused rather than silently stripped.
const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  s: { mark: "strikethrough" },
  link: {
    mark: "link",
    getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null, wrapped: !!tok.meta?.wrapped }),
  },
  html_paragraph: { block: "paragraph", attrs: { htmlBlock: true } },
  html_code: { mark: "code" },
  raw_inline: rawInline,
  html_inline: rawInline,
  raw_block: rawBlock,
  html_block: rawBlock,
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
    raw_block(state, node) {
      state.text(node.attrs.content, false);
      state.closeBlock(node);
    },
    raw_inline(state, node) {
      state.text(node.attrs.content, false);
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

// End of the tag at start, or of its {% end<name> %} when one follows.
// shortcut: counts only same-name tags, so a lone `{% set x = 1 %}` before an `{% endset %}` misnests; upgrade if Posts use set blocks.
function nunjucksBlockEnd(src: string, start: number): number {
  const tag = /\{%-?\s*(\w+)[\s\S]*?%\}/y;
  tag.lastIndex = start;
  const open = tag.exec(src);
  if (!open) return -1;
  const name = open[1];
  const pair = new RegExp(`\\{%-?\\s*(end)?${name}\\b[\\s\\S]*?%\\}`, "g");
  pair.lastIndex = tag.lastIndex;
  for (let depth = 1, match; (match = pair.exec(src));) {
    depth += match[1] ? -1 : 1;
    if (!depth) return pair.lastIndex;
  }
  return tag.lastIndex;
}

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
    else if (node.type.name === "raw_inline") html += node.attrs.content;
    else if (node.type.name === "image") html += `<img${htmlAttributes(node.attrs)}>`;
    else throw new Error(`Unsupported HTML inline node: ${node.type.name}`);
  });
  while (active.length) html += active.pop()!.close;
  return html;
}

// ProseMirror always orders marks by schema rank (link first), so put back outside a link
// each mark that covers it whole and either runs past it or was written outside it.
function nestLinkMarks(node: Node): Node {
  if (node.isLeaf) return node;
  const children: Node[] = [];
  node.forEach((child) => children.push(node.inlineContent ? child : nestLinkMarks(child)));
  for (let start = 0, end; start < children.length; start = end) {
    const link = children[start].marks.find((mark) => mark.type.name === "link");
    end = start + 1;
    if (!link) continue;
    while (end < children.length && link.isInSet(children[end].marks)) end++;
    const run = children.slice(start, end);
    const outside = run[0].marks.filter((mark) => ["strikethrough", "em", "strong"].includes(mark.type.name) &&
      run.every((child) => mark.isInSet(child.marks)) && (link.attrs.wrapped ||
        mark.isInSet(children[start - 1]?.marks ?? []) || mark.isInSet(children[end]?.marks ?? [])));
    for (let i = start; i < end; i++)
      children[i] = children[i].mark([...outside, ...children[i].marks.filter((mark) => !outside.includes(mark))]);
  }
  return node.copy(Fragment.fromArray(children));
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
  return serializer.serialize(nestLinkMarks(doc)) + "\n";
}
