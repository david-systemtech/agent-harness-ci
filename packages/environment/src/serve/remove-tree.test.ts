import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { removeTree, removeTreeSync } from "./remove-tree.js";

const { tempDir, onCleanup } = useCleanups();

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
  // Restore access even when the removal fails, so the failing run can clean up.
  onCleanup(() => {
    if (existsSync(tree)) chmodSync(tree, 0o700);
    if (existsSync(nested)) chmodSync(nested, 0o700);
  });

  await remove(tree);
  expect(existsSync(tree)).toBe(false);
  expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("keep");
  expect(statSync(join(outside, "keep.md")).mode).toBe(outsideMode);
  await remove(tree);
});
