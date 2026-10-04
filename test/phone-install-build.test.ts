import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { removeTree } from "../packages/filesystem/src/index.js";

it("builds a root worker with an exact public asset list and a content-versioned cache", async () => {
  const out = await mkdtemp(join(tmpdir(), "phone-install-build-"));
  try {
    await promisify(execFile)("pnpm", ["exec", "vite", "build", "--outDir", out], { cwd: resolve("packages/gui"), maxBuffer: 8 * 1024 * 1024 });
    const worker = await readFile(join(out, "service-worker.js"), "utf8");
    expect(worker).not.toContain("__PUBLIC_ASSET_PATHS__");
    expect(worker).not.toContain("__PUBLIC_CACHE_VERSION__");
    expect(worker).toContain('"/manifest.webmanifest"');
    expect(worker).toContain('"/phone-icons/icon-192.png"');
    expect(worker).toMatch(/\/assets\/[^" ]+\.js/);
    expect(worker).toMatch(/\/assets\/[^" ]+\.woff2/);
    expect(worker).toContain("agent-harness-public-");
    expect(await readFile(join(out, "manifest.webmanifest"), "utf8")).toContain('"start_url": "/"');
  } finally { await removeTree(out); }
}, 120_000);
