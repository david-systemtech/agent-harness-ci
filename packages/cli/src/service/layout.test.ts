import * as nodeFs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeTempDir, snapshot } from "../../test/service-helpers.js";
import type { DurableFs } from "../launch/durable.js";
import { isComplete, VERSION_SENTINEL, versionDirectory } from "../launch/versions.js";
import { placeVersion } from "./layout.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

it("copies a Windows version with one flush for its last-written sentinel, regardless of its file count", () => {
  for (const count of [4, 1000]) {
    const dir = makeTempDir();
    cleanups.push(dir.remove);
    const root = join(dir.path, "bundle");
    const dataDir = join(dir.path, "data");
    nodeFs.mkdirSync(join(root, "payload"), { recursive: true });
    for (let index = 0; index < count; index++) nodeFs.writeFileSync(join(root, "payload", `${index}.txt`), "payload");
    // A bundled sentinel must not complete the copy before staging finishes.
    nodeFs.writeFileSync(join(root, VERSION_SENTINEL), "bundled");
    const opened = new Map<number, string>();
    const flushed: string[] = [];
    const fs: DurableFs = {
      ...nodeFs,
      openSync: (path, flags, mode) => {
        const fd = nodeFs.openSync(path, flags, mode);
        opened.set(fd, path);
        return fd;
      },
      fsyncSync: (fd) => {
        const path = opened.get(fd)!;
        expect(isComplete(dataDir, "0.5.0")).toBe(false);
        expect(nodeFs.readFileSync(join(versionDirectory(dataDir, "0.5.0"), "payload", `${count - 1}.txt`), "utf8")).toBe("payload");
        flushed.push(path);
        nodeFs.fsyncSync(fd);
      },
    };
    const placed = placeVersion(dataDir, { root, version: "0.5.0" }, fs, "win32");
    expect(flushed).toEqual([expect.stringMatching(/\.complete\..+\.tmp$/)]);
    expect(isComplete(dataDir, "0.5.0")).toBe(true);
    expect(snapshot(versionDirectory(dataDir, "0.5.0"))).toEqual({ ...snapshot(root), [VERSION_SENTINEL]: "" });
    placed.undo();
    expect(isComplete(dataDir, "0.5.0")).toBe(false);
  }
});

it("leaves no complete Windows version when flushing its sentinel fails, preserving the source for retry", () => {
  const dir = makeTempDir();
  cleanups.push(dir.remove);
  const root = join(dir.path, "bundle");
  const dataDir = join(dir.path, "data");
  nodeFs.mkdirSync(root);
  nodeFs.writeFileSync(join(root, "payload"), "payload");
  const fs: DurableFs = {
    ...nodeFs,
    fsyncSync: () => {
      throw new Error("flush failed");
    },
  };
  expect(() => placeVersion(dataDir, { root, version: "0.5.0" }, fs, "win32")).toThrow("flush failed");
  expect(nodeFs.existsSync(versionDirectory(dataDir, "0.5.0"))).toBe(false);
  expect(nodeFs.readFileSync(join(root, "payload"), "utf8")).toBe("payload");
});
