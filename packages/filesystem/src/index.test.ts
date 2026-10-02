import { spawnSync } from "node:child_process";
import { chownSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { removeTree, removeTreeSync } from "./index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tempDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "agent-harness-tree-"));
  roots.push(root);
  return root;
};

// Root ignores mode bits, so only an ordinary user can verify this removal.
it.skipIf(process.getuid?.() === 0).each([{ name: "async", remove: removeTree }, { name: "sync", remove: removeTreeSync }])("$name removal clears an unreadable owned tree and leaves linked files and their permissions alone", async ({ remove }) => {
  const root = tempDir();
  const tree = join(root, "tree");
  const nested = join(tree, "nested");
  const outside = join(root, "outside");
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(nested, "skill.md"), "snapshot");
  writeFileSync(join(outside, "keep.md"), "keep");
  symlinkSync(outside, join(tree, "link"), process.platform === "win32" ? "junction" : "dir");
  chmodSync(join(outside, "keep.md"), 0o400);
  const outsideMode = statSync(join(outside, "keep.md")).mode;
  chmodSync(join(nested, "skill.md"), 0o400);
  chmodSync(nested, 0o500);
  chmodSync(tree, 0);

  try {
    await remove(tree);
  } finally {
    if (existsSync(tree)) chmodSync(tree, 0o700);
    if (existsSync(nested)) chmodSync(nested, 0o700);
  }
  expect(existsSync(tree)).toBe(false);
  expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("keep");
  expect(statSync(join(outside, "keep.md")).mode).toBe(outsideMode);
  await remove(tree);
});

// A root shard drops uid for the operation, so root cannot mask permission failures.
it.skipIf(process.getuid?.() !== 0 || process.platform !== "linux").each(["removeTree", "removeTreeSync"] as const)("%s removes another uid's read-only files from an owned tree", (method) => {
  const tree = tempDir();
  const shared = join(tree, "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  writeFileSync(join(shared, "readonly.txt"), "fixture");
  chmodSync(join(shared, "readonly.txt"), 0o444);
  chownSync(tree, 65534, 65534);
  chmodSync(tree, 0);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { ${method} } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    await ${method}(${JSON.stringify(tree)});
    console.log(process.getuid());
  `], { uid: 65534, gid: 65534, encoding: "utf8" });

  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(child.stdout.trim()).toBe("65534");
  expect(existsSync(tree)).toBe(false);
});
