import { homedir } from "node:os";
import { join } from "node:path";
import type { Workspace, WorkspaceRequest } from "@agent-harness/contracts";
import type { Undo } from "../serve/methods.js";
import type { Refusal } from "../sessions/decider.js";

/**
 * The resolver (workspace-picker spec, "The resolver"; #321): the one
 * in-process seam that turns a workspace request into the workspace a
 * session records and its repository identity, or a refusal. `sessions.create`
 * asks it in its `prepare`, outside the transaction, after the decider's
 * cheap refusals; the completions surface asks it for a fresh session; the
 * Carry over import (#88), minted sessions and routines (#92) and
 * `sessions.setWorkspace` will ask it too.
 *
 * What it makes for a request (a scratch directory, a worktree and its new
 * branch) it answers with an `undo` that removes exactly that, and nothing
 * that was there before it: the caller runs it when the command is not
 * accepted. As built it serves `directory` as phase A did, any full path
 * recorded as sent (a `~` read from the environment's home, so the record
 * is absolute) with no identity, and answers every other kind as not served
 * yet; the workstream's later tickets add the checks, the kinds and the
 * identity.
 */

/** What the resolver answers: the workspace and identity to record, with how to remove what it made; or a refusal. */
export type Resolution =
  | {
      readonly workspace: Workspace;
      readonly repositoryIdentity: string | null;
      /** Removes what resolving made, when the create it was for is not accepted; absent when it made nothing. */
      readonly undo?: Undo;
      readonly refused?: undefined;
    }
  | { readonly refused: Refusal };

export interface WorkspaceResolver {
  /**
   * Resolves `request` for the session `sessionId` (in lowercase), which a
   * worktree's branch and a scratch directory are named from. An answer it
   * has at once is given at once, not as a promise, so a create that needs
   * no wait keeps its place among its socket's requests (`serve/methods.ts`).
   */
  resolve(request: WorkspaceRequest, sessionId: string): Resolution | Promise<Resolution>;
}

/** The refusal of a request of a kind this environment does not make yet: `conflict`, reason `kind_not_served`. */
const notServed = (kind: WorkspaceRequest["kind"]): Resolution => ({
  refused: {
    code: "conflict",
    message: `This environment does not give a session a ${kind} workspace yet; ask for a directory.`,
    data: { reason: "kind_not_served", kind },
  },
});

export interface WorkspaceResolverOptions {
  /** The environment's home, which a directory request's `~` stands for. Preset: the running user's. */
  readonly home?: string;
}

/** The environment's resolver. */
export const createWorkspaceResolver = (options: WorkspaceResolverOptions = {}): WorkspaceResolver => {
  const home = options.home ?? homedir();
  /**
   * A requested directory as recorded: `~`, and `~/` or `~\` with what
   * follows, read from the environment's home; anything else as sent. The
   * wire's schema refuses any other `~` form; an in-process caller's is not
   * taken for a home.
   */
  const recorded = (path: string): string => (path === "~" ? home : /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path);
  return {
    resolve: (request) => {
      // Phase A's rule: any full path, recorded as it came; whether it is there is the workspace workstream's check (#325).
      if (request.kind === "directory") return { workspace: { kind: "directory", path: recorded(request.path) }, repositoryIdentity: null };
      return notServed(request.kind);
    },
  };
};
