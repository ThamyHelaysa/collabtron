import { parse, serialize } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

export function normalizeHtml(html: string): string {
  const document = parse(html);
  function normalize(node: DefaultTreeAdapterTypes.Node, preserve = false) {
    if ("tagName" in node) {
      node.attrs.sort((a, b) => `${a.namespace ?? ""}:${a.name}`.localeCompare(`${b.namespace ?? ""}:${b.name}`));
      preserve ||= ["pre", "textarea", "script", "style"].includes(node.tagName);
      if (node.tagName === "template") normalize((node as DefaultTreeAdapterTypes.Template).content, preserve);
    }
    if ("value" in node && !preserve) node.value = node.value.replace(/[\t\n\f\r ]+/g, " ");
    if ("childNodes" in node) for (const child of node.childNodes) normalize(child, preserve);
  }
  normalize(document);
  return serialize(document);
}
