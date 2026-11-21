import { describe, expect, test } from "vitest";
import { EditorState, NodeSelection } from "prosemirror-state";
import { readdirSync, readFileSync } from "node:fs";
import MarkdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import { parse, schema, serialize } from "./markdown.ts";
import { normalizeHtml } from "../../test/normalize-html.ts";

// The site's markdown-it configuration, minus Nunjucks and its private slugify.
const site = MarkdownIt({ html: true }).use(markdownItAnchor, {
  permalink: markdownItAnchor.permalink.linkInsideHeader({ symbol: "#", placement: "after", class: "header-anchor" }),
});
const render = (md: string) => normalizeHtml(site.render(md));

const fixturesDir = new URL("../../test/fixtures/roundtrip/", import.meta.url);

describe("light Round-trip", () => {
  for (const name of readdirSync(fixturesDir).filter((f) => f.endsWith(".md"))) {
    test(name, () => {
      const md = readFileSync(new URL(name, fixturesDir), "utf8");
      expect(render(serialize(parse(md)))).toBe(render(md));
    });
  }
});

test("shows formatting as document structure, not Markdown syntax", () => {
  const doc = parse("## Lorem\n\n**ipsum**\n");
  expect(doc.child(0).type.name).toBe("heading");
  expect(doc.child(0).textContent).toBe("Lorem");
  expect(doc.child(1).textContent).toBe("ipsum");
  expect(doc.child(1).child(0).marks.map((m) => m.type.name)).toEqual(["strong"]);
});

test("serializes in house style: ** bold, - bullets, ATX headings", () => {
  const md = serialize(parse("Lorem\n=====\n\n__ipsum__\n\n* dolor\n* sit\n"));
  expect(md).toBe("# Lorem\n\n**ipsum**\n\n- dolor\n- sit\n");
});

test("refuses Markdown it cannot represent instead of dropping it", () => {
  expect(() => parse("| lorem |\n| - |\n| ipsum |\n")).toThrow();
});

test("keeps an unknown HTML block as a Raw Block, byte for byte", () => {
  const markdown = "Lorem\n\n<div class=\"x\">\n  **ipsum**  &amp;\n</div>\n\nDolor\n";
  const doc = parse(markdown);
  expect(doc.child(1).type.name).toBe("raw_block");
  expect(serialize(doc)).toBe(markdown);
});

test("parses HTML strikethrough as an editable mark and saves it as <s>", () => {
  const doc = parse("Lorem <s>ipsum **dolor**</s>.\n");
  expect(doc.firstChild!.child(1).marks.map((mark) => mark.type.name)).toEqual(["strikethrough"]);
  expect(serialize(doc)).toBe("Lorem <s>ipsum **dolor**</s>.\n");
  expect(serialize(parse("~~ipsum~~"))).toBe("<s>ipsum</s>\n");
  const marked = schema.node("doc", null, [schema.node("paragraph", null, [
    schema.text("ipsum", [schema.marks.strikethrough.create()]),
  ])]);
  expect(serialize(marked)).toBe("<s>ipsum</s>\n");
});

test("saves external links in house style, preserving escaped attributes", () => {
  const doc = parse('[Lorem](https://example.com/?a=1&b=2 "A & B")');
  expect(serialize(doc)).toBe('<a href="https://example.com/?a=1&amp;b=2" rel="noreferrer" target="_blank" title="A &amp; B">Lorem</a>\n');
  expect(parse(serialize(doc)).eq(doc)).toBe(true);
  const html = '<a target="_blank" title="A &quot;quote&quot;" rel="noreferrer" href="https://example.com/">**Lorem**</a>';
  const link = parse(html).firstChild!.firstChild!.marks.find((mark) => mark.type.name === "link")!;
  expect(link.attrs).toEqual({ href: "https://example.com/", title: 'A "quote"' });
  expect(render(serialize(parse(html)))).toBe(render(html));
});

test("keeps relative links in Markdown", () => {
  expect(serialize(parse('[Lorem](/posts/lorem "Ipsum") [dolor](#sit)')))
    .toBe('[Lorem](/posts/lorem "Ipsum") [dolor](#sit)\n');
});

