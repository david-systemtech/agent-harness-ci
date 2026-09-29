/**
 * Fixtures for browsing and inspecting an environment's directories (#331):
 * a valid and an invalid instance of every schema of theirs the export
 * writes, and params and results for `workspaces.browse` and
 * `workspaces.inspect`. `fixtures.ts` folds them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const commit = "0123456789abcdef0123456789abcdef01234567";
const at = "2026-09-29T01:02:03.000Z";

const head = { commit, committedAt: at };
const heldBranch = { name: "agent-harness/7c9e6679", ...head, worktree: "/data/worktrees/app-0123456789ab/agent-harness-7c9e6679", sessionId };
const freeBranch = { name: "main", ...head, worktree: null, sessionId: null };
const repository = {
  root: "/work/app",
  mainCheckout: "/work/app",
  bare: false,
  repositoryIdentity: "https://git.systemtech.dev/david/app",
  branch: "main",
  head,
  originHead: "origin/main",
  branches: [freeBranch, heldBranch],
  branchesTruncated: false,
};
const bare = { ...repository, root: "/srv/app.git", mainCheckout: "/srv/app.git", bare: true, repositoryIdentity: null, originHead: null, branches: [] };
const unborn = { ...repository, branch: "main", head: null, branches: [], branchesTruncated: false };
const inspection = { path: "/work/app/src", problem: null, repository };

export const workspaceSchemaFixtures: Record<string, Fixtures> = {
  "workspaces/browsed-directory.json": {
    valid: [
      { name: "app", repository: true },
      { name: ".config", repository: false },
    ],
    invalid: [{ name: "", repository: false }, { name: "app" }, { name: "app", repository: "yes" }],
  },
  "workspaces/inspected-commit.json": {
    valid: [head, { commit: "a".repeat(64), committedAt: at }],
    invalid: [{ commit }, { commit: "HEAD", committedAt: at }, { commit, committedAt: "yesterday" }],
  },
  "workspaces/inspected-branch.json": {
    valid: [freeBranch, heldBranch, { ...heldBranch, sessionId: null }],
    invalid: [
      { ...freeBranch, name: "" },
      { ...freeBranch, worktree: "worktrees/main" },
      { ...heldBranch, sessionId: "s-1" },
      { name: "main", ...head },
    ],
  },
  "workspaces/inspected-repository.json": {
    valid: [repository, bare, unborn, { ...repository, branch: null, branchesTruncated: true }],
    invalid: [
      { ...repository, root: "app" },
      { ...repository, bare: undefined },
      { ...repository, branch: "" },
      { ...repository, branches: [{ name: "main" }] },
      { ...repository, originHead: undefined },
    ],
  },
  "workspaces/workspace-inspection.json": {
    valid: [inspection, { path: "/tmp/notes", problem: null, repository: null }, { path: "/nowhere", problem: "does_not_exist", repository: null }],
    invalid: [{ ...inspection, path: "~/app" }, { ...inspection, problem: "missing" }, { path: "/work/app", problem: null }],
  },
};

export const workspaceMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "workspaces.browse": {
    params: {
      valid: [{}, { path: "/work" }, { path: "~", hidden: true }, { path: "~/code", hidden: false }],
      invalid: [{ path: "work" }, { path: "" }, { hidden: "yes" }],
    },
    result: {
      valid: [
        { path: "/work", parent: "/", directories: [{ name: "app", repository: true }], truncated: false },
        { path: "/", parent: null, directories: [], truncated: true },
      ],
      invalid: [
        { path: "/work", parent: "/", directories: [] },
        { path: "work", parent: null, directories: [], truncated: false },
        { path: "/work", parent: "/", directories: [{ name: "" }], truncated: false },
      ],
    },
  },
  "workspaces.inspect": {
    params: { valid: [{ path: "/work/app" }, { path: "~/app" }], invalid: [{}, { path: "app" }, { path: "" }] },
    result: workspaceSchemaFixtures["workspaces/workspace-inspection.json"] as Fixtures,
  },
};
