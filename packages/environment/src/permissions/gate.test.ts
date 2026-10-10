import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { denylistPresets } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import type { RunContainment, ToolAccess } from "../adapter/contract.js";
import type { ToolGateRule } from "../adapter/seams.js";
import type { ToolGateOptions } from "./gate.js";

/**
 * The gate on its own, without a host: its path walk where the file system
 * changes under it (a link seen by `lstat` and gone by the time `readlink`
 * reads it; `readlinkSync` is wrapped so a test can remove the link just
 * before the real read), and a rule that asks when no ask is wired, the
 * ask fails, or the broker denies it before any prompt opens.
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

const { GATE_FAILED_MESSAGE, containmentDenial, createToolGate, resolvePath } = await import("./gate.js");
const { denylistRule } = await import("./denylist-gate.js");

const { onCleanup, tempDir } = useCleanups();

/** The gate handed a run at `workspace` in `workspace`, its denials appended to `append`, with `rules` after containment's and `ask` wired, if given. */
const gateAt = (workspace: string, append: ToolGateOptions["log"]["append"], rules: readonly ToolGateRule[] = [], ask?: ToolGateOptions["ask"]) => {
  const containment: RunContainment = {
    level: "workspace",
    mechanism: "bubblewrap",
    scratchDirectory: join(workspace, ".scratch"),
    temporaryDirectory: join(workspace, ".tmp"),
    writable: [workspace],
    readOnly: [],
    network: true,
  };
  // A log that holds nothing: every call is undecided, and the gate's append is the one it makes.
  const log: ToolGateOptions["log"] = { append, read: () => [], atomically: (work) => work({ afterCommit: () => undefined }) };
  return createToolGate({ log, liveRunOf: () => undefined, rules, ...(ask !== undefined && { ask }) })({ runId: "run-1", sessionId: "session-1", workspace, containment });
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

const readKey = { toolCallId: "toolu_1", tool: "Read", summary: "Read ~/.ssh/id_rsa", access: { kind: "read", paths: ["~/.ssh/id_rsa"] } } as const;
const keyRule = () => denylistRule({ denylist: () => denylistPresets("/srv/agent-harness"), home: "/home/david", exempt: [], resolve: (path) => path });

describe("a rule that asks, on a gate with no ask wired", () => {
  it("is denied, nobody being there to ask, and the gate records the denial by the rule's decider, since no prompt's answer will", async () => {
    const workspace = realpathSync(tempDir());
    const append = vi.fn();
    const ruling = await gateAt(workspace, append, [keyRule()]).check(readKey);
    if (ruling.decision !== "deny") throw new Error(`The call was let through: ${JSON.stringify(ruling)}`);
    expect(ruling.message).toMatch(/^Denied: nobody could be asked/);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[1]).toEqual([
      { type: "tool.decision", payload: expect.objectContaining({ toolCallId: "toolu_1", tool: "Read", decision: "denied", decidedBy: "denylist", promptId: null, reason: ruling.message }) },
    ]);
  });
});

describe("an allowed denylist prompt's Note", () => {
  it("hands the person's Note to the adapter without recording another decision", async () => {
    const workspace = realpathSync(tempDir());
    const append = vi.fn();
    const ask: ToolGateOptions["ask"] = async () => ({ decision: { decision: "allow", message: "DENYLIST_NOTE_2091: read only this file." }, unopened: null });
    expect(await gateAt(workspace, append, [keyRule()], ask).check(readKey)).toEqual({ decision: "allow", message: "DENYLIST_NOTE_2091: read only this file." });
    expect(append).not.toHaveBeenCalled();
  });
});

describe("a rule whose ask fails", () => {
  it("denies the call as a rule that could not rule, recorded by the rule's decider, since no prompt was opened to answer", async () => {
    const workspace = realpathSync(tempDir());
    const append = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => error.mockRestore());
    const failing: ToolGateOptions["ask"] = () => Promise.reject(new Error("The prompt could not be opened."));
    expect(await gateAt(workspace, append, [keyRule()], failing).check(readKey)).toEqual({ decision: "deny", message: GATE_FAILED_MESSAGE });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[1]).toEqual([
      { type: "tool.decision", payload: expect.objectContaining({ toolCallId: "toolu_1", decision: "denied", decidedBy: "denylist", promptId: null, reason: GATE_FAILED_MESSAGE }) },
    ]);
  });

  it("leaves an ask that was answered to its prompt: the gate records nothing", async () => {
    const workspace = realpathSync(tempDir());
    const append = vi.fn();
    const answered: ToolGateOptions["ask"] = () => Promise.resolve({ decision: { decision: "deny", message: "A person denied it." }, unopened: null });
    expect(await gateAt(workspace, append, [keyRule()], answered).check(readKey)).toEqual({ decision: "deny", message: "A person denied it." });
    expect(append).not.toHaveBeenCalled();
  });
});

