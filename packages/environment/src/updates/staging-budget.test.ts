import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_FILE } from "@agent-harness/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { unpackedServerArtefact } from "../../test/artefacts.js";
import { stageArtefact } from "./staging.js";

const disk = vi.hoisted(() => ({ free: 0 }));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  statfsSync: () => ({ bavail: disk.free, bsize: 1 }),
}));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });

it("refuses a bundled copy before it consumes the snapshot reserve, preserving existing staging and user data", async () => {
  const root = mkdtempSync(join(tmpdir(), "bundled-budget-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "staging", "0.6.0"), { recursive: true });
  writeFileSync(join(dataDir, "staging", "0.6.0", "waiting"), "deliberately waiting");
  writeFileSync(join(dataDir, DATABASE_FILE), "user data");
  const artefact = unpackedServerArtefact(join(root, "bundle"), "0.6.0");
  disk.free = 256 * 1024 * 1024 + 10;
  await expect(stageArtefact({ dataDir, version: "0.6.0", artefact, unpack: async () => {} })).rejects.toThrow(/disk space.*staging.*snapshot/i);
  expect(readFileSync(join(dataDir, "staging", "0.6.0", "waiting"), "utf8")).toBe("deliberately waiting");
  expect(readFileSync(join(dataDir, DATABASE_FILE), "utf8")).toBe("user data");
  expect(existsSync(join(dataDir, "versions", "0.6.0"))).toBe(false);
});
