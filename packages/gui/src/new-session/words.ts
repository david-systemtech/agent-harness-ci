import type { DispatchFailure, SessionRow } from "@agent-harness/client-runtime";
import { WorkspaceProblem, type Workspace, type WorkspaceRequest } from "@agent-harness/contracts";

/**
 * What the new-session surface says (docs/specs/gui.md, "A new session";
 * workspace-picker spec, "Renderers"; #420): a workspace as its chip says
 * it, a known directory's repository, and why a start was refused, in one
 * line. The rules are the client runtime's and the environment's; the words
 * are the window's.
 */

/** What each way of adding a pane says of a New session control dropped anywhere but the grid. */
export const OFF_GRID = "A new session opens in a pane.";

/** The last part of a path, as the environment's operating system writes it; the path itself when it has none. */
export const baseName = (path: string): string => path.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? path;

/** The branch a new worktree takes when it is not named one: the workspace-picker spec's preset. */
export const presetBranch = (sessionId: string): string => `agent-harness/${sessionId.slice(0, 8)}`;

/** A recorded workspace as a chip says it: its kind, its directory's name, a worktree's repository and branch. */
export const workspaceLabel = (workspace: Workspace): string => {
  switch (workspace.kind) {
    case "worktree":
      return `worktree ${baseName(workspace.repository)} on ${workspace.branch}`;
    case "scratch":
      return "scratch";
    default:
      return `directory ${baseName(workspace.path)}`;
  }
};

/** The session `sessionId` among `rows`, by its id read whatever its case. */
const rowOf = (rows: readonly SessionRow[], environmentId: string, sessionId: string): SessionRow | undefined =>
  rows.find((row) => row.environmentId === environmentId && row.summary.id === sessionId.toLowerCase());

/**
 * A workspace request as the chip says it, and the path it names on hover:
 * a directory by its name, a worktree by its repository and branch (the
 * preset branch named from the id the session is created under), scratch,
 * and another session's workspace as that workspace, shared.
 */
export const requestWords = (request: WorkspaceRequest, environmentId: string, sessionId: string, rows: readonly SessionRow[]): { readonly label: string; readonly path: string | undefined } => {
  switch (request.kind) {
    case "directory":
      return { label: `directory ${baseName(request.path)}`, path: request.path };
    case "scratch":
      return { label: "scratch", path: undefined };
    case "worktree":
      return { label: `worktree ${baseName(request.repository)} on ${request.branch ?? request.newBranch?.name ?? presetBranch(sessionId)}`, path: request.repository };
    case "session": {
      const shared = rowOf(rows, environmentId, request.sessionId);
      return shared === undefined
        ? { label: "another session's", path: undefined }
        : { label: workspaceLabel(shared.summary.workspace), path: `${shared.summary.workspace.path}, shared with “${shared.summary.title}”` };
    }
  }
};

/** A repository identity as a known directory shows it: without its scheme, which is always `https://`. */
export const repositoryWords = (identity: string): string => identity.replace(/^https:\/\//, "");

/** How the environment's refusal of a directory reads, by its problem. */
const PROBLEM_LINES: Readonly<Record<WorkspaceProblem, (path: string, where: string) => string>> = {
  does_not_exist: (path, where) => `${path} does not exist on ${where}.`,
  not_a_directory: (path, where) => `${path} is not a directory on ${where}.`,
  not_readable: (path, where) => `${where} cannot list or enter ${path}.`,
  reserved: (path, where) => `${path} is inside ${where}'s data directory.`,
};

/** Where a refusal is said: the environment's name, its id, and the sessions listed, which name a branch's holder. */
export interface RefusalPlace {
  readonly where: string;
  readonly environmentId: string;
  readonly rows: readonly SessionRow[];
}

/** Where a branch is checked out, and by which session when the harness made that worktree: by its title when it is listed. */
export const heldWords = (worktree: string, sessionId: string | null | undefined, place: RefusalPlace): string => {
  if (sessionId == null) return `checked out in ${worktree}`;
  const holder = rowOf(place.rows, place.environmentId, sessionId);
  return `checked out in ${worktree} by ${holder === undefined ? `the session ${sessionId.slice(0, 8)}` : `“${holder.summary.title}”`}`;
};

/** What a refusal's data names, read as text; undefined where it names nothing. */
const textOf = (data: Readonly<Record<string, unknown>>, key: string): string | undefined => (typeof data[key] === "string" ? data[key] : undefined);

/**
 * The resolver's refusal of a workspace request in one line, from the
 * refusal's data as the environment sends it (workspace-picker spec, "The
 * resolver"): a directory's problem, or a worktree's repository or branch
 * reason. Undefined for a refusal of another kind, which the caller words.
 */
export const resolverRefusal = (data: Readonly<Record<string, unknown>>, request: WorkspaceRequest, place: RefusalPlace): string | undefined => {
  const { where } = place;
  const problem = WorkspaceProblem.safeParse(data["problem"]);
  if (problem.success) return PROBLEM_LINES[problem.data](textOf(data, "path") ?? (request.kind === "directory" ? request.path : ""), where);
  const branch = textOf(data, "branch") ?? "";
  const repository = textOf(data, "repository") ?? (request.kind === "worktree" ? request.repository : "");
  switch (textOf(data, "reason")) {
    case "branch_checked_out":
      return `${branch} is ${heldWords(textOf(data, "worktree") ?? "another worktree", textOf(data, "sessionId"), place)}.`;
    case "branch_exists":
      return `${repository} already has a branch ${branch}: pick it from the list, or name another.`;
    case "branch_not_found":
      return `${repository} has no local branch ${branch} on ${where}.`;
    case "not_a_repository":
      return `${textOf(data, "path") ?? repository} is in no git repository on ${where}.`;
    case "no_commits":
      return `${repository} has no commit for a new branch to start from.`;
    case "git_unavailable":
      return `${where} has no git to make a worktree with.`;
    default:
      return undefined;
  }
};

/**
 * Why a start was refused, in one line: the resolver's refusal, a path that
 * is not full, or else what the environment says (a missing workspace to
 * share, an account it cannot run on).
 */
export const refusalLine = (failure: DispatchFailure, request: WorkspaceRequest, place: RefusalPlace): string => {
  const said = resolverRefusal(failure.data ?? {}, request, place);
  if (said !== undefined) return `Not started: ${said}`;
  if (failure.code === "invalid_params" && request.kind === "directory") return `Not started: a workspace is a full path on ${place.where}, or one from its home (~).`;
  return `Not started: ${failure.message}`;
};
