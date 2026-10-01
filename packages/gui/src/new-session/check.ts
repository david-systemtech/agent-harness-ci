import { presetBranch, resolverRefusal, type RefusalPlace, type Runtime } from "@agent-harness/client-runtime";
import type { WorkspaceInspection, WorkspaceRequest } from "@agent-harness/contracts";

/**
 * The new-session picker's check of a workspace request before the chip
 * takes it (workspace-picker spec, "Browsing an environment's directories";
 * #421): the session is started only at the first send, after the picker
 * has closed, so the picker asks `workspaces.inspect`, which judges a path
 * by the resolver's own rule, and says the resolver's refusal on itself,
 * staying open. Where the connection cannot inspect (no `terminal`, the
 * environment not reached) or the inspection fails, the request is taken
 * unchecked, and the create's refusal at the first send is the surface's
 * line.
 */

/** What the resolver would refuse `request` for, from the inspection of its path, as the environment's refusal data; undefined when it would take it. */
export const refusalOf = (inspection: WorkspaceInspection, request: WorkspaceRequest, sessionId: string): Readonly<Record<string, unknown>> | undefined => {
  const { path, problem, repository } = inspection;
  if (problem !== null) return { reason: "workspace_unusable", problem, path };
  if (request.kind !== "worktree") return undefined;
  if (repository === null) return { reason: "not_a_repository", path };
  const from = { repository: repository.mainCheckout };
  const named = request.branch ?? request.newBranch?.name ?? presetBranch(sessionId);
  const listed = repository.branches.find((branch) => branch.name === named);
  if (request.branch !== undefined) {
    // A branch past the ones listed may be there: only the environment can say.
    if (listed === undefined) return repository.branchesTruncated ? undefined : { reason: "branch_not_found", ...from, branch: named };
    if (listed.worktree !== null) return { reason: "branch_checked_out", ...from, branch: named, worktree: listed.worktree, sessionId: listed.sessionId };
    return undefined;
  }
  if (listed !== undefined) return { reason: "branch_exists", ...from, branch: named };
  if (repository.head === null) return { reason: "no_commits", ...from };
  return undefined;
};

/** Checks `request` for the session `sessionId` on the environment: the resolver's refusal in one line, or undefined to take it. */
export const checkRequest = async (runtime: Runtime, sessionId: string, request: WorkspaceRequest, place: RefusalPlace): Promise<string | undefined> => {
  const path = request.kind === "directory" ? request.path : request.kind === "worktree" ? request.repository : undefined;
  if (path === undefined || runtime.capability(place.environmentId, "workspaces.inspect").status === "absent") return undefined;
  const answer = await runtime.requests.call(place.environmentId, "workspaces.inspect", { path });
  if (!answer.ok) return undefined;
  const refused = refusalOf(answer.result, request, sessionId);
  return refused === undefined ? undefined : resolverRefusal(refused, request, place);
};
