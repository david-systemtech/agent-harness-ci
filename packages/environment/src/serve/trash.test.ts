import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { TRASH_KEPT_MS, createTrash } from "./trash.js";

/**
 * The data directory's trash at its own seam, with the clock held: what a
 * sweep keeps and deletes is only knowable once the sweep has finished,
 * which the environment's hourly timer does not say. The environment's
 * suite drives the same trash through `skills.own.remove`.
 */

const { tempDir } = useCleanups();

/** A data directory holding one skill folder to trash. */
const withFolder = () => {
  const dataDir = tempDir();
  const folder = join(dataDir, "skills", "own", "skills", "tdd");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "---\nname: tdd\n---\n");
  return { dataDir, folder };
};

describe("the trash", () => {
  it("moves a folder into an entry of its own under the data directory, keeping its name and its files", async () => {
    const { dataDir, folder } = withFolder();
    const trash = createTrash({ dataDir, clock: manualClock() });
    const trashed = await trash.put(folder);
    expect(existsSync(folder)).toBe(false);
    expect(trashed.startsWith(join(dataDir, "trash"))).toBe(true);
    expect(readFileSync(join(trashed, "SKILL.md"), "utf8")).toBe("---\nname: tdd\n---\n");
  });

  it("keeps what it holds until thirty days after it was trashed, and a sweep then deletes it", async () => {
    const { dataDir, folder } = withFolder();
    const clock = manualClock();
    const trash = createTrash({ dataDir, clock });
    await trash.put(folder);
    clock.advance(TRASH_KEPT_MS - 1);
    await trash.sweep();
    expect(readdirSync(trash.root)).toHaveLength(1);
    clock.advance(1);
    await trash.sweep();
    expect(readdirSync(trash.root)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("deletes read-only trees when their thirty days are up", async () => {
    const { dataDir, folder } = withFolder();
    const clock = manualClock();
    const trash = createTrash({ dataDir, clock });
    chmodSync(join(folder, "SKILL.md"), 0o400);
    chmodSync(folder, 0o500);
    const trashed = await trash.put(folder);
    expect(statSync(join(trashed, "SKILL.md")).mode & 0o777).toBe(0o400);
    expect(statSync(trashed).mode & 0o777).toBe(0o500);
    clock.advance(TRASH_KEPT_MS);

    await trash.sweep();
    expect(existsSync(trashed)).toBe(false);
    expect(readdirSync(trash.root)).toEqual([]);
  });

  it("preserves read-only directory and file modes when a trashed folder is restored", async () => {
    const { dataDir, folder } = withFolder();
    const trash = createTrash({ dataDir, clock: manualClock() });
    chmodSync(join(folder, "SKILL.md"), 0o400);
    chmodSync(folder, 0o500);
    const trashed = await trash.put(folder);
    await trash.restore(trashed, folder);

    expect(statSync(folder).mode & 0o777).toBe(0o500);
    expect(statSync(join(folder, "SKILL.md")).mode & 0o777).toBe(0o400);
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe("---\nname: tdd\n---\n");
  });

  it("leaves alone what it did not put there", async () => {
    const { dataDir } = withFolder();
    const clock = manualClock();
    const trash = createTrash({ dataDir, clock });
    mkdirSync(join(trash.root, "kept-by-hand"), { recursive: true });
    clock.advance(TRASH_KEPT_MS * 2);
    await trash.sweep();
    expect(readdirSync(trash.root)).toEqual(["kept-by-hand"]);
  });

  it("moves a trashed folder back where it was, leaving no entry behind", async () => {
    const { dataDir, folder } = withFolder();
    const trash = createTrash({ dataDir, clock: manualClock() });
    const trashed = await trash.put(folder);
    await trash.restore(trashed, folder);
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe("---\nname: tdd\n---\n");
    expect(readdirSync(trash.root)).toEqual([]);
  });
});
