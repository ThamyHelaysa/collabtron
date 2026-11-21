import { Plugin } from "prosemirror-state";
import { schema } from "../shared/markdown.ts";

// The schema only allows the Front Matter Block first; this keeps toolbar commands and deletions from removing it.
export const keepFrontMatter = new Plugin({
  filterTransaction: (tr) =>
    !tr.docChanged || tr.before.firstChild?.type !== schema.nodes.front_matter || tr.doc.firstChild?.type === schema.nodes.front_matter,
});
