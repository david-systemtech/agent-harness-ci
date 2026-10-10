import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const run = promisify(execFile);
let scratch: string | undefined;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

it("keeps pinned dependency patch bytes through a Windows-style Git checkout", async () => {
  scratch = mkdtempSync(join(tmpdir(), "patch-checkout-"));
  const cwd = scratch;
  const git = (...args: string[]) => run("git", ["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, "no-global-config") },
  });
  await git("init", "-q");
  if (existsSync(join(root, ".gitattributes"))) {
    writeFileSync(join(cwd, ".gitattributes"), readFileSync(join(root, ".gitattributes")));
  }
  mkdirSync(join(cwd, "patches"));
  const patches = readdirSync(join(root, "patches")).filter((name) => name.endsWith(".patch"));
  expect(patches.length).toBeGreaterThan(0);
  for (const name of patches) {
    const path = join("patches", name);
    const pinned = readFileSync(join(root, path));
    writeFileSync(join(cwd, path), pinned);
    await git("add", path);
    rmSync(join(cwd, path));
    await git("checkout-index", "--", path);
    // Native source provenance and frozen patch hashes depend on these exact bytes (#2056).
    expect(readFileSync(join(cwd, path)), name).toEqual(pinned);
  }
});
