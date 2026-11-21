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
    // html: saved as HTML (true) or Markdown (false); null, for new links, follows house style.
    // extra: attributes Collaborators cannot edit, kept and saved back but never rendered in the editor.
    attrs: { ...baseSchema.spec.marks.get("link")!.attrs, wrapped: { default: false }, html: { default: null }, extra: { default: {} } },
    toDOM: ({ attrs }) => ["a", linkAttributes({ ...attrs, extra: {} }), 0],
  }).addBefore("em", "strikethrough", {
    attrs: { extra: { default: {} } },
    parseDOM: [{ tag: "s" }],
    toDOM: () => ["s", 0],
  }).update("em", withExtra("em")).update("strong", withExtra("strong")).update("code", withExtra("code")),
});

function withExtra(name: string) {
  return { ...baseSchema.spec.marks.get(name)!, attrs: { extra: { default: {} } } };
}

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
    const stack: { type: string; index: number }[] = [];
    // A Markdown break ends its line: keep that newline so the site still renders <br> plus whitespace.
    // Empty text renders nothing; dropping it lets a mark see its neighbours.
    block.children &&= block.children.flatMap((token) =>
      token.type === "hardbreak" ? [token, new state.Token("softbreak", "br", 0)] :
      token.type === "text" && !token.content ? [] : [token]);
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
        const attrs = Object.fromEntries(element.attrs.map(({ name, value }) => [name, value]));
        if (tag === "a") {
          const { href, title, ...extra } = attrs;
          if (href == null || !state.md.validateLink(href)) throw new Error("Unsupported link");
          // House style owns rel and target on external links; drop them so they do not stay if the href turns internal.
          if (isExternal(href)) {
            delete extra.rel;
            delete extra.target;
          }
          token.attrs = [["href", href]];
          if (title != null) token.attrs.push(["title", title]);
          token.meta = { html: true, extra };
        } else token.meta = { extra: attrs };
        token.type = `${tag === "a" ? "link" : tag === "code" ? "html_code" : tag}_open`;
      } else if (closing) {
        token.type = `${tag === "a" ? "link" : tag === "code" ? "html_code" : tag}_close`;
      }
    }
    const children = block.children ?? [];
    children.forEach((token, i) => {
      const mark = /^(s|link|strong|em|html_code)_(open|close)$/.exec(token.type);
      if (mark?.[2] === "open") {
        if (stack.some(({ type }) => type === mark[1])) throw new Error("Nested house-style mark is not supported");
        stack.push({ type: mark[1], index: i });
      } else if (mark) {
        const open = stack.pop();
        if (open?.type !== mark[1]) throw new Error("Unmatched house-style tag");
        if (mark[1] === "link") {
          const outer = /^(s|strong|em)_open$/.exec(children[open.index - 1]?.type ?? "");
          const inner = /^(s|strong|em)_open$/.exec(children[open.index + 1]?.type ?? "");
          const wrapped = !!outer && children[i + 1]?.type === `${outer[1]}_close`;
          // ProseMirror keeps no mark order, so such a link would not save back as written.
          if (wrapped && inner && children.findIndex((t, j) => j > open.index && t.type === `${inner[1]}_close`) === i - 1)
            throw new Error("Link wrapped by one mark outside and another inside is not supported");
          children[open.index].meta = { ...children[open.index].meta, wrapped };
        }
      }
    });
    if (stack.length) throw new Error("Unclosed house-style tag");
  }
});

const extraAttrs = (tok: Token) => ({ extra: tok.meta?.extra ?? {} });
const rawInline = { node: "raw_inline", getAttrs: (tok: Token) => ({ content: tok.content }) };
const rawBlock = { node: "raw_block", getAttrs: (tok: Token) => ({ content: tok.content.replace(/\n$/, "") }) };
// Unmapped tokens still throw, so a Post is refused rather than silently stripped.
const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  s: { mark: "strikethrough", getAttrs: extraAttrs },
  em: { mark: "em", getAttrs: extraAttrs },
  strong: { mark: "strong", getAttrs: extraAttrs },
  link: {
    mark: "link",
    getAttrs: (tok) => ({
      href: tok.attrGet("href"), title: tok.attrGet("title") ?? null,
      wrapped: !!tok.meta?.wrapped, html: !!tok.meta?.html, extra: tok.meta?.extra ?? {},
    }),
  },
  html_paragraph: { block: "paragraph", attrs: { htmlBlock: true } },
  html_code: { mark: "code", getAttrs: extraAttrs },
  raw_inline: rawInline,
  html_inline: rawInline,
  raw_block: rawBlock,
  html_block: rawBlock,
});

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    paragraph(state, node, parent, index) {
      if (!node.attrs.htmlBlock || node.firstChild?.type.name !== "hard_break")
        return defaultMarkdownSerializer.nodes.paragraph(state, node, parent, index);
      const html = serializeHtmlInline(node);
      // Editing collapses the newline after the break to a space or nothing; the block needs it to stay HTML.
      state.write(node.childCount > 1 ? html.replace(/^<\/br>[ \t]*\n?/, "</br>\n") : html);
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
    strikethrough: { open: (_state, mark) => `<s${htmlAttributes(mark.attrs.extra)}>`, close: "</s>", mixable: true },
    em: htmlWhenExtra("em"),
    strong: htmlWhenExtra("strong"),
    code: htmlWhenExtra("code"),
    link: {
      ...defaultMarkdownSerializer.marks.link,
      open(state, mark, parent, index) {
        if (isHtmlLink(mark)) return `<a${htmlAttributes(linkAttributes(mark.attrs))}>`;
        const { open } = defaultMarkdownSerializer.marks.link;
        return typeof open === "string" ? open : open(state, mark, parent, index);
      },
      close(state, mark, parent, index) {
        if (isHtmlLink(mark)) return "</a>";
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

function linkAttributes({ href, title, extra }: Attrs): Attrs {
  if (!isExternal(href)) return { href, title, ...extra };
  // House style owns rel and target on external links.
  const { rel, target, ...kept } = extra;
  return { href, title, ...kept, rel: "noreferrer", target: "_blank" };
}

function hasExtra(mark: Mark): boolean {
  return Object.keys(mark.attrs.extra).length > 0;
}

function isHtmlLink(mark: Mark): boolean {
  return (mark.attrs.html ?? isExternal(mark.attrs.href)) || hasExtra(mark);
}

// Kept attributes on these marks only come from an HTML block; once it loses its leading break they need HTML.
type MarkSerializerSpec = MarkdownSerializer["marks"][string];
function htmlWhenExtra(name: "em" | "strong" | "code"): MarkSerializerSpec {
  const spec = defaultMarkdownSerializer.marks[name];
  const call = (part: MarkSerializerSpec["open"], ...args: Parameters<Exclude<MarkSerializerSpec["open"], string>>) =>
    typeof part === "string" ? part : part(...args);
  return {
    ...spec,
    open(state, mark, parent, index) {
      if (!hasExtra(mark)) return call(spec.open, state, mark, parent, index);
      // shortcut: code text is written unescaped, so it would read as Markdown inside HTML; upgrade if a Post needs it.
      if (name === "code") throw new Error("Unsupported code attributes outside an HTML block");
      return `<${name}${htmlAttributes(mark.attrs.extra)}>`;
    },
    close: (state, mark, parent, index) => hasExtra(mark) ? `</${name}>` : call(spec.close, state, mark, parent, index),
  };
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
      html += `<${spec[0]}${htmlAttributes(mark.type.name === "link" ? linkAttributes(mark.attrs) : mark.attrs.extra)}>`;
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
