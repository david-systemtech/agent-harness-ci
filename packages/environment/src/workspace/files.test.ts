import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { listFiles } from "./files.js";

/** The walk's bounds, below the wire: by files and by directories entered. */

const { tempDir } = useCleanups();

describe("the bounded walk", () => {
  it("stops entering directories past its bound, and says the listing is truncated", async () => {
    const root = tempDir("agent-harness-walk-");
    for (const dir of ["a", "b", "c", "d"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "f.txt"), "");
    }
    writeFileSync(join(root, "top.txt"), "");
    expect(await listFiles(root, { maxDirectories: 3 })).toEqual({ files: ["a/f.txt", "b/f.txt", "top.txt"], truncated: true, source: "walk" });
    expect(await listFiles(root, { maxDirectories: 10 })).toEqual({
      files: ["a/f.txt", "b/f.txt", "c/f.txt", "d/f.txt", "top.txt"],
      truncated: false,
      source: "walk",
    });
  });
});