describe("a rule whose ask the broker denied before any prompt opened", () => {
  it.each([
    ["the run had ended", "run_ended", "provider"],
    ["the provider had given up on the call", "cancelled", "provider"],
    ["the log refused the prompt", "unrecorded", "denylist"],
  ] as const)("is recorded by the gate when %s (%s), since no answer will: by %s", async (_why, unopened, decidedBy) => {
    const workspace = realpathSync(tempDir());
    const append = vi.fn();
    const denied: ToolGateOptions["ask"] = () => Promise.resolve({ decision: { decision: "deny", message: `Denied: ${unopened}.` }, unopened });
    expect(await gateAt(workspace, append, [keyRule()], denied).check(readKey)).toEqual({ decision: "deny", message: `Denied: ${unopened}.` });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[1]).toEqual([
      { type: "tool.decision", payload: expect.objectContaining({ toolCallId: "toolu_1", decision: "denied", decidedBy, promptId: null, reason: `Denied: ${unopened}.` }) },
    ]);
  });
});

describe("what containment closes inside the writable set (#791)", () => {
  /** A run at `workspace` that may write all of it but `readOnly`. */
  const closing = (workspace: string, readOnly: string[]): RunContainment => ({
    level: "workspace",
    mechanism: "bubblewrap",
    scratchDirectory: join(workspace, ".scratch"),
    temporaryDirectory: join(workspace, ".tmp"),
    writable: [workspace],
    readOnly,
    network: true,
  });
  const writeTo = (...paths: string[]): ToolAccess => ({ kind: "write", paths });

  it("folds case where the file system does, so .git/HOOKS is .git/hooks on macOS and Windows but not on Linux", () => {
    const workspace = realpathSync(tempDir());
    const containment = closing(workspace, [join(workspace, ".git", "hooks"), join(workspace, ".git", "config")]);
    const shouted = join(workspace, ".git", "HOOKS", "pre-commit");
    expect(containmentDenial(containment, workspace, writeTo(shouted), true)).toContain(`${shouted} is in a read-only directory`);
    expect(containmentDenial(containment, workspace, writeTo(join(workspace, ".GIT", "Config")), true)).not.toBeNull();
    expect(containmentDenial(containment, workspace, writeTo(shouted), false)).toBeNull();
  });

  it("follows links on both sides: a write through a link to the git directory, and one where a hooks link leads, are denied; a neighbour is not", () => {
    const workspace = realpathSync(tempDir());
    mkdirSync(join(workspace, ".git"));
    mkdirSync(join(workspace, ".githooks"));
    symlinkSync(join(workspace, ".githooks"), join(workspace, ".git", "hooks"));
    symlinkSync(join(workspace, ".git"), join(workspace, "git-link"));
    const containment = closing(workspace, [join(workspace, ".git", "hooks")]);
    expect(containmentDenial(containment, workspace, writeTo(join(workspace, ".githooks", "pre-commit")), false)).not.toBeNull();
    expect(containmentDenial(containment, workspace, writeTo(join(workspace, "README.md"), "git-link/hooks/pre-push"), false)).toContain(
      "git-link/hooks/pre-push is in a read-only directory",
    );
    expect(containmentDenial(containment, workspace, writeTo(join(workspace, ".git", "hooks.old", "pre-commit"), join(workspace, ".git", "HEAD")), false)).toBeNull();
  });

  it("denies a .git indirection and its programs even when .git links to a directory with another name (#1094)", () => {
    const workspace = realpathSync(tempDir());
    const metadata = join(workspace, "metadata");
    mkdirSync(metadata);
    symlinkSync(metadata, join(workspace, ".git"));
    const containment = closing(workspace, []);
    for (const path of [".git", ".git/", ".git/config", ".git/hooks/pre-commit", ".git/commondir"]) {
      expect(containmentDenial(containment, workspace, writeTo(path), false), path).not.toBeNull();
    }
    expect(containmentDenial(containment, workspace, writeTo("metadata/ordinary-file", ".githooks/pre-commit", ".git/config.lock", ".git/HEAD"), false)).toBeNull();
  });

  it("closes new git programs case-blind where needed, without closing refs named config or hooks (#1094)", () => {
    const workspace = realpathSync(tempDir());
    const containment = closing(workspace, []);
    for (const path of ["nested/.GIT", "nested/.GIT/Config", "nested/.GIT/HOOKS/pre-commit", "nested/.GIT/modules/new/Config.Worktree"]) {
      expect(containmentDenial(containment, workspace, writeTo(path), true), path).not.toBeNull();
      expect(containmentDenial(containment, workspace, writeTo(path), false), path).toBeNull();
    }
    mkdirSync(join(workspace, "nested", ".git"), { recursive: true });
    symlinkSync(join(workspace, "nested", ".git"), join(workspace, "alias"));
    expect(containmentDenial(containment, workspace, writeTo("alias/config"), false)).not.toBeNull();
    expect(containmentDenial(containment, workspace, writeTo("nested/.git/refs/heads/config", "nested/.git/refs/heads/hooks", "nested/.git/objects/pack/new.pack", "nested/.git/info/exclude"), false)).toBeNull();
  });

  it("closes a repository nested anywhere beneath another repository's metadata (#1094)", () => {
    const workspace = realpathSync(tempDir());
    const containment = closing(workspace, []);
    for (const path of [".git/other/.git", ".git/other/.git/config", ".git/other/.git/hooks/pre-commit"]) {
      expect(containmentDenial(containment, workspace, writeTo(path), false), path).not.toBeNull();
    }
  });
});