test.each(["<br/>", "</br>", "<br>", "<br />", "  \n", "\\\n"])("saves hard breaks as </br>: %j", (br) => {
  const doc = parse(`Lorem${br}ipsum`);
  expect(doc.firstChild!.child(1).type.name).toBe("hard_break");
  expect(serialize(doc)).toBe("Lorem</br>ipsum\n");
});

test("preserves consecutive and trailing hard breaks", () => {
  expect(serialize(parse("Lorem<br/></br>ipsum</br>"))).toBe("Lorem</br></br>ipsum</br>\n");
});

test.each(["<br/>", "</br>"])("recognizes a hard break on its own line: %s", (markdown) => {
  expect(parse(markdown).firstChild!.firstChild!.type.name).toBe("hard_break");
  expect(serialize(parse(markdown))).toBe("</br>\n");
});

test.each([
  'Lorem <a href="javascript:alert(1)">ipsum</a>',
  'Lorem <a href="https://example.com" data-extra="keep">ipsum</a>',
  'Lorem <a href="https://example.com" rel="nofollow">ipsum</a>',
  'Lorem <a href="https://example.com" target="frame">ipsum</a>',
  'Lorem <a href="/posts/lorem" rel="noreferrer" target="_blank">ipsum</a>',
  "Lorem <a>ipsum</a>",
  'Lorem <s class="keep">ipsum</s>',
  "Lorem <s>ipsum",
  "Lorem ipsum</s>",
  "Lorem <s><s>ipsum</s></s>",
  "<s>one ~~two~~ three</s>",
  '<a href="https://example.com" rel="noreferrer" target="_blank">one [two](/posts/lorem) three</a>',
  'Lorem <s><a href="https://example.com">ipsum</s></a>',
])("refuses unsupported or unbalanced HTML instead of losing it: %s", (markdown) => {
  expect(() => parse(markdown)).toThrow();
});

test("recognizes supported marks and breaks in an HTML block without interpreting Markdown", () => {
  const markdown = '<br/>\n**Lorem** &lt;ipsum&gt; &amp; dolor\n<br/>\n<s>sit</s> <a href="https://example.com" rel="noreferrer" target="_blank">amet</a>\n';
  const doc = parse(markdown);
  expect(doc.firstChild!.firstChild!.type.name).toBe("hard_break");
  expect(doc.textContent).toContain("**Lorem** <ipsum> & dolor");
  expect(render(serialize(doc))).toBe(render(markdown));
});

test("keeps newly applied formatting editable in a block starting with a break", () => {
  const doc = schema.node("doc", null, [schema.node("paragraph", { htmlBlock: true }, [
    schema.nodes.hard_break.create(),
    schema.text("\n"),
    schema.text("<ipsum> & dolor", [schema.marks.strong.create(), schema.marks.code.create()]),
  ])]);
  const markdown = serialize(doc);
  expect(markdown).toBe("</br>\n<strong><code>&lt;ipsum&gt; &amp; dolor</code></strong>\n");
  expect(parse(markdown).eq(doc)).toBe(true);
});

test("preserves literal text and formatting after deleting an HTML block's leading break", () => {
  const doc = parse("<br/>\n**literal**\n");
  const edited = schema.node("doc", null, [schema.node("paragraph", doc.firstChild!.attrs, [
    schema.text("**literal**"),
    schema.text(" code", [schema.marks.code.create()]),
  ])]);
  const reopened = parse(serialize(edited));
  expect(reopened.textContent).toBe("**literal** code");
  expect(reopened.firstChild!.firstChild!.marks).toEqual([]);
  expect(reopened.firstChild!.lastChild!.marks.map((mark) => mark.type.name)).toEqual(["code"]);
});

test.each([
  '{% raw %}\n# {{ lorem }}\n\n*ipsum*\n{% endraw %}',
  '{% sectionBlock "Lorem", "Ipsum" %}\n\n## Dolor\n\n{% sectionBlock "Nested" %}\nsit\n{% endsectionBlock %}\n\n{%- endsectionBlock -%}',
  '{% blogSectionBlock "Lorem" %}\nipsum\n{% endblogSectionBlock %}\nstill raw until a blank line',
  '{% imageContainer\n  "lorem.png",\n  "Ipsum _dolor_" %}',
  '{% unknownThing a_b %}',
])("keeps an unknown block shortcode as a Raw Block, byte for byte: %j", (shortcode) => {
  const markdown = `Lorem\n\n${shortcode}\n\nDolor\n`;
  const doc = parse(markdown);
  expect(doc.childCount).toBe(3);
  expect(doc.child(1).type.name).toBe("raw_block");
  expect(serialize(doc)).toBe(markdown);
});

