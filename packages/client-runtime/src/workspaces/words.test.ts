import type { SessionSummary, Workspace, WorkspaceRequest } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { SessionRow } from "../projections/session-list.js";
import { baseName, heldWords, presetBranch, problemLine, repositoryWords, requestLabel, resolverRefusal, workspaceLabel, workspaceName, type RefusalPlace } from "./words.js";

/**
 * The workspace picker's words, as both renderers say them
 * (workspace-picker spec, "Renderers"; docs/specs/gui.md, "A new session";
 * #843): a workspace and a request as a chip says them, the preset branch,
 * a repository identity, a directory's problem and the resolver's worktree
 * and branch reasons, a branch's holder named by its title from the list.
 */

const SESSION = "0199aa00-1111-4000-8000-000000000001";
const HOLDER = "0199bb00-2222-4000-8000-000000000002";

const row = (environmentId: string, id: string, title: string, workspace: Workspace): SessionRow => ({
  environmentId,
  summary: { id, title, workspace } as SessionSummary,
  groupName: null,
  pending: false,
  awaitingReceipt: false,
});

const PLACE: RefusalPlace = {
  where: "desk",
  environmentId: "env-1",
  rows: [
    row("env-1", HOLDER, "Fix the login", { kind: "worktree", path: "/data/worktrees/w1", repository: "/home/david/harness", branch: "fix/login" }),
    row("env-2", SESSION, "Elsewhere", { kind: "scratch", path: "/data/scratch/s1" }),
  ],
};

describe("a workspace's name", () => {
  it("is a path's last part, as either operating system writes it, and the path itself when it has none", () => {
    expect(baseName("/home/david/harness")).toBe("harness");
    expect(baseName("/home/david/harness/")).toBe("harness");
    expect(baseName("C:\\Users\\david\\harness")).toBe("harness");
    expect(baseName("/")).toBe("/");
  });

  it("names a recorded workspace by its kind, its directory, and a worktree's repository and branch", () => {
    expect(workspaceLabel({ kind: "directory", path: "/home/david/harness" })).toBe("directory harness");
    expect(workspaceLabel({ kind: "worktree", path: "/data/worktrees/w1", repository: "/home/david/harness", branch: "fix/login" })).toBe("worktree harness on fix/login");
    expect(workspaceLabel({ kind: "scratch", path: "/data/scratch/s1" })).toBe("scratch");
  });

  it("names a recorded workspace by name alone: scratch as scratch, never its folder, and a worktree by its repository", () => {
    expect(workspaceName({ kind: "scratch", path: "/data/scratch/ed7df0d1-d3f8-4864-b8f4-58b1ca593b10" })).toBe("scratch");
    expect(workspaceName({ kind: "directory", path: "/home/david/harness" })).toBe("harness");
    expect(workspaceName({ kind: "worktree", path: "/data/worktrees/w1", repository: "/home/david/harness", branch: "fix/login" })).toBe("harness");
    expect(workspaceName({ kind: "directory", path: "/" })).toBe("/");
    expect(workspaceName({ kind: "directory", path: "C:\\" })).toBe("C:");
  });

  it("gives a new worktree's branch the preset name from the session's id when it is not named one", () => {
    expect(presetBranch(SESSION)).toBe("agent-harness/0199aa00");
  });

  it("says a repository identity without its scheme", () => {
    expect(repositoryWords("https://git.example.com/david/harness")).toBe("git.example.com/david/harness");
  });
});

