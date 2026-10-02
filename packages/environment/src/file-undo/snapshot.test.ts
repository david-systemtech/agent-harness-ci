import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { readFileState } from "./snapshot.js";

// Exercise the Windows boundary: open has no O_NOFOLLOW flag, so identity
// must be checked before reading the opened file's bytes.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const constants = { ...actual.constants };
  Reflect.deleteProperty(constants, "O_NOFOLLOW");
  return { ...actual, constants };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const { tempDir } = useCleanups();

describe("readFileState without O_NOFOLLOW", () => {
  it("keeps a regular file's bytes and mode when its identity matches", async () => {
    const path = join(tempDir(), "a.txt");
    writeFileSync(path, "original\n", { mode: 0o640 });

    expect(await readFileState(path)).toEqual({ kind: "kept", bytes: Buffer.from("original\n"), mode: 0o640 });
  });

  it("refuses a symlink already present at lstat", async () => {
    const root = tempDir();
    const other = join(root, "other.txt");
    const path = join(root, "a.txt");
    writeFileSync(other, "link target\n");
    symlinkSync(other, path);

    expect(await readFileState(path)).toEqual({ kind: "unrestorable", reason: "unknown" });
  });

  it.each(["dev", "ino"] as const)("refuses an opened file whose %s differs from lstat", async (field) => {
    const path = join(tempDir(), "a.txt");
    writeFileSync(path, "original\n");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(lstat).mockImplementationOnce(async () => {
      const info = await actual.lstat(path);
      info[field] += 1;
      return info;
    });

    expect(await readFileState(path)).toEqual({ kind: "unrestorable", reason: "unknown" });
  });

  it("refuses a file swapped for a symlink between lstat and open", async () => {
    const root = tempDir();
    const path = join(root, "a.txt");
    const other = join(root, "other.txt");
    writeFileSync(path, "original\n");
    writeFileSync(other, "link target\n");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(lstat).mockImplementationOnce(async () => {
      const info = await actual.lstat(path);
      renameSync(path, join(root, "original.txt"));
      symlinkSync(other, path);
      return info;
    });

    expect(await readFileState(path)).toEqual({ kind: "unrestorable", reason: "unknown" });
  });
});
