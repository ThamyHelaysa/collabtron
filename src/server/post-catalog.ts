import { access } from "node:fs/promises";
import { join } from "node:path";

export type Post = { id: string; file: string };
export type PostCatalog = { get(id: string): Post | undefined };

// A Post ID is a folder name (slug): no separators, no dot segments.
const postIdPattern = /^[a-z0-9][a-z0-9_-]*$/i;

export async function createPostCatalog(postsDir: string, ids: string[]): Promise<PostCatalog> {
  const posts = new Map<string, Post>();
  for (const id of ids) {
    if (!postIdPattern.test(id)) throw new Error(`Post ID "${id}" is not a folder name`);
    const file = join(postsDir, id, "index.md");
    await access(file).catch(() => {
      throw new Error(`Post ID "${id}": no ${file}`);
    });
    posts.set(id, { id, file });
  }
  // Lookup only: a requested ID never becomes a path.
  return { get: (id) => posts.get(id) };
}
