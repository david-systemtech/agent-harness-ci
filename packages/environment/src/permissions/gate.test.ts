import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import type { RunContainment } from "../adapter/contract.js";
import type { ToolGateOptions } from "./gate.js";

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

/** The gate handed a run at `workspace` in `workspace`, its denials appended to `append`. */
const gateAt = (workspace: string, append: ToolGateOptions["log"]["append"]) => {
  const containment: RunContainment = {
    level: "workspace",
    mechanism: "bubblewrap",
    scratchDirectory: join(workspace, ".scratch"),
    temporaryDirectory: join(workspace, ".tmp"),
    writable: [workspace],
    network: true,
  };
  // A log that holds nothing: every call is undecided, and the gate's append is the one it makes.
  const log: ToolGateOptions["log"] = { append, read: () => [], atomically: (work) => work({ afterCommit: () => undefined }) };
  return createToolGate({ log, liveRunOf: () => undefined })({ runId: "run-1", sessionId: "session-1", workspace, containment });
};

const writing = (path: string) => ({ toolCallId: "toolu_1", tool: "Write", summary: `Write ${path}`, access: { kind: "write", paths: [path] } }) as const;

describe("the gate's path walk", () => {
  it("follows a link where it stands before a later .. is applied: <workspace>/link/../f is beside the link's target, outside the workspace, and denied", async () => {
    const workspace = realpathSync(tempDir());
    const elsewhere = realpathSync(tempDir());
    mkdirSync(join(elsewhere, "deep"));
    symlinkSync(join(elsewhere, "deep"), join(workspace, "link"));
    const path = `${workspace}/link/../f.txt`;
    // Read as text, the path is inside the workspace; the kernel reads it beside the link's target.
    expect(join(path)).toBe(join(workspace, "f.txt"));
    expect(resolvePath(path, workspace)).toBe(join(elsewhere, "f.txt"));
    const append = vi.fn();
    expect(await gateAt(workspace, append).check(writing(path))).toMatchObject({ decision: "deny" });
    expect(append).toHaveBeenCalledTimes(1);
    expect(await gateAt(workspace, append).check(writing(`${workspace}/f.txt`))).toEqual({ decision: "allow" });
  });

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
    const ruling = await gateAt(workspace, append).check(writing("sub/out/file.txt"));
    expect(ruling).toMatchObject({ decision: "deny", message: expect.stringContaining("sub/out/file.txt") as unknown as string });
    expect(append).toHaveBeenCalledTimes(1);
  });
});
