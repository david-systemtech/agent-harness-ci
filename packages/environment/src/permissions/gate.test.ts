import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { denylistPresets } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import type { RunContainment } from "../adapter/contract.js";
import type { ToolGateRule } from "../adapter/seams.js";
import type { ToolGateOptions } from "./gate.js";

/**
 * The gate on its own, without a host: its path walk where the file system
 * changes under it (a link seen by `lstat` and gone by the time `readlink`
 * reads it; `readlinkSync` is wrapped so a test can remove the link just
 * before the real read), and a rule that asks when no ask is wired.
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
const { denylistRule } = await import("./denylist-gate.js");

const { onCleanup, tempDir } = useCleanups();

/** The gate handed a run at `workspace` in `workspace`, its denials appended to `append`, with `rules` after containment's and no ask wired. */
const gateAt = (workspace: string, append: ToolGateOptions["log"]["append"], rules: readonly ToolGateRule[] = []) => {
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
  return createToolGate({ log, liveRunOf: () => undefined, rules })({ runId: "run-1", sessionId: "session-1", workspace, containment });
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

describe("a rule that asks, on a gate with no ask wired", () => {
  it("is denied, nobody being there to ask, and the gate records the denial by the rule's decider, since no prompt's answer will", async () => {
    const workspace = realpathSync(tempDir());
    const append = vi.fn();
    const rule = denylistRule({ denylist: () => denylistPresets("/srv/agent-harness"), home: "/home/david", exempt: [], resolve: (path) => path });
    const ruling = await gateAt(workspace, append, [rule]).check({ toolCallId: "toolu_1", tool: "Read", summary: "Read ~/.ssh/id_rsa", access: { kind: "read", paths: ["~/.ssh/id_rsa"] } });
    if (ruling.decision !== "deny") throw new Error(`The call was let through: ${JSON.stringify(ruling)}`);
    expect(ruling.message).toMatch(/^Denied: nobody could be asked/);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[1]).toEqual([
      { type: "tool.decision", payload: expect.objectContaining({ toolCallId: "toolu_1", tool: "Read", decision: "denied", decidedBy: "denylist", promptId: null, reason: ruling.message }) },
    ]);
  });
});
