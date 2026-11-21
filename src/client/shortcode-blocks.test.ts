// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parse, serialize } from "../shared/markdown.ts";
import { exitCaption, insertImageContainer, insertVideoContainer, shortcodeViews } from "./shortcode-blocks.ts";

let view: EditorView;
afterEach(() => view.destroy());

function open(markdown: string) {
  view = new EditorView(document.body.appendChild(document.createElement("div")), {
    state: EditorState.create({ doc: parse(markdown) }),
    nodeViews: shortcodeViews,
  });
  return view;
}

function field(label: string) {
  const input = [...view.dom.querySelectorAll("label")].find((l) => l.textContent!.startsWith(label))?.querySelector("input");
  if (!input) throw new Error(`No field labelled ${label}`);
  return input;
}

function type(label: string, value: string) {
  const input = field(label);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("edits image container arguments through form fields", () => {
  open('{% imageContainer "Lorem", "ipsum.jpg", null, "Dolor" %}\n');
  expect(field("Caption").value).toBe("Lorem");
  expect(field("Mobile file").value).toBe("");

  type("Alt text", 'Sit "amet"');
  type("Mobile file", "ipsum-mobile.jpg");
  expect(serialize(view.state.doc)).toBe('{% imageContainer "Lorem", "ipsum.jpg", "ipsum-mobile.jpg", "Sit \\"amet\\"" %}\n');

  // An emptied optional field saves as null; the site treats both alike.
  type("Mobile file", "");
  expect(serialize(view.state.doc)).toBe('{% imageContainer "Lorem", "ipsum.jpg", null, "Sit \\"amet\\"" %}\n');
});

test("edits video container arguments as fields and its caption as document text", () => {
  open('{% videoContainer "lorem.mp4", null, "loop" %}\n  Ipsum <strong>dolor</strong>\n{% endvideoContainer %}\n');
  expect(view.dom.querySelector("figcaption")!.innerHTML).toBe("Ipsum <strong>dolor</strong>");

  type("Video attributes", "");
  view.dispatch(view.state.tr.insertText("sit ", 1));
  expect(serialize(view.state.doc)).toBe('{% videoContainer "lorem.mp4", null, null %}\n  sit Ipsum <strong>dolor</strong>\n{% endvideoContainer %}\n');
});

test("updates fields when the document changes underneath", () => {
  open('{% imageContainer "Lorem", "ipsum.jpg", null, "Dolor" %}\n');
  view.dispatch(view.state.tr.setNodeAttribute(0, "caption", "Sit"));
  expect(field("Caption").value).toBe("Sit");
});

test.each([
  [insertImageContainer, '{% imageContainer "", "", null, "" %}'],
  [insertVideoContainer, '{% videoContainer "", null, null %}\n  \n{% endvideoContainer %}'],
])("toolbar inserts a container after the current block", (insert, shortcode) => {
  open("Lorem\n");
  expect(insert(view.state, view.dispatch)).toBe(true);
  expect(serialize(view.state.doc)).toBe(`Lorem\n\n${shortcode}\n`);
});

test("Enter in a video caption leaves the card instead of splitting the video", () => {
  open('{% videoContainer "lorem.mp4", null, null %}\n  Ipsum dolor\n{% endvideoContainer %}\n');
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + "Ipsum".length)));
  expect(exitCaption(view.state, view.dispatch)).toBe(true);
  view.dispatch(view.state.tr.insertText("Sit"));
  expect(serialize(view.state.doc)).toBe('{% videoContainer "lorem.mp4", null, null %}\n  Ipsum dolor\n{% endvideoContainer %}\n\nSit\n');
});
