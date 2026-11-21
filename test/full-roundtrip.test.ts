import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const command = fileURLToPath(new URL("../scripts/full-roundtrip.ts", import.meta.url));
let root: string;
let site: string;

function git(...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function post(id: string, content: string) {
  await mkdir(join(site, "src/posts", id), { recursive: true });
  await writeFile(join(site, "src/posts", id, "index.md"), content);
}

function run() {
  const env = { ...process.env };
  delete env.SITE_DIR;
  delete env.POSTS_DIR;
  try {
    const stdout = execFileSync(process.execPath, ["--env-file=.env", command], {
      cwd: root, encoding: "utf8", env,
      stdio: "pipe",
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, output: failure.stdout + failure.stderr };
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "collabtron-roundtrip-test-"));
  site = join(root, "site");
  await mkdir(join(site, "node_modules/@11ty/eleventy"), { recursive: true });
  await mkdir(join(site, "node_modules/tsx"), { recursive: true });
  await writeFile(join(root, ".env"), "SITE_DIR=site\nPOSTS_DIR=site/src/posts\n");
  await writeFile(join(root, ".gitignore"), "node_modules/\n.env\ndist/\n");
  await writeFile(join(site, "package.json"), '{"type":"module"}');
  await writeFile(join(site, "eleventy.config.ts"), "export default function () { return {}; }\n");
  await writeFile(join(site, "node_modules/tsx/package.json"), '{"exports":{"./cli":"./cli.mjs"}}');
  await writeFile(join(site, "node_modules/tsx/cli.mjs"), `
    import { pathToFileURL } from "node:url";
    await import(pathToFileURL(process.argv[2]));
  `);
  // Stand-in for the external site's build tool; the command and codec run unchanged.
  await writeFile(join(site, "node_modules/@11ty/eleventy/cmd.cjs"), `
    (async () => {
      const fs = require("node:fs/promises");
      const path = require("node:path");
      const { pathToFileURL } = require("node:url");
      const markdown = require(${JSON.stringify(require.resolve("markdown-it"))})({ html: true });
      const matter = require(${JSON.stringify(require.resolve("@11ty/gray-matter"))});
      const handlers = new Map();
      const config = await import(pathToFileURL(process.argv.find(a => a.startsWith("--config=")).slice(9)));
      await config.default({ on: (name, fn) => handlers.set(name, fn) });
      const results = [];
      for (const id of await fs.readdir("src/posts")) {
        const inputPath = path.join("src/posts", id, "index.md");
        const text = await fs.readFile(inputPath, "utf8");
        const { data, content } = matter(text);
        if (data.draft === true) continue;
        if (id.startsWith("collabtron-fixture-") && !data.eleventyExcludeFromCollections) throw new Error("Fixture leaked into site collections");
        if (data.failBuild === "always" || (data.failBuild && content.includes("**"))) throw new Error("Site build failed");
        const original = content.includes("__");
        if (data.disappear && !original) continue;
        const outputPath = path.join("dist/blog/2000", id, "index.html");
        let html = markdown.render(content);
        if (data.echoSource) html += "<pre>" + content + "</pre>";
        if (data.normalize) html += original ? '<br/><a title="Ipsum" href="/lorem">Dolor</a>' : '</br><a href="/lorem" title="Ipsum">Dolor</a>';
        if (data.preWhitespace) html += original ? '<pre>a  b</pre>' : '<pre>a b</pre>';
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, html);
        results.push({ inputPath, outputPath, content: html });
      }
      await handlers.get("eleventy.after")({ results });
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  await post("lorem", "---\ntitle: Lorem\ndate: 2000-01-01\n---\n\n__Ipsum__\n");
  await post("draft", "---\ndraft: true # not published\n---\n\n<div>Unsupported draft</div>\n");
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "test: add site");
});

afterEach(async () => {
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  await rm(root, { recursive: true, force: true });
});

test("compares published Posts and synthetic fixtures at HEAD without changing the clone", async () => {
  await post("lorem", "Local uncommitted text\n");
  const result = run();

  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("13 Post pages match");
  expect(await readFile(join(site, "src/posts/lorem/index.md"), "utf8")).toBe("Local uncommitted text\n");
  expect(git("status", "--short")).toBe(" M site/src/posts/lorem/index.md\n");
});

async function commitPosts() {
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "test: update Posts");
}

test("fails and lists every Post page whose HTML differs", async () => {
  for (const id of ["lorem", "ipsum"]) await post(id, "---\nechoSource: true\n---\n\n__Dolor__\n");
  await commitPosts();

  const result = run();

  expect(result.status).toBe(1);
  expect(result.output).toContain("HTML differs: dist/blog/2000/lorem/index.html");
  expect(result.output).toContain("HTML differs: dist/blog/2000/ipsum/index.html");
});

test("normalizes attribute order and equivalent HTML break syntax", async () => {
  await post("lorem", "---\nnormalize: true\n---\n\n__Ipsum__\n");
  await commitPosts();

  const result = run();

  expect(result.status, result.output).toBe(0);
});

test("preserves significant whitespace in preformatted HTML", async () => {
  await post("lorem", "---\npreWhitespace: true\n---\n\n__Ipsum__\n");
  await commitPosts();

  const result = run();

  expect(result.status).toBe(1);
  expect(result.output).toContain("HTML differs: dist/blog/2000/lorem/index.html");
});

test.each(["always", true])("cleans up when build A or B fails (%s)", async failBuild => {
  await post("lorem", `---\nfailBuild: ${failBuild}\n---\n\n__Ipsum__\n`);
  await commitPosts();

  const result = run();

  expect(result.status).toBe(1);
  expect(result.output).toContain("Site build failed");
});

test("reports unsupported Posts and still compares the remaining pages", async () => {
  await post("lorem", "<div>Unsupported published Post</div>\n");
  await post("ipsum", "---\nechoSource: true\n---\n\n__Dolor__\n");
  await commitPosts();

  const result = run();

  expect(result.status).toBe(1);
  expect(result.output).toContain("Round-trip failed: lorem");
  expect(result.output).toContain("HTML differs: dist/blog/2000/ipsum/index.html");
});

test("reports disappeared pages together with other HTML differences", async () => {
  await post("lorem", "---\ndisappear: true\n---\n\n__Ipsum__\n");
  await post("ipsum", "---\nechoSource: true\n---\n\n__Dolor__\n");
  await commitPosts();

  const result = run();

  expect(result.status).toBe(1);
  expect(result.output).toContain("HTML differs: dist/blog/2000/lorem/index.html");
  expect(result.output).toContain("HTML differs: dist/blog/2000/ipsum/index.html");
});

test("refuses a fixture name collision instead of overwriting a real Post", async () => {
  await post("collabtron-fixture-bold", "Real Post\n");
  await commitPosts();

  expect(run().status).toBe(1);
  expect(await readFile(join(site, "src/posts/collabtron-fixture-bold/index.md"), "utf8")).toBe("Real Post\n");
});

test("refuses a Post symlink that escapes the worktree", async () => {
  const original = await readFile(join(site, "src/posts/lorem/index.md"), "utf8");
  await mkdir(join(site, "src/posts/linked"));
  await symlink(join(site, "src/posts/lorem/index.md"), join(site, "src/posts/linked/index.md"));
  await commitPosts();

  expect(run().status).toBe(1);
  expect(await readFile(join(site, "src/posts/lorem/index.md"), "utf8")).toBe(original);
});

test("requires the site's location from the env file", async () => {
  await writeFile(join(root, ".env"), "");

  const result = run();

  expect(result.status).toBe(1);
  expect(result.output).toContain("Set SITE_DIR and POSTS_DIR in .env");
});

test("uses the editor's Post Catalog validation", async () => {
  await post("invalid Post ID", "Lorem\n");
  await commitPosts();

  const result = run();

  expect(result.status).toBe(1);
  expect(result.output).toContain('Post ID "invalid Post ID" is not a folder name');
});
