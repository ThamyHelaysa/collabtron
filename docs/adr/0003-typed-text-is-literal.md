# Typed text is literal; house-style elements come only from the toolbar

Shortcode Blocks are created only from the toolbar. Today those are shortcodes, callouts and details. Whatever a Collaborator types is text, and the site shows it exactly as typed. Typing `</blockquote>`, `<div>` or `{% endvideoContainer %}` must never turn into HTML or a shortcode. Otherwise one typed line could close a callout early or break the site build (issue #29).

To keep it literal, the serializer swaps in an HTML entity only where the text would otherwise open something:

- `&` before an entity-like `name;` becomes `&amp;`
- `<` before a letter, `/`, `!` or `?` becomes `&lt;`
- each `{` before `{`, `%` or `#`, or at the end of a text node, becomes `&#123;`. The next node may be a Raw Inline that starts with `{`.

markdown-it decodes these entities, so the site shows the original characters. Nunjucks runs first and never decodes them, so it never sees a tag. The code is `literalText` in `src/shared/markdown.ts`. Text inside HTML content (captions, summaries, a callout's first lines) is HTML-escaped as before, and `{` gets the same entity.

## Considered Options

- **`\<` (Markdown backslash escape)**: rejected. It works only in Markdown. Inside an HTML block the backslash shows up on the page.
- **`{% raw %}…{% endraw %}` around Nunjucks-looking text**: rejected. It clutters the Post file for a few characters.
- **Escaping every `<`, `&` and `{`**: rejected. It rewrites much more of every Post's text on each save for no gain.

## Consequences

- Existing Posts render the same. Only text nodes are escaped. Raw Blocks, Raw Inlines and Shortcode Block fields are left as read. An entity renders as the character it replaces. A Post's own HTML and Nunjucks already parse into Raw Blocks and Raw Inlines, so no tag of the Post is ever escaped. The full Round-trip checks this.
- **Not covered:** inline code and code blocks are written raw, because entities would show up literally in code. Nunjucks still runs there, so Posts protect code with `{% raw %}` themselves. Also not covered: autolink text (`<mailto:…>`, where entities stay literal; HTML links are escaped), image alt text, and Shortcode Block fields.
- Do not "simplify" the escapes back to plain characters. The round-trip tests in `src/shared/markdown.test.ts` ("typed text in a … saves as literal text") will fail if you do.
