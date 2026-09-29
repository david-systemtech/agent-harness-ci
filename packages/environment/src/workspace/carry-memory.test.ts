import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { carryMemory } from "./carry-memory.js";

/**
 * ADR 0021's carry-over rule at its own seam (#329; the Carry over import's
 * memory, #580, runs the same): what the identity passes cannot show through
 * an environment, a carry cut short between its copy and its pointer line.
 */

const { tempDir } = useCleanups();

const write = (directory: string, files: Readonly<Record<string, string>>): void => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
};

describe("carryMemory", () => {
  it("gives a second source copied before, whose pointer line never landed, its line once, and never twice", async () => {
    const root = tempDir("agent-harness-carry-");
    const [source, target] = [join(root, "old-key"), join(root, "new-key")];
    write(source, { "MEMORY.md": "# Memory\n- [Build](build.md)\n", "build.md": "pnpm.\n" });
    write(target, { "MEMORY.md": "# Memory\n- [Receipts](receipts.md)\n", "receipts.md": "Thirty days.\n" });
    // The copy under carried/ made, and the process stopped before the line was appended.
    write(join(target, "carried", "old-key"), { "MEMORY.md": "# Memory\n- [Build](build.md)\n", "build.md": "pnpm.\n" });

    expect(await carryMemory({ directory: source, name: "old-key", label: "/work/old" }, target)).toEqual({ outcome: "held" });
    expect(await carryMemory({ directory: source, name: "old-key", label: "/work/old" }, target)).toEqual({ outcome: "held" });

    expect(readFileSync(join(target, "MEMORY.md"), "utf8")).toBe("# Memory\n- [Receipts](receipts.md)\n- [Memory carried from /work/old](carried/old-key/MEMORY.md)\n");
  });
});