describe("a workspace request as a chip says it", () => {
  it.each<[WorkspaceRequest, string]>([
    [{ kind: "directory", path: "~/code/harness" }, "directory harness"],
    [{ kind: "scratch" }, "scratch"],
    [{ kind: "worktree", repository: "/home/david/harness", branch: "main" }, "worktree harness on main"],
    [{ kind: "worktree", repository: "/home/david/harness", newBranch: { name: "try/it" } }, "worktree harness on try/it"],
    [{ kind: "worktree", repository: "/home/david/harness", newBranch: {} }, "worktree harness on agent-harness/0199aa00"],
    [{ kind: "session", sessionId: HOLDER.toUpperCase() }, "worktree harness on fix/login"],
    [{ kind: "session", sessionId: SESSION }, "another session's"],
  ])("%j", (request, label) => {
    expect(requestLabel(request, SESSION, PLACE)).toBe(label);
  });
});

describe("a directory's problem", () => {
  it.each([
    ["does_not_exist", "/srv/gone does not exist on desk."],
    ["not_a_directory", "/srv/gone is not a directory on desk."],
    ["not_readable", "desk cannot list or enter /srv/gone."],
    ["reserved", "/srv/gone is inside desk's data directory."],
  ] as const)("%s", (problem, line) => {
    expect(problemLine(problem, "/srv/gone", "desk")).toBe(line);
  });
});

describe("a branch's holder", () => {
  it("is the worktree, and the session the harness made it for by its title when the list has it, else by its id's first eight characters", () => {
    expect(heldWords("/data/worktrees/w1", null, PLACE)).toBe("checked out in /data/worktrees/w1");
    expect(heldWords("/data/worktrees/w1", undefined, PLACE)).toBe("checked out in /data/worktrees/w1");
    expect(heldWords("/data/worktrees/w1", HOLDER.toUpperCase(), PLACE)).toBe("checked out in /data/worktrees/w1 by “Fix the login”");
    expect(heldWords("/data/worktrees/w9", SESSION, PLACE)).toBe("checked out in /data/worktrees/w9 by the session 0199aa00");
  });
});

describe("the resolver's refusal in one line", () => {
  const worktree: WorkspaceRequest = { kind: "worktree", repository: "/home/david/harness", newBranch: { name: "fix/login" } };

  it("says a directory's problem at the path the refusal names, else at the directory asked for", () => {
    expect(resolverRefusal({ reason: "workspace_unusable", problem: "not_readable", path: "/srv/locked" }, worktree, PLACE)).toBe("desk cannot list or enter /srv/locked.");
    expect(resolverRefusal({ reason: "workspace_unusable", problem: "does_not_exist" }, { kind: "directory", path: "~/gone" }, PLACE)).toBe("~/gone does not exist on desk.");
  });

  it.each<[Readonly<Record<string, unknown>>, string]>([
    [{ reason: "branch_checked_out", repository: "/home/david/harness", branch: "fix/login", worktree: "/data/worktrees/w1", sessionId: HOLDER }, "fix/login is checked out in /data/worktrees/w1 by “Fix the login”."],
    [{ reason: "branch_checked_out", branch: "fix/login" }, "fix/login is checked out in another worktree."],
    [{ reason: "branch_exists", repository: "/home/david/harness", branch: "fix/login" }, "/home/david/harness already has a branch fix/login: pick it from the list, or name another."],
    [{ reason: "branch_not_found", branch: "fix/login" }, "/home/david/harness has no local branch fix/login on desk."],
    [{ reason: "not_a_repository", path: "/srv/plain" }, "/srv/plain is in no git repository on desk."],
    [{ reason: "not_a_repository" }, "/home/david/harness is in no git repository on desk."],
    [{ reason: "no_commits", repository: "/home/david/empty" }, "/home/david/empty has no commit for a new branch to start from."],
    [{ reason: "git_unavailable" }, "desk has no git to make a worktree with."],
  ])("%j", (data, line) => {
    expect(resolverRefusal(data, worktree, PLACE)).toBe(line);
  });

  it("leaves a refusal of another kind to the renderer", () => {
    expect(resolverRefusal({ reason: "git_failed" }, worktree, PLACE)).toBeUndefined();
    expect(resolverRefusal({}, { kind: "scratch" }, PLACE)).toBeUndefined();
  });
});
