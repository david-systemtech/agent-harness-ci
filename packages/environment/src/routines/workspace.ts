import type { RoutineWorkspace } from "@agent-harness/contracts";
import type { CheckoutIndex } from "../workspace/checkout-index.js";
import type { DirectoryRules } from "../workspace/resolver.js";

/**
 * Where a routine's workspace stands on this environment when it is saved
 * (routines spec, "The routine", "Moving a routine"; workspace-picker spec,
 * "Completions, minted sessions, routines, hand-off"; #528). A routine keeps
 * its workspace as a request, resolved per firing; what a save records
 * beside it is the repository identity it resolves to here (#324's rule),
 * the one a move re-resolves it by on another environment.
 *
 * - **Usable here**: a directory's path, or a worktree's repository, that
 *   the resolver's directory rules would let a session work in. It is kept
 *   as written, with the identity git finds there now (none outside a
 *   repository or where git gives none).
 * - **Not usable here** (not there, not a directory, unreadable, reserved,
 *   or not a path this operating system reads as absolute): an import, whose
 *   document may come from another machine, re-resolves it through the
 *   checkout index when its identity is known: to this environment's most
 *   recently used present directory with that identity, a worktree keeping
 *   its branch, else to `scratch`. Otherwise it is kept as written with the
 *   identity it carried, which this environment cannot check, and its
 *   firings refuse it until the path is there.
 * - **Scratch** has no identity.
 */

/** A workspace as a save records it, and whether an import re-resolved it from a path not usable here. */
export interface PlacedWorkspace {
  readonly workspace: RoutineWorkspace;
  readonly reresolved: boolean;
}

export interface RoutineWorkspaces {
  /**
   * The workspace as a save records it; with `reresolve`, as an import
   * records it. Answered at once, not as a promise, when no directory or
   * git is asked (scratch), so a create keeps its place among its socket's
   * requests.
   */
  place(workspace: RoutineWorkspace, reresolve: boolean): PlacedWorkspace | Promise<PlacedWorkspace>;
}

export interface RoutineWorkspacesOptions {
  /** The environment's directory rules, which `sessions.create`'s resolver reads a directory by. */
  readonly directoryRules: DirectoryRules;
  /** The checkout index (#329), which an import re-resolves a path not usable here through. */
  readonly checkoutIndex: CheckoutIndex;
}

const SCRATCH: PlacedWorkspace = { workspace: { kind: "scratch", repositoryIdentity: null }, reresolved: false };

export const createRoutineWorkspaces = ({ directoryRules, checkoutIndex }: RoutineWorkspacesOptions): RoutineWorkspaces => {
  /** The path as the resolver records it when a session could work there; null when not. */
  const usable = async (path: string): Promise<string | null> => {
    let recorded: string;
    try {
      recorded = directoryRules.recorded(path);
    } catch {
      // A path this operating system does not read as absolute, such as another machine's drive letter.
      return null;
    }
    return (await directoryRules.problemWith(recorded)) === null ? recorded : null;
  };

  const placeAt = async (workspace: Exclude<RoutineWorkspace, { kind: "scratch" }>, reresolve: boolean): Promise<PlacedWorkspace> => {
    const recorded = await usable(workspace.kind === "directory" ? workspace.path : workspace.repository);
    if (recorded !== null) return { workspace: { ...workspace, repositoryIdentity: await directoryRules.identityAt(recorded) }, reresolved: false };
    const identity = workspace.repositoryIdentity;
    if (!reresolve || identity === null) return { workspace, reresolved: false };
    const checkout = await checkoutIndex.checkoutFor(identity);
    if (checkout.kind === "scratch") return { ...SCRATCH, reresolved: true };
    const moved: RoutineWorkspace = workspace.kind === "directory" ? { ...workspace, path: checkout.path } : { ...workspace, repository: checkout.path };
    return { workspace: moved, reresolved: true };
  };

  return { place: (workspace, reresolve) => (workspace.kind === "scratch" ? SCRATCH : placeAt(workspace, reresolve)) };
};
