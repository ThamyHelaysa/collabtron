// Fails when package-lock.json lacks packages a from-scratch resolution includes.
// An incremental `npm install` on macOS can prune optional deps that `npm ci` on Linux still requires.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const packages = (lockDir: string) =>
  new Set(Object.keys(JSON.parse(readFileSync(join(lockDir, "package-lock.json"), "utf8")).packages));

const fresh = mkdtempSync(join(tmpdir(), "lockcheck-"));
try {
  copyFileSync(join(dir, "package.json"), join(fresh, "package.json"));
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: fresh, stdio: "ignore" });
  const committed = packages(dir);
  const missing = [...packages(fresh)].filter((p) => !committed.has(p));
  if (missing.length) {
    console.error(`package-lock.json is missing ${missing.length} package(s) a clean install needs:\n  ${missing.join("\n  ")}`);
    console.error("Fix: rm -rf node_modules package-lock.json && npm install");
    process.exit(1);
  }
} finally {
  rmSync(fresh, { recursive: true, force: true });
}