test.each([
  "```\n{% raw %}\n{{ lorem_ipsum }}\n```\n",
  "    {% raw %}\n    {{ lorem }}\n",
])("leaves Nunjucks inside code blocks as literal code: %j", (markdown) => {
  const doc = parse(markdown);
  expect(doc.firstChild!.type.name).toBe("code_block");
  expect(doc.textContent).toContain("{% raw %}\n{{ lorem");
  expect(render(serialize(doc))).toBe(render(markdown));
});

test.each([
  ["Lorem {{ ipsum_dolor | sit }} amet_", ["{{ ipsum_dolor | sit }}"]],
  ['Lorem {% imageContainer "a_b.png" %} *ipsum*', ['{% imageContainer "a_b.png" %}']],
  ["{# lorem_ipsum #} dolor", ["{# lorem_ipsum #}"]],
  ['Lorem <span class="x">ipsum</span>', ['<span class="x">', "</span>"]],
  ["Lorem <br class='keep'>ipsum", ["<br class='keep'>"]],
  ["Lorem\n{% raw %}ipsum{% endraw %}", ["{% raw %}", "{% endraw %}"]],
  ['<br/>\nLorem {{ "ipsum" }} <span>&amp;</span>\n', ['{{ "ipsum" }}', "<span>", "</span>"]],
])("keeps unknown Nunjucks and inline HTML as Raw Inline atoms: %j", (markdown, raws) => {
  const doc = parse(markdown);
  const found: string[] = [];
  doc.descendants((node) => { if (node.type.name === "raw_inline") found.push(node.attrs.content); });
  expect(found).toEqual(raws);
  for (const raw of raws) expect(serialize(doc)).toContain(raw);
  expect(render(serialize(doc))).toBe(render(markdown));
});

test("leaves Nunjucks inside inline code as literal code", () => {
  const doc = parse("Lorem `{{ ipsum }}`");
  expect(doc.firstChild!.lastChild!.text).toBe("{{ ipsum }}");
  expect(doc.firstChild!.lastChild!.marks.map((mark) => mark.type.name)).toEqual(["code"]);
});

test("selects, moves and deletes a Raw Block and a Raw Inline only as a whole", () => {
  const doc = parse("Lorem {{ ipsum }} dolor\n\n<div>\nsit\n</div>\n");
  const inlinePos = 1 + "Lorem ".length;
  const blockPos = doc.firstChild!.nodeSize;
  const inline = NodeSelection.create(doc, inlinePos);
  const block = NodeSelection.create(doc, blockPos);
  expect(inline.node.type.name).toBe("raw_inline");
  expect(block.node.type.name).toBe("raw_block");
  expect(inline.node.isAtom && block.node.isAtom).toBe(true);

  const state = EditorState.create({ doc });
  expect(serialize(state.apply(state.tr.setSelection(inline).deleteSelection()).doc)).toBe("Lorem  dolor\n\n<div>\nsit\n</div>\n");
  expect(serialize(state.apply(state.tr.setSelection(block).deleteSelection()).doc)).toBe("Lorem {{ ipsum }} dolor\n");
  const moved = state.tr.delete(blockPos, blockPos + block.node.nodeSize).insert(0, block.node);
  expect(serialize(moved.doc)).toBe("<div>\nsit\n</div>\n\nLorem {{ ipsum }} dolor\n");
});

test("keeps Raw Inline atoms in headings", () => {
  const markdown = "Lorem\n\n## Ipsum {{ dolor }} <span>sit</span>\n\nAmet\n";
  const doc = parse(markdown);
  expect(doc.child(1).type.name).toBe("heading");
  expect(serialize(doc)).toBe(markdown);
});

test("refuses Nunjucks or HTML in image alt text instead of dropping it", () => {
  expect(() => parse("![Lorem {{ ipsum }}](/dolor.png)")).toThrow();
  expect(() => parse("![Lorem <span>ipsum</span>](/dolor.png)")).toThrow();
});
