import { requestLabel, resolverRefusal, type DispatchFailure, type RefusalPlace, type SessionRow, type NewSessionView } from "@agent-harness/client-runtime";
import type { WorkspaceRequest } from "@agent-harness/contracts";

/**
 * What the new-session surface says (docs/specs/gui.md, "A new session";
 * workspace-picker spec, "Renderers"; #420): a workspace request's chip
 * with the path it names, and why a start was refused, in one line. The
 * rules are the client runtime's and the environment's, and so are the
 * workspace's words, which the terminal UI says too (#843); what the
 * window says around them is its own.
 */

/** What each way of adding a pane says of a New session control dropped anywhere but the grid. */
export const OFF_GRID = "A new session opens in a pane.";

/**
 * A workspace request as the chip says it, and the path it names on hover:
 * the chip's words are the client runtime's, the path the window's own,
 * another session's workspace shared naming that session by its title.
 */
export const requestWords = (request: WorkspaceRequest, environmentId: string, sessionId: string, rows: readonly SessionRow[]): { readonly label: string; readonly path: string | undefined } => {
  const label = requestLabel(request, sessionId, { environmentId, rows });
  switch (request.kind) {
    case "directory":
      return { label, path: request.path };
    case "scratch":
      return { label, path: undefined };
    case "worktree":
      return { label, path: request.repository };
    case "session": {
      const shared = rows.find((row) => row.environmentId === environmentId && row.summary.id === request.sessionId.toLowerCase());
      return { label, path: shared === undefined ? undefined : `${shared.summary.workspace.path}, shared with “${shared.summary.title}”` };
    }
  }
};

/**
 * Why a start was refused, in one line: the resolver's refusal, a path that
 * is not full, or else what the environment says (a missing workspace to
 * share, an account it cannot run on).
 */
export const refusalLine = (failure: DispatchFailure, request: WorkspaceRequest, place: RefusalPlace): string => {
  if (failure.code === "exists") return "Not started: a session already exists for this composer. Choose New session to keep your message and choices, then send again.";
  const said = resolverRefusal(failure.data ?? {}, request, place);
  if (said !== undefined) return `Not started: ${said}`;
  if (failure.code === "invalid_params" && request.kind === "directory") return `Not started: a workspace is a full path on ${place.where}, or one from its home (~).`;
  return `Not started: ${failure.message}`;
};

/** Explain the selected account without claiming other signed-in accounts are absent. */
export const signInLine = (account: NewSessionView["account"], where: string): string | undefined => {
  if (account.value?.status.state === "signed-in") return undefined;
  if (account.value !== null && account.options.some((option) => option.status.state === "signed-in")) return `${account.value.label} on ${where} is not signed in.`;
  return `No account on ${where} is signed in.`;
};
