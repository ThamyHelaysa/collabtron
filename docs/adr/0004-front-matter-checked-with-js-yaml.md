# Front matter is checked with js-yaml's `load`, not gray-matter

The Front Matter Block is the Post's YAML as raw text, kept byte for byte (issue #9). The editor warns while the YAML is invalid, and the warning must match what the site build stops on. Eleventy reads front matter with `@11ty/gray-matter`, whose YAML engine is `js-yaml`'s `load`. So `frontMatterError` in `src/shared/markdown.ts` calls `load` directly, with `js-yaml` declared at the range gray-matter uses.

## Considered Options

- **gray-matter in the browser**: rejected. It requires `fs` and cannot be bundled for the client.
- **Checking only on save, on the Server**: rejected. The warning would come too late to help while typing.

## Consequences

- If the site moves to another gray-matter or YAML engine, update `js-yaml` here to match.
- The front matter is split off by `parse` and written back by `serialize`, so the Server reads and writes the whole Post file.
- The warning does not block saving.
