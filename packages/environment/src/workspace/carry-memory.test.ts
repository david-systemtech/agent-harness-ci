import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { carryMemory, createDryRun, type MemorySource } from "./carry-memory.js";

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

  it("answers a pass of dry carries into one target, handed one dry run, as the same carries then do", async () => {
    const root = tempDir("agent-harness-carry-");
    const target = join(root, "key");
    const source = (name: string, directory: string, files: Readonly<Record<string, string>>): MemorySource => {
      write(join(root, directory), files);
      return { directory: join(root, directory), name, label: `/work/${directory}` };
    };
    const first = { "MEMORY.md": "# Memory\n- [Build](build.md)\n", "build.md": "pnpm.\n" };
    const second = { "MEMORY.md": "# Memory\n- [Deploy](deploy.md)\n", "deploy.md": "Fridays.\n" };
    const pass = [
      // Into the empty target; a second source under carried/; the first's files again, once the pointer line changed the index;
      // another source of the second's name; and the second's files again under its name, held.
      source("a", "a", first),
      source("b", "b", second),
      source("c", "c", first),
      source("b", "b-other", { "MEMORY.md": "# Memory\n- [Tag](tag.md)\n", "tag.md": "From main.\n" }),
      source("b", "b-again", second),
    ];

    const dryRun = createDryRun();
    const dry = [];
    for (const each of pass) dry.push(await carryMemory(each, target, { dryRun: true, plan: dryRun }));
    expect(existsSync(target)).toBe(false);

    const real = [];
    for (const each of pass) real.push(await carryMemory(each, target));
    expect(real).toEqual([
      { outcome: "copied" },
      { outcome: "carried", under: "carried/b" },
      { outcome: "carried", under: "carried/c" },
      { outcome: "carried", under: "carried/b-2" },
      { outcome: "held" },
    ]);
    expect(dry).toEqual(real);
  });
});
