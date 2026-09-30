import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { Workspace, WorkspaceRequest } from "@agent-harness/contracts";
import type { Resolution, WorkspaceResolver } from "../src/workspace/resolver.js";

/**
 * A scripted resolver behind the workspace seam (#321): each call is
 * recorded, and answered as the test says, so a suite can make a directory
 * in `prepare`, hold it there, or record any kind of workspace without
 * making it.
 */

/** One call the resolver took: the request and the session it is for. */
export interface ResolverCall {
  readonly request: WorkspaceRequest;
  readonly sessionId: string;
}

export interface ScriptedResolver extends WorkspaceResolver {
  /** Every call, in order. */
  readonly calls: ResolverCall[];
}

/** A resolver answering every call with `answer`, recording each. */
export const scriptedResolver = (answer: (call: ResolverCall) => Resolution | Promise<Resolution>): ScriptedResolver => {
  const calls: ResolverCall[] = [];
  return {
    calls,
    resolve: async (request, sessionId) => {
      const call = { request, sessionId };
      calls.push(call);
      return answer(call);
    },
  };
};

/**
 * Makes the directory `path` when it is not there, as a resolver making a
 * scratch directory or a worktree would, and answers `workspace` with an
 * undo that removes it; a directory already there was not made here, so its
 * answer has no undo.
 */
export const makeDirectory = (path: string, workspace: Workspace): Resolution => {
  if (existsSync(path)) return { workspace, repositoryIdentity: null };
  mkdirSync(path, { recursive: true });
  return { workspace, repositoryIdentity: null, undo: () => rmSync(path, { recursive: true, force: true }) };
};

/** What `gitWith` gives git beyond `git`'s: variables over its environment (a commit's `GIT_COMMITTER_DATE`), and its standard input. */
export interface GitWith {
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

/** Runs git in `cwd` as `git` does, with `env` and `input` as given; answers what it printed. */
export const gitWith = ({ env = {}, input }: GitWith, cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
    ...(input !== undefined && { input }),
  });

/** Runs git in `cwd` as a test user, with no global or system configuration; answers what it printed. */
export const git = (cwd: string, ...args: string[]): string => gitWith({}, cwd, ...args);

/** A worktree as git lists it: where, its branch as a full ref (null when detached), and its lock's reason (empty for none given; null unlocked). */
export interface ListedWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly locked: string | null;
}

/** The worktrees git lists for the repository at `checkout`: the main checkout first. */
export const worktreesOf = (checkout: string): ListedWorktree[] =>
  git(checkout, "worktree", "list", "--porcelain", "-z")
    .split("\0\0")
    .filter((record) => record !== "")
    .map((record) => {
      const fields = record.split("\0");
      const value = (key: string) => {
        const field = fields.find((each) => each === key || each.startsWith(`${key} `));
        return field === undefined ? null : field.slice(key.length + 1);
      };
      return { path: value("worktree") as string, branch: value("branch"), locked: value("locked") };
    });

/** The repository's local branches, by name. */
export const branchesOf = (checkout: string): string[] => git(checkout, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
