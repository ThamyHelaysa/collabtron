# collabtron

A real-time collaborative editor for Eleventy blog posts. Two people edit the same Post live in the browser, and the result is saved back to the site as Markdown without losing the site's shortcodes or raw HTML.

## Language

**Post**:
One blog post of the target Eleventy site: a Markdown file with front matter, living in its own folder under the site's posts directory.
_Avoid_: article, document, file

**Post ID**:
The identifier of a Post, equal to its folder name (slug). Only meaningful when the Post Catalog recognises it.
_Avoid_: path, filename

**Post Catalog**:
The set of Posts the editor is allowed to open. The only way a Post ID becomes a Post.
_Avoid_: post list, index

**Front Matter Block**:
The Post's YAML front matter, shown as one raw text block at the top of the document and edited live like the rest.
_Avoid_: metadata, header

**Shortcode Block**:
A block the editor understands beyond plain Markdown (a known Nunjucks shortcode or a known house-style HTML block), shown as a card with editable fields. Collaborators create them only from the toolbar, never by typing.
_Avoid_: custom node, widget, embed

**Raw Block**:
A block the editor does not understand, kept opaque and preserved byte for byte. The editor never deletes what it does not understand.
_Avoid_: unknown block, fallback node, HTML block

**Raw Inline**:
An inline piece of HTML the editor does not understand, kept as one opaque atom inside a paragraph. It can be moved or deleted as a whole, not edited inside.
_Avoid_: inline HTML, raw span

**Preview**:
The Post's page as the site's own Eleventy renders it, shown beside the editor and refreshed after each save.
_Avoid_: render, live view

**Round-trip**:
Opening a Post in the editor and saving it back with no edits. A Round-trip is faithful when the site renders the same HTML before and after; bytes may differ.
_Avoid_: re-save, roundtrip test (for the property itself)

## Collaboration

**Collaborator**:
A person editing a Post in an Editing Session, identified only by a display name and colour chosen in their browser.
_Avoid_: user, author, client

**Share Link**:
The URL that lets a Collaborator join the Editing Session of one Post: it names the Post ID and carries the secret token.
_Avoid_: invite, edit URL

**Presence**:
The live cursor and selection of each Collaborator, visible to the others. Ephemeral: never part of the Step log.
_Avoid_: awareness, cursors

**Authority**:
The role that holds a Post's official Version and Step log, and accepts or rejects incoming Steps. One Authority per open Post. Distinct from the server process that hosts it.
_Avoid_: server, master, host

**Version**:
The count of Steps the Authority has accepted for a Post. A client's Steps are accepted only if based on the current Version.
_Avoid_: revision, seq

**Step**:
One atomic edit to a Post's document, in the ProseMirror sense. Steps are the unit the sync protocol orders, sends and rebases. The word is reserved for this meaning only.
_Avoid_: change, operation, edit, delta

**Editing Session**:
The span during which the server has a Post loaded and collaborators can edit it together.
_Avoid_: session (unqualified), room

**Instance ID**:
The random identifier of one Editing Session, sent to every tab that joins it. A tab coming back with the same one can resend its Steps; with another one, its Versions belong to an Authority that is gone.
_Avoid_: session ID, server ID

**Public Session**:
The span during which the editor is reachable from the internet (router port open, public mode on). An Editing Session can run without a Public Session (local development), never the reverse in practice.
_Avoid_: session (unqualified), live mode
