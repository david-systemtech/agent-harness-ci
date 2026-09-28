import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { Workspace, WorkspaceRequest } from "@agent-harness/contracts";
import type { Resolution, WorkspaceResolver } from "../src/workspace/resolver.js";

/**
 * A scripted resolver behind the workspace seam (#321): each call is
 * recorded, and answered as the test says, so a suite can make a directory
 * in `prepare`, hold it there, or record a kind the environment does not
 * make yet.
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
