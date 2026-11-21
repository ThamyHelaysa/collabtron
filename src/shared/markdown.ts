import MarkdownIt, { type StateCore, type Token } from "markdown-it";
import { parseFragment } from "parse5";
import { Fragment, Schema, type Attrs, type Mark, type Node } from "prosemirror-model";
import { MarkdownParser, MarkdownSerializer, type MarkdownSerializerState, defaultMarkdownParser, defaultMarkdownSerializer, schema as baseSchema } from "prosemirror-markdown";

export const schema = new Schema({
  nodes: baseSchema.spec.nodes.update("paragraph", {
    ...baseSchema.spec.nodes.get("paragraph")!,
    attrs: { htmlBlock: { default: false } },
  }).update("blockquote", {
    ...baseSchema.spec.nodes.get("blockquote")!,
    // A site callout: "error" or "warning", saved as HTML. null is a Markdown blockquote.
    attrs: { variant: { default: null } },
    toDOM: (node) => ["blockquote", node.attrs.variant ? { class: `${node.attrs.variant}-block block` } : {}, 0],
    parseDOM: [{ tag: "blockquote", getAttrs: (dom) => ({ variant: /\b(error|warning)-block\b/.exec(dom.className)?.[1] ?? null }) }],
  }).update("heading", {
    ...baseSchema.spec.nodes.get("heading")!,
    content: "(text | image | raw_inline)*",
  }).addToEnd("raw_block", {
    group: "block",
    attrs: { content: {} },
    draggable: true,
    toDOM: (node) => ["pre", { class: "raw-block" }, node.attrs.content],
    parseDOM: [{ tag: "pre.raw-block", priority: 60, getAttrs: (dom) => ({ content: dom.textContent }) }],
  }).addToEnd("image_container", {
    group: "block",
    atom: true,
    draggable: true,
    attrs: { caption: { default: "" }, src: { default: "" }, mobileSrc: { default: null }, alt: { default: "" } },
    toDOM: (node) => ["figure", { class: "image-container", "data-attrs": JSON.stringify(node.attrs) }],
    parseDOM: [{ tag: "figure.image-container", getAttrs: (dom) => JSON.parse(dom.dataset.attrs ?? "{}") }],
  }).addToEnd("video_container", {
    group: "block",
    // The site writes the caption into HTML, so only what HTML can say: no Markdown images.
    content: "(text | raw_inline | hard_break)*",
    draggable: true,
    attrs: { src: { default: "" }, mobileSrc: { default: null }, props: { default: null } },
    toDOM: (node) => ["figure", { class: "video-container", "data-attrs": JSON.stringify(node.attrs) }, ["figcaption", 0]],
    parseDOM: [{ tag: "figure.video-container", contentElement: "figcaption", getAttrs: (dom) => JSON.parse(dom.dataset.attrs ?? "{}") }],
  }).addToEnd("details", {
    group: "block",
    content: "details_summary block+",
    defining: true,
    // Always open: a native <details> would fold away while being edited.
    toDOM: () => ["div", { class: "details" }, 0],
    parseDOM: [{ tag: "div.details" }, { tag: "details" }],
  }).addToEnd("details_summary", {
    // The site writes the summary into HTML, so only what HTML can say: no Markdown images.
    content: "(text | raw_inline | hard_break)*",
    defining: true,
    toDOM: () => ["div", { class: "details-summary" }, 0],
    parseDOM: [{ tag: "div.details-summary" }, { tag: "summary" }],
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
// No "newline" rule: in HTML a line ending, even after two spaces, is only whitespace.
htmlTokenizer.inline.ruler.enableOnly(["nunjucks_inline", "text", "html_inline", "entity"]);
tokenizer.core.ruler.after("inline", "house_style", (state) => {
  // HTML blocks treat Markdown syntax literally, including after a leading break.
  const closes = new Map<number, string>();
  state.tokens = state.tokens.flatMap((block, i) => {
    if (closes.has(i)) return [new state.Token(`${closes.get(i)}_close`, "", -1)];
    if (block.type === "raw_block") return shortcodeBlock(state, block);
    const container = block.type === "html_block" ? htmlContainer(state, i, closes) : null;
    if (container) return container;
    if (block.type !== "html_block" || !breakTag.test(block.content.split("\n", 1)[0].trim())) return [block];
    return [new state.Token("html_paragraph_open", "p", 1), htmlInline(state, block.content.trimEnd()), new state.Token("html_paragraph_close", "p", -1)];
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

// Known shortcodes, as written by the site's config. A tag that does not match stays a Raw Block.
const shortcodes = {
  imageContainer: { node: "image_container", args: ["caption", "src", "mobileSrc", "alt"], required: 4, paired: false },
  // A missing mobileSrc or props renders like null.
  videoContainer: { node: "video_container", args: ["src", "mobileSrc", "props"], required: 1, paired: true },
} as const;

function shortcodeBlock(state: StateCore, block: Token): Token[] {
  const tag = /^\{%\s*(\w+)\s([\s\S]*?)%\}(?:([\s\S]*?)\{%\s*end\1\s*%\})?\s*$/.exec(block.content);
  const known = tag && Object.hasOwn(shortcodes, tag[1]) ? shortcodes[tag[1] as keyof typeof shortcodes] : null;
  const values = known && known.paired === (tag![3] != null) && parseArguments(tag![2]);
  // Fewer arguments is not the same: the site renders a missing caption or alt as "undefined".
  if (!values || values.length < known.required || values.length > known.args.length) return [block];
  const attrs = Object.fromEntries(known.args.map((name, i) => [name, values[i] ?? null]));
  if (!known.paired) return [Object.assign(new state.Token(known.node, "", 0), { meta: attrs })];
  // Saved as "\n  caption\n": the site sees the same HTML only if the caption had whitespace around it and no blank line.
  const body = tag![3];
  if (!/^\s/.test(body) || !/\s$/.test(body) || /\n[ \t]*\n/.test(body.trim())) return [block];
  // The lazy body can run past its own end tag into a following container.
  if (new RegExp(`\\{%-?\\s*(?:end)?${tag![1]}\\b`).test(body)) return [block];
  return [
    Object.assign(new state.Token(`${known.node}_open`, "", 1), { meta: attrs }),
    htmlInline(state, body.trim()),
    new state.Token(`${known.node}_close`, "", -1),
  ];
}

// House-style HTML Shortcode Blocks with editable insides. The opening tag's HTML block holds the first lines, read as HTML,
// and may end with the end tag; otherwise Markdown blocks follow until the end tag alone in its HTML block.
const containers = [
  { name: "blockquote", open: /^<blockquote class="(error|warning)-block block">[ \t]*\n/, end: "</blockquote>", attrs: (m: RegExpExecArray) => ({ variant: m[1] }) },
  { name: "details", open: /^<details>[ \t]*\n[ \t]*<summary>((?:(?!<\/summary>).)*)<\/summary>[ \t]*\n/, end: "</details>", summary: (m: RegExpExecArray) => m[1] },
] as { name: string; open: RegExp; end: string; attrs?: (m: RegExpExecArray) => Attrs; summary?: (m: RegExpExecArray) => string }[];

function htmlContainer(state: StateCore, start: number, closes: Map<number, string>): Token[] | null {
  const block = state.tokens[start];
  const container = containers.find(({ open }) => open.test(block.content));
  if (!container) return null;
  const { name, open, end, attrs, summary } = container;
  const tag = new RegExp(`</?${name}\\b`, "i");
  const inside = (content: string) => {
    const match = open.exec(content)!;
    const rest = content.slice(match[0].length).trimEnd();
    const closed = rest.endsWith(end);
    const lines = closed ? rest.slice(0, -end.length) : rest;
    // The site sees whitespace before the end tag; saving puts a newline there, so it must already be one.
    if (tag.test(lines) || (closed && !/\n[ \t]*$/.test(lines))) return null;
    return { match, closed, lines: lines.trim() };
  };
  const first = inside(block.content);
  if (!first) return null;
  if (!first.closed) {
    let depth = 1, i = start;
    while (depth && ++i < state.tokens.length) {
      const { type, level, content } = state.tokens[i];
      if (type !== "html_block" || level !== block.level || !tag.test(content)) continue;
      if (content.trim() === end) depth--;
      else {
        const nested = open.test(content) ? inside(content) : null;
        if (!nested) return null;
        if (!nested.closed) depth++;
      }
    }
    if (depth) return null;
    closes.set(i, name);
  }
  const tokens: Token[] = [Object.assign(new state.Token(`${name}_open`, "", 1), { meta: attrs?.(first.match) })];
  if (summary) tokens.push(new state.Token("details_summary_open", "", 1), htmlInline(state, summary(first.match)), new state.Token("details_summary_close", "", -1));
  if (first.lines) tokens.push(new state.Token("html_paragraph_open", "p", 1), htmlInline(state, first.lines), new state.Token("html_paragraph_close", "p", -1));
  if (first.closed) tokens.push(new state.Token(`${name}_close`, "", -1));
  return tokens;
}

// Inline content the site sees inside HTML, where Markdown syntax is literal.
function htmlInline(state: StateCore, content: string): Token {
  const inline = new state.Token("inline", "", 0);
  inline.meta = { htmlBlock: true };
  inline.children = [];
  htmlTokenizer.inline.parse(content, htmlTokenizer, state.env, inline.children);
  return inline;
}

// Nunjucks string literals and null, comma-separated; anything else (variables, filters) is not editable.
function parseArguments(src: string): (string | null)[] | null {
  const arg = /\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|(null))\s*(,|$)/y;
  const values: (string | null)[] = [];
  for (let separator = ","; separator;) {
    const match = arg.exec(src);
    if (!match) return null;
    const text = match[1] ?? match[2];
    values.push(text == null ? null : text.replace(/\\([\s\S])/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c));
    separator = match[4];
  }
  return values;
}

function shortcodeArguments(name: keyof typeof shortcodes, node: Node): string {
  return shortcodes[name].args.map((arg) => nunjucksString(node.attrs[arg])).join(", ");
}

function nunjucksString(value: string | null): string {
  return value == null ? "null" : `"${value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r")}"`;
}

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
  blockquote: { block: "blockquote", getAttrs: (tok: Token) => ({ variant: tok.meta?.variant ?? null }) },
  details: { block: "details" },
  details_summary: { block: "details_summary" },
  html_paragraph: { block: "paragraph", attrs: { htmlBlock: true } },
  html_code: { mark: "code", getAttrs: extraAttrs },
  raw_inline: rawInline,
  html_inline: rawInline,
  raw_block: rawBlock,
  image_container: { node: "image_container", noCloseToken: true, getAttrs: (tok: Token) => tok.meta },
  video_container: { block: "video_container", getAttrs: (tok: Token) => tok.meta },
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
    blockquote(state, node, parent, index) {
      if (!node.attrs.variant) return defaultMarkdownSerializer.nodes.blockquote(state, node, parent, index);
      serializeHtmlContainer(state, node, `<blockquote class="${node.attrs.variant}-block block">`, "</blockquote>", 0);
    },
    details(state, node) {
      serializeHtmlContainer(state, node, `<details>\n  <summary>${serializeHtmlInline(node.firstChild!)}</summary>`, "</details>", 1);
    },
    raw_block(state, node) {
      state.text(node.attrs.content, false);
      state.closeBlock(node);
    },
    image_container(state, node) {
      state.text(`{% imageContainer ${shortcodeArguments("imageContainer", node)} %}`, false);
      state.closeBlock(node);
    },
    video_container(state, node) {
      state.text(`{% videoContainer ${shortcodeArguments("videoContainer", node)} %}\n  ${serializeHtmlInline(node)}\n{% endvideoContainer %}`, false);
      state.closeBlock(node);
    },
    raw_inline(state, node) {
      state.text(node.attrs.content, false);
    },
    text(state, node, parent, index) {
      // Text equal to its href may save as an autolink, where entities stay literal.
      const url = node.marks.some((mark) => mark.type.name === "link" && mark.attrs.href === node.text);
      defaultMarkdownSerializer.nodes.text(state, url ? node : schema.text(literalText(node.text!), node.marks), parent, index);
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

// Children from `from` on; a first HTML paragraph goes in the opening tag's HTML block, the rest as Markdown after a blank line.
function serializeHtmlContainer(state: MarkdownSerializerState, node: Node, open: string, end: string, from: number) {
  const first = node.maybeChild(from);
  const html = first?.type === schema.nodes.paragraph && first.attrs.htmlBlock;
  state.text(html ? `${open}\n${serializeHtmlInline(first)}` : open, false);
  for (let i = from + (html ? 1 : 0); i < node.childCount; i++) {
    state.closeBlock(node);
    state.render(node.child(i), node, i);
  }
  if (html && node.childCount === from + 1) state.text(`\n${end}`, false);
  else {
    state.closeBlock(node);
    state.text(end, false);
  }
  state.closeBlock(node);
}

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

// Typed text is literal (ADR 0003): an entity wherever it would open HTML, an entity or a Nunjucks tag.
// markdown-it decodes the entity, so the site shows the text as typed, and Nunjucks never sees a tag.
const nunjucksOpen = /\{(?=[{%#])/g;
function literalText(text: string): string {
  return text.replace(/&(?=#?\w+;)/g, "&amp;").replace(/<(?=[A-Za-z/!?])/g, "&lt;").replace(nunjucksOpen, "&#123;");
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
    if (node.isText) html += tokenizer.utils.escapeHtml(node.text!).replace(nunjucksOpen, "&#123;");
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
