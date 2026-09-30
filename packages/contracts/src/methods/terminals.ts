import { z } from "zod";
import { commandParams, defineMethod, subscriptionParams } from "../method.js";
import { SessionId } from "../sessions.js";
import {
  TerminalColumns,
  TerminalEnvironment,
  TerminalId,
  TerminalInfo,
  TerminalRows,
  TerminalSnapshot,
} from "../terminals.js";

/**
 * The terminal methods (tui spec, "Terminals, files and diffs"; #124), each
 * at scope `terminal`. The mutating ones are commands, answered with a
 * receipt like any other, and append nothing to the log: their receipt's
 * `changed` is false and its `sequence` the head it found. A command on a
 * session that is not on this environment, or is deleted, is rejected
 * `not_found` with data `kind: session`; on a terminal that is not open (never
 * opened, closed, or gone with its session, or with a restart of the
 * environment) `not_found` with data `kind: terminal`. Writing to or resizing
 * a terminal whose shell has exited is `conflict`, reason `exited`.
 *
 * A tool terminal (#362), which the Managed tools registry opens in process
 * rather than `terminals.open`, is streamed, written to, resized and closed
 * by its id like any other; but only a client session that also holds
 * `admin` may write to it, resize it or close it (David, 2026-09-28: the
 * scope that starts an install answers its prompts), anyone else refused
 * `forbidden` with data `scope: admin` in the receipt. `terminals.list`
 * never lists one.
 */

const terminalTarget = { id: TerminalId };

/**
 * Opens a terminal for the session: the user's login shell (from the passwd
 * entry, else `/bin/sh`) in the workspace directory, at the size given or
 * 80 by 24, with the variables given on top of a clean base. An id already
 * used on this environment (since it started, or named by an accepted
 * command's receipt in the last 30 days) is `conflict`, reason `exists`; a
 * session already holding 16 terminals, running or exited, is `conflict`,
 * reason `too_many_terminals`; a workspace
 * directory that is gone, or does not answer the environment's look in
 * time (a network mount whose server is gone), is `conflict`, reason
 * `workspace_missing`; an environment that cannot start a pseudo-terminal is
 * `conflict`, reason `pty_unavailable`. The terminal's other commands and
 * its subscription, sent while the open is still looking at the workspace,
 * are decided after it.
 */
export const terminalsOpen = defineMethod({
  name: "terminals.open",
  scope: "terminal",
  kind: "command",
  params: commandParams({
    ...terminalTarget,
    sessionId: SessionId,
    cols: TerminalColumns.optional(),
    rows: TerminalRows.optional(),
    env: TerminalEnvironment.optional(),
  }),
  result: z.object({ terminal: TerminalInfo }),
  errors: [],
});

/** Writes `data` to the terminal, as keys typed at it: at most 1 MiB of text a command. */
export const terminalsWrite = defineMethod({
  name: "terminals.write",
  scope: "terminal",
  kind: "command",
  params: commandParams({
    ...terminalTarget,
    data: z
      .string()
      .min(1)
      .max(1024 * 1024)
      .meta({ description: "What to write, as keys typed at the terminal; at most 1 MiB." }),
  }),
  result: z.object({ id: TerminalId }),
  errors: [],
});

/** Resizes the terminal; answers it at its new size. */
export const terminalsResize = defineMethod({
  name: "terminals.resize",
  scope: "terminal",
  kind: "command",
  params: commandParams({ ...terminalTarget, cols: TerminalColumns, rows: TerminalRows }),
  result: z.object({ terminal: TerminalInfo }),
  errors: [],
});

/**
 * Closes the terminal: its shell is hung up (and killed if it lingers), its
 * scrollback dropped, and it leaves the list; a subscription hears
 * `terminal.exited` with cause `closed`, then ends `closed`. On a terminal
 * whose shell has exited it only drops it.
 */
export const terminalsClose = defineMethod({
  name: "terminals.close",
  scope: "terminal",
  kind: "command",
  params: commandParams(terminalTarget),
  result: z.object({ id: TerminalId }),
  errors: [],
});

/**
 * The session's open terminals, oldest first: each one's id, when it
 * opened, its size and its exit code (null while its shell runs). A terminal
 * whose shell has exited stays listed, with its scrollback, until it is
 * closed or its session deleted. A tool terminal is no session's, and is
 * never listed.
 */
export const terminalsList = defineMethod({
  name: "terminals.list",
  scope: "terminal",
  kind: "query",
  params: z.object({ sessionId: SessionId }),
  result: z.object({ terminals: z.array(TerminalInfo) }),
  errors: [],
});

/**
 * A terminal's output: from cursor 0, the snapshot of its retained
 * scrollback; from a cursor the scrollback still reaches, the chunks after
 * it (`terminal.output` events, whose sequence is the terminal's own), or the
 * snapshot when they pass the replay bound or the cursor is older than the
 * retained tail (its `truncated` says so); then `synchronized`, the chunks
 * live, and at the end one `terminal.exited` and `end`: `deleted` when the
 * session was deleted, `closed` otherwise. An unknown terminal is `not_found`.
 */
export const terminalsSubscribe = defineMethod({
  name: "terminals.subscribe",
  scope: "terminal",
  kind: "stream",
  params: subscriptionParams(terminalTarget),
  result: TerminalSnapshot,
  errors: [],
});
