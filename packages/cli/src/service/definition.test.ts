import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDefinition } from "./definition.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-definition-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe("writeDefinition", () => {
  it("writes the file, reports the folders it created, and restores the previous content", () => {
    const dir = tempDir();
    const path = join(dir, "a", "b", "unit.service");
    const first = writeDefinition(path, "first\n");
    expect(readFileSync(path, "utf8")).toBe("first\n");
    expect(first.createdDirectories).toEqual([join(dir, "a"), join(dir, "a", "b")]);
    const second = writeDefinition(path, "second\n");
    expect(second.previous).toBe("first\n");
    second.restore();
    expect(readFileSync(path, "utf8")).toBe("first\n");
    first.restore();
    expect(existsSync(join(dir, "a"))).toBe(false);
  });

  it("leaves the previous definition whole, and no temporary file, when the write itself fails", () => {
    const dir = tempDir();
    const path = join(dir, "unit.service");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "previous\n");
    const failing = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    expect(() => writeDefinition(path, "new\n", failing)).toThrow(/ENOSPC/);
    expect(readFileSync(path, "utf8")).toBe("previous\n");
    expect(readdirSync(dir)).toEqual(["unit.service"]);
  });

  it("removes the folders it created when the first write fails", () => {
    const dir = tempDir();
    const path = join(dir, "a", "unit.service");
    const failing = () => {
      throw new Error("EIO");
    };
    expect(() => writeDefinition(path, "new\n", failing)).toThrow(/EIO/);
    expect(existsSync(join(dir, "a"))).toBe(false);
  });
});
