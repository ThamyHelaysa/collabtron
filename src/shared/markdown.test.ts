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

const linked = (text: string, attrs: object) => schema.node("doc", null, [schema.node("paragraph", null, [
  schema.text(text, [schema.marks.link.create(attrs)]),
])]);
const linkOf = (doc: ReturnType<typeof parse>) => doc.firstChild!.firstChild!.marks.find((mark) => mark.type.name === "link")!;

test("saves new external links in house style HTML, preserving escaped attributes", () => {
  const doc = linked("Lorem", { href: "https://example.com/?a=1&b=2", title: "A & B" });
  expect(serialize(doc)).toBe('<a href="https://example.com/?a=1&amp;b=2" title="A &amp; B" rel="noreferrer" target="_blank">Lorem</a>\n');
  expect(serialize(linked("Lorem", { href: "/posts/lorem" }))).toBe("[Lorem](/posts/lorem)\n");
  const html = '<a target="_blank" title="A &quot;quote&quot;" rel="noreferrer" href="https://example.com/">**Lorem**</a>';
  expect(linkOf(parse(html)).attrs).toEqual({ href: "https://example.com/", title: 'A "quote"', wrapped: false, html: true, extra: {} });
  expect(serialize(parse(html))).toBe('<a href="https://example.com/" title="A &quot;quote&quot;" rel="noreferrer" target="_blank">**Lorem**</a>\n');
});

test("saves a link in the form it was parsed", () => {
  expect(serialize(parse('[Lorem](https://example.com/ "Ipsum")'))).toBe('[Lorem](https://example.com/ "Ipsum")\n');
  expect(serialize(parse('<a href="/posts/lorem">Ipsum</a>'))).toBe('<a href="/posts/lorem">Ipsum</a>\n');
});

test("keeps unknown attributes hidden from Collaborators and saves them after href and title", () => {
  const doc = parse('<a data-x="1" href="/posts/lorem" rel="internal" title="Ipsum">dolor</a>');
  expect(linkOf(doc).attrs).toMatchObject({ href: "/posts/lorem", title: "Ipsum", extra: { "data-x": "1", rel: "internal" } });
  expect(serialize(doc)).toBe('<a href="/posts/lorem" title="Ipsum" data-x="1" rel="internal">dolor</a>\n');
  expect(serialize(parse('<s class="lorem" id="ipsum">dolor</s>'))).toBe('<s class="lorem" id="ipsum">dolor</s>\n');
});

test("never renders kept attributes in the editor", () => {
  const doc = parse('<a href="/posts/lorem" onclick="alert(1)">ipsum</a> <s style="color:red">dolor</s>\n\n</br>\n<em onmouseover="alert(1)">sit</em>');
  const rendered: unknown[] = [];
  doc.descendants((node) => { for (const mark of node.marks) rendered.push(mark.type.spec.toDOM!(mark, true)); });
  expect(JSON.stringify(rendered)).not.toMatch(/onclick|style|onmouseover/);
  expect(serialize(doc)).toContain('<a href="/posts/lorem" onclick="alert(1)">');
  expect(serialize(doc)).toContain('<em onmouseover="alert(1)">');
  expect(serialize(parse('<a href="/posts/lorem" title="">ipsum</a>'))).toBe('<a href="/posts/lorem" title="">ipsum</a>\n');
});

test("gives a link house-style rel and target once its href becomes external", () => {
  const doc = parse('<a href="/posts/lorem" rel="internal" data-x="1">ipsum</a>');
  const link = linkOf(doc);
  const state = EditorState.create({ doc });
  const end = doc.content.size - 1;
  const edited = state.apply(state.tr.removeMark(1, end, link)
    .addMark(1, end, schema.marks.link.create({ ...link.attrs, href: "https://example.com/" }))).doc;
  expect(serialize(edited)).toBe('<a href="https://example.com/" data-x="1" rel="noreferrer" target="_blank">ipsum</a>\n');
  expect(serialize(parse('<a href="https://example.com/" rel="nofollow" target="frame">ipsum</a>')))
    .toBe('<a href="https://example.com/" rel="noreferrer" target="_blank">ipsum</a>\n');
});

test("keeps relative links in Markdown", () => {
  expect(serialize(parse('[Lorem](/posts/lorem "Ipsum") [dolor](#sit)')))
    .toBe('[Lorem](/posts/lorem "Ipsum") [dolor](#sit)\n');
});

test.each([
  ["<br/>", "Lorem</br>ipsum\n"],
  ["</br>", "Lorem</br>ipsum\n"],
  ["<br>", "Lorem</br>ipsum\n"],
  ["<br />", "Lorem</br>ipsum\n"],
  // A Markdown break renders as <br> plus the newline it ends.
  ["  \n", "Lorem</br> ipsum\n"],
  ["\\\n", "Lorem</br> ipsum\n"],
])("saves hard breaks as </br>: %j", (br, saved) => {
  const doc = parse(`Lorem${br}ipsum`);
  expect(doc.firstChild!.child(1).type.name).toBe("hard_break");
  expect(serialize(doc)).toBe(saved);
  expect(render(saved)).toBe(render(`Lorem${br}ipsum`));
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
  "Lorem <a>ipsum</a>",
  "Lorem <s>ipsum",
  "Lorem ipsum</s>",
  "Lorem <s><s>ipsum</s></s>",
  "<s>one ~~two~~ three</s>",
  '<a href="https://example.com" rel="noreferrer" target="_blank">one [two](/posts/lorem) three</a>',
  'Lorem <s><a href="https://example.com">ipsum</s></a>',
  "*[**Lorem**](/ipsum)*",
  "~~[*Lorem*](/ipsum)~~",
  '</br>\n<em class="x"><a href="/ipsum"><strong>Lorem</strong></a></em>',
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

const external = '<a href="https://example.com/" rel="noreferrer" target="_blank">';
test.each([
  "**[Lorem](/ipsum)**",
  "[**Lorem**](/ipsum)",
  "**[Lorem](/ipsum) dolor**",
  "**Lorem [ipsum](/dolor)**",
  "[**Lorem** ipsum](/dolor)",
  "***[Lorem](/ipsum)***",
  "<s>[Lorem](/ipsum) dolor</s>",
  `**${external}Lorem</a>**`,
  `${external}**Lorem**</a>`,
  `</br>\n<strong>${external}Lorem</a></strong>`,
  `</br>\n${external}<strong>Lorem</strong></a>`,
  "*[**Lorem** ipsum](/dolor) sit*",
  "*[Lorem](/ipsum) **dolor***",
  "[*Lorem*](/ipsum) *dolor*",
])("keeps marks inside or outside a link as written: %j", (markdown) => {
  expect(serialize(parse(markdown))).toBe(`${markdown}\n`);
});

test("keeps mark attributes as HTML after deleting an HTML block's leading break", () => {
  const doc = parse('<br/>\n<strong class="lorem">ipsum</strong> <em id="dolor">sit</em> <code class="amet">x</code>\n');
  const strip = (keep: (name: string) => boolean) => schema.node("doc", null, [schema.node("paragraph", null,
    doc.firstChild!.content.content.slice(2).filter((node) => node.marks.every((mark) => keep(mark.type.name))))]);
  expect(serialize(strip((name) => name !== "code"))).toBe('<strong class="lorem">ipsum</strong> <em id="dolor">sit</em> \n');
  expect(() => serialize(strip(() => true))).toThrow();
});
