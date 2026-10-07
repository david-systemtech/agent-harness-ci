import { WorkspaceProblem, type Workspace, type WorkspaceRequest } from "@agent-harness/contracts";
import type { SessionRow } from "../projections/session-list.js";

/**
 * What the workspace picker says, as both renderers say it (workspace-picker
 * spec, "Renderers"; docs/specs/gui.md, "A new session"; ADR 0004; #843): a
 * recorded workspace and a workspace request as a chip says them, the
 * preset branch, a repository identity, a directory's problem and the
 * resolver's worktree and branch reasons, a branch's holder named by its
 * title from the session list. What each renderer says around them ("Not
 * started: ", "The workspace was not changed: ") stays its own.
 */

/** The last part of a path, as the environment's operating system writes it; the path itself when it has none. */
export const baseName = (path: string): string => path.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? path;

/** The branch a new worktree takes when it is not named one: the workspace-picker spec's preset. */
export const presetBranch = (sessionId: string): string => `agent-harness/${sessionId.slice(0, 8)}`;

/** A recorded workspace as a chip and a header say it: its kind, its directory's name, a worktree's repository and branch. */
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

/**
 * A recorded workspace by its name alone, as a session's caption and the
 * window's header say it (#1790): scratch as scratch, never its folder's
 * identifier, a worktree by its repository, a directory by its own name.
 */
export const workspaceName = (workspace: Workspace): string => {
  switch (workspace.kind) {
    case "worktree":
      return baseName(workspace.repository);
    case "scratch":
      return "scratch";
    default:
      return baseName(workspace.path);
  }
};

/** A repository identity as a known directory shows it: without its scheme, which is always `https://`. */
export const repositoryWords = (identity: string): string => identity.replace(/^https:\/\//, "");

/** Where a refusal is said: the environment's name, its id, and the sessions listed, which name a branch's holder and a shared workspace. */
export interface RefusalPlace {
  readonly where: string;
  readonly environmentId: string;
  readonly rows: readonly SessionRow[];
}

/** The sessions listed on the environment, which a request or a refusal names by id. */
type ListedSessions = Pick<RefusalPlace, "environmentId" | "rows">;

/** The session `sessionId` among the rows, by its id read whatever its case. */
const rowOf = ({ environmentId, rows }: ListedSessions, sessionId: string): SessionRow | undefined =>
  rows.find((row) => row.environmentId === environmentId && row.summary.id === sessionId.toLowerCase());

/**
 * A workspace request as its chip says it: a directory by its name, a
 * worktree by its repository and branch (the preset branch named from the
 * id the session is created under), scratch, and another session's
 * workspace as that workspace, shared.
 */
export const requestLabel = (request: WorkspaceRequest, sessionId: string, listed: ListedSessions): string => {
  switch (request.kind) {
    case "directory":
      return `directory ${baseName(request.path)}`;
    case "scratch":
      return "scratch";
    case "worktree":
      return `worktree ${baseName(request.repository)} on ${request.branch ?? request.newBranch?.name ?? presetBranch(sessionId)}`;
    case "session": {
      const shared = rowOf(listed, request.sessionId);
      return shared === undefined ? "another session's" : workspaceLabel(shared.summary.workspace);
    }
  }
};

/** How the environment's refusal of a directory reads, by its problem. */
const PROBLEM_LINES: Readonly<Record<WorkspaceProblem, (path: string, where: string) => string>> = {
  does_not_exist: (path, where) => `${path} does not exist on ${where}.`,
  not_a_directory: (path, where) => `${path} is not a directory on ${where}.`,
  not_readable: (path, where) => `${where} cannot list or enter ${path}.`,
  reserved: (path, where) => `${path} is inside ${where}'s data directory.`,
};

/** Why the directory `path` on `where` cannot be a workspace, in one line. */
export const problemLine = (problem: WorkspaceProblem, path: string, where: string): string => PROBLEM_LINES[problem](path, where);

/** Where a branch is checked out, and by which session when the harness made that worktree: by its title when it is listed. */
export const heldWords = (worktree: string, sessionId: string | null | undefined, listed: ListedSessions): string => {
  if (sessionId == null) return `checked out in ${worktree}`;
  const holder = rowOf(listed, sessionId);
  return `checked out in ${worktree} by ${holder === undefined ? `the session ${sessionId.slice(0, 8)}` : `“${holder.summary.title}”`}`;
};

/** What a refusal's data names, read as text; undefined where it names nothing. */
const textOf = (data: Readonly<Record<string, unknown>>, key: string): string | undefined => (typeof data[key] === "string" ? data[key] : undefined);

/**
 * The resolver's refusal of a workspace request in one line, from the
 * refusal's data as the environment sends it (workspace-picker spec, "The
 * resolver"): a directory's problem, or a worktree's repository or branch
 * reason. Undefined for a refusal of another kind, which the renderer words.
 */
export const resolverRefusal = (data: Readonly<Record<string, unknown>>, request: WorkspaceRequest, place: RefusalPlace): string | undefined => {
  const { where } = place;
  const problem = WorkspaceProblem.safeParse(data["problem"]);
  if (problem.success) return problemLine(problem.data, textOf(data, "path") ?? (request.kind === "directory" ? request.path : ""), where);
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
