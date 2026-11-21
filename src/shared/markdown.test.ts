import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import MarkdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import { parse, serialize } from "./markdown.ts";

// The site's markdown-it configuration, minus Nunjucks and its private slugify.
const site = MarkdownIt({ html: true }).use(markdownItAnchor, {
  permalink: markdownItAnchor.permalink.linkInsideHeader({ symbol: "#", placement: "after", class: "header-anchor" }),
});
// shortcut: whitespace-only normalization (also collapses <pre>); switch to DOM normalization when `</br>` or code fixtures land (#5).
const render = (md: string) => site.render(md).replace(/\s+/g, " ").trim();

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
  expect(() => parse("<div>lorem</div>\n")).toThrow();
});
