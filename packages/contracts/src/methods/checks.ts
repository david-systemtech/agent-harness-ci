import { z } from "zod";
import { CheckCommand, WorkspaceCheck } from "../checks.js";
import { commandParams, defineMethod } from "../method.js";
import { SessionId } from "../sessions.js";
import { TerminalId } from "../terminals.js";

/**
 * The Workspace check methods (switch-over spec, "Phase-D commands and
 * parity", Checks; #1187), each at scope `terminal`, each naming the
 * session whose Workspace directory it reads, sets or checks; offered with
 * the `workspaceChecks` flag. A session that is not on this environment, or
 * is deleted, is `not_found` with data `kind: session`. The configuration
 * is the directory's, not the session's: every session and client in the
 * same canonical directory reads and sets the same command.
 */

/**
 * The session's Workspace directory, as checks key it, and its check
 * command, null when none is set. A directory that is gone answers with the
 * real path it had, as far as what is left of the path the session recorded
 * shows it (the nearest part still there resolved, a dangling link followed),
 * and that path's command.
 */
export const checksGet = defineMethod({
  name: "checks.get",
  scope: "terminal",
  kind: "query",
  params: z.object({ sessionId: SessionId }),
  result: WorkspaceCheck,
  errors: [],
});

/**
 * Sets the directory's check command to `command`, verbatim, or clears it
 * with null, and answers the directory's check as it now is. A change
 * appends the notice `checks.changed` naming the caller; setting the
 * command it has changes nothing. A check already running goes on, its
 * rows kept. A directory that is gone is `conflict`, reason
 * `workspace_missing`.
 */
export const checksSet = defineMethod({
  name: "checks.set",
  scope: "terminal",
  kind: "command",
  params: commandParams({ sessionId: SessionId, command: CheckCommand.nullable() }),
  result: WorkspaceCheck,
  errors: [],
});

/**
 * Runs the directory's check now, in a terminal of the session that the
 * environment opens as `terminals.run` opens one (`/bin/sh -c` in the
 * Workspace directory), and answers that terminal's id, which
 * `terminals.subscribe` streams. Appends `checks.started` on the session,
 * and `checks.finished` when it ends. Refused `conflict` with reason
 * `check_unset` when the directory has no command, `check_running` while
 * a check of the directory runs, `workspace_missing` when the directory is
 * gone or did not answer in time, and `too_many_terminals` when the session
 * holds 16 terminals; a retry of the same command answers its receipt and
 * runs nothing.
 */
export const checksRun = defineMethod({
  name: "checks.run",
  scope: "terminal",
  kind: "command",
  params: commandParams({ sessionId: SessionId }),
  result: z.object({ terminalId: TerminalId.meta({ description: "The terminal the check runs in, which the environment opened; terminals.subscribe streams it." }) }),
  errors: [],
});
