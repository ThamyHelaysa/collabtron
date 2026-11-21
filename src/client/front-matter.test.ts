import { expect, test } from "vitest";
import { setBlockType } from "prosemirror-commands";
import { AllSelection, EditorState, TextSelection } from "prosemirror-state";
import { parse, schema, serialize } from "../shared/markdown.ts";
import { keepFrontMatter } from "./front-matter.ts";

const markdown = "---\ntitle: Lorem\n---\n\nIpsum\n";

test("the Front Matter Block cannot be turned into another block or deleted", () => {
  let state = EditorState.create({ doc: parse(markdown), plugins: [keepFrontMatter] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
  setBlockType(schema.nodes.heading, { level: 2 })(state, (tr) => (state = state.apply(tr)));
  state = state.apply(state.tr.setSelection(new AllSelection(state.doc)).deleteSelection());
  expect(serialize(state.doc)).toBe(markdown);
});

test("the Front Matter Block stays editable", () => {
  let state = EditorState.create({ doc: parse(markdown), plugins: [keepFrontMatter] });
  state = state.apply(state.tr.insertText("draft: true\n", 1));
  expect(serialize(state.doc)).toBe("---\ndraft: true\ntitle: Lorem\n---\n\nIpsum\n");
});
