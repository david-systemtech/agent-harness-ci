import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import type { RunContainment } from "../adapter/contract.js";

/**
 * The gate's path walk where the file system changes under it: a link seen
 * by `lstat` and gone by the time `readlink` reads it. `readlinkSync` is
 * wrapped so a test can remove the link just before the real read.
 */

const beforeReadlink = vi.hoisted(() => ({ hook: undefined as ((path: string) => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readlinkSync = ((path: Parameters<typeof fs.readlinkSync>[0], options?: unknown) => {
    beforeReadlink.hook?.(String(path));
    return fs.readlinkSync(path, options as never);
  }) as typeof fs.readlinkSync;
  return { ...fs, default: { ...fs, readlinkSync }, readlinkSync };
});

const { createToolGate, resolvePath } = await import("./gate.js");

const { onCleanup, tempDir } = useCleanups();

describe("the gate's path walk", () => {
  it("denies a write through a link removed between the look and the read, rather than throwing out of the gate", async () => {
    const workspace = realpathSync(tempDir());
    const elsewhere = realpathSync(tempDir());
    mkdirSync(join(workspace, "sub"));
    const link = join(workspace, "sub", "out");
    symlinkSync(elsewhere, link);
    beforeReadlink.hook = (path) => {
      if (path === link) unlinkSync(link);
    };
    onCleanup(() => void (beforeReadlink.hook = undefined));
    expect(resolvePath("sub/out/file.txt", workspace)).toBeNull();

    symlinkSync(elsewhere, link);
    const append = vi.fn();
    const containment: RunContainment = {
      level: "workspace",
      mechanism: "bubblewrap",
      scratchDirectory: join(workspace, ".scratch"),
      temporaryDirectory: join(workspace, ".tmp"),
      writable: [workspace],
      network: true,
    };
    const gate = createToolGate({ log: { append }, liveRunOf: () => undefined })({ runId: "run-1", sessionId: "session-1", workspace, containment });
    const ruling = await gate.check({ toolCallId: "toolu_1", tool: "Write", summary: "Write sub/out/file.txt", access: { kind: "write", paths: ["sub/out/file.txt"] } });
    expect(ruling).toMatchObject({ decision: "deny", message: expect.stringContaining("sub/out/file.txt") as unknown as string });
    expect(append).toHaveBeenCalledTimes(1);
  });
});
