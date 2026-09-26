import type { Clock, Runtime, TerminalHandle } from "@agent-harness/client-runtime";
import { createScreen } from "./screen.js";

/**
 * A one-off command (docs/specs/tui.md, "The composer": `!!` runs a command
 * in an environment-owned terminal attached to the workspace and sends its
 * output). The environment has terminals, not a way to run one command, so
 * `!!` opens a terminal of its own for the session, and its login shell is
 * told to hand itself over to `/bin/sh` running the command:
 *
 * - **The command is never typed.** It goes in the terminal's environment
 *   (`terminals.open`'s variables), in a script whose first line prints a
 *   marker; the line typed is always the same, `exec /bin/sh -c
 *   "$AGENT_HARNESS_ONE_OFF"`, which every POSIX shell and fish read alike,
 *   so no quoting of the command can go wrong in the user's shell. `sh`
 *   rather than the login shell, as Artemis's `!` ran it: a command, not a
 *   session.
 * - **What the command said is what comes after the marker.** Before it are
 *   the login shell's greeting, its prompt and the typed line's echo; the
 *   marker is printed by the script and appears in none of them. The
 *   terminal's exit is the command's: `exec` replaced the shell with `sh`,
 *   whose status is its last command's.
 * - **It is read as a terminal would show it**: the output goes through the
 *   same headless emulator the pane draws with, so carriage-return progress
 *   bars and colours come out as the text a person saw, cut to its first
 *   `ONE_OFF_MAX_LINES` lines with the rest counted (Artemis's `shell.ts`).
 * - **A minute at most**: past `ONE_OFF_TIMEOUT_MS` the terminal is closed
 *   and the output says so. Every way it ends, the terminal is closed, so
 *   it never counts against the session's sixteen.
 */

/** The variable the command's script is handed in. */
export const ONE_OFF_VARIABLE = "AGENT_HARNESS_ONE_OFF";

/** The line typed into the one-off terminal: its shell hands itself over to `sh` running the script. */
export const ONE_OFF_LINE = `exec /bin/sh -c "$${ONE_OFF_VARIABLE}"\r`;

/** How long a one-off command may run before its terminal is closed. */
export const ONE_OFF_TIMEOUT_MS = 60_000;

/** Output held while it arrives; past it the command runs on, unheard. */
export const ONE_OFF_MAX_BYTES = 256 * 1024;

/** Lines of output kept for the agent; the rest are counted. */
export const ONE_OFF_MAX_LINES = 200;

/** The size the one-off terminal opens at, and its output is read at. */
const ONE_OFF_SIZE = { cols: 120, rows: 40 } as const;

/** The script `sh` runs: the marker, then the command as typed. */
export const oneOffScript = (command: string, marker: string): string => `printf '%s\\n' '${marker}'\n${command}`;

/** What came after the marker's line; null when the marker never came (the command did not run). */
export const afterMarker = (raw: string, marker: string): string | null => {
  const at = raw.indexOf(marker);
  if (at === -1) return null;
  const end = raw.indexOf("\n", at);
  return end === -1 ? "" : raw.slice(end + 1);
};

/** The first `max` lines, and a count of the rest (Artemis's `clipOutput`). */
export const clipOutput = (text: string, max = ONE_OFF_MAX_LINES): string => {
  const rows = text.split("\n");
  if (rows.length <= max) return text;
  const dropped = rows.length - max;
  return [...rows.slice(0, max), `… ${String(dropped)} more line${dropped === 1 ? "" : "s"}`].join("\n");
};

export type OneOffResult =
  | {
      readonly ok: true;
      /** What the command printed, as a terminal showed it, cut to its first lines. */
      readonly output: string;
      /** Its exit code; null when it did not exit (timed out). */
      readonly exitCode: number | null;
      readonly signal: number | null;
      readonly timedOut: boolean;
      /** More came than was held. */
      readonly cut: boolean;
    }
  | { readonly ok: false; readonly line: string };

export interface OneOffDeps {
  readonly runtime: Runtime;
  readonly clock: Clock;
  readonly newCommandId: () => string;
  readonly newTerminalId: () => string;
  readonly timeoutMs?: number;
}

/** Runs `command` in a terminal of its own on the session's environment and reads what it printed. */
export const runOneOff = async (deps: OneOffDeps, target: { readonly environmentId: string; readonly sessionId: string }, command: string): Promise<OneOffResult> => {
  const { runtime, clock } = deps;
  const { environmentId, sessionId } = target;
  const id = deps.newTerminalId();
  const marker = `agent-harness-one-off-${id}`;
  const opened = await runtime.requests.call(environmentId, "terminals.open", {
    commandId: deps.newCommandId(),
    id,
    sessionId,
    ...ONE_OFF_SIZE,
    env: { [ONE_OFF_VARIABLE]: oneOffScript(command, marker) },
  });
  if (!opened.ok) return { ok: false, line: opened.error.message };
  if (opened.result.receipt.status === "rejected") return { ok: false, line: opened.result.receipt.error.message };

  let raw = "";
  let cut = false;
  const take = (data: string) => {
    const room = ONE_OFF_MAX_BYTES * 2 - raw.length;
    if (data.length > room) cut = true;
    raw += data.slice(0, Math.max(0, room));
  };
  let handle: TerminalHandle | undefined;
  const ended = new Promise<{ readonly exitCode: number | null; readonly signal: number | null; readonly timedOut: boolean }>((resolve) => {
    const timer = clock.setTimeout(() => resolve({ exitCode: null, signal: null, timedOut: true }), deps.timeoutMs ?? ONE_OFF_TIMEOUT_MS);
    handle = runtime.subscriptions.terminal(environmentId, id, (output) => {
      if (output.kind === "reset") {
        raw = "";
        take(output.data);
      } else if (output.kind === "output") take(output.data);
      else {
        timer.cancel();
        resolve({ exitCode: output.exit.exitCode, signal: output.exit.signal, timedOut: false });
      }
    });
    // A terminal gone before it could be heard (closed by another client) says nothing more.
    handle.state.subscribe((view) => {
      if (view.status === "ended" && view.exit === null) {
        timer.cancel();
        resolve({ exitCode: null, signal: null, timedOut: false });
      }
    });
  });
  const typed = await runtime.requests.call(environmentId, "terminals.write", { commandId: deps.newCommandId(), id, data: ONE_OFF_LINE });
  const end = typed.ok && typed.result.receipt.status === "accepted" ? await ended : { exitCode: null, signal: null, timedOut: false };
  handle?.release();
  // Closed whichever way it ended: an exited terminal stays listed until it is.
  void runtime.requests.call(environmentId, "terminals.close", { commandId: deps.newCommandId(), id }).catch(() => undefined);
  if (!typed.ok) return { ok: false, line: typed.error.message };
  if (typed.result.receipt.status === "rejected") return { ok: false, line: typed.result.receipt.error.message };

  const said = afterMarker(raw, marker);
  const screen = createScreen({ ...ONE_OFF_SIZE, scrollback: ONE_OFF_MAX_LINES * 20 });
  // No marker: the command never ran (a shell that could not hand itself to `sh`); what the terminal showed says why.
  await screen.write((said ?? raw).slice(0, ONE_OFF_MAX_BYTES));
  const output = clipOutput(screen.text());
  screen.dispose();
  return { ok: true, output, ...end, cut: cut || (said ?? raw).length > ONE_OFF_MAX_BYTES };
};

/**
 * The message `!!` sends (Artemis's form): the command named, its output
 * fenced, and how it ended when that was not cleanly.
 */
export const oneOffMessage = (command: string, result: Extract<OneOffResult, { readonly ok: true }>): string => {
  const notes = [
    result.cut ? `… output stopped after ${String(ONE_OFF_MAX_BYTES / 1024)} KB` : undefined,
    result.timedOut ? `timed out after ${String(ONE_OFF_TIMEOUT_MS / 1000)}s` : undefined,
    result.signal !== null ? `killed by signal ${String(result.signal)}` : result.exitCode !== null && result.exitCode !== 0 ? `exit ${String(result.exitCode)}` : undefined,
  ].filter((note): note is string => note !== undefined);
  const body = [result.output, ...notes].filter((part) => part.length > 0).join("\n");
  return `Ran \`${command}\`:\n\`\`\`\n${body}\n\`\`\``;
};
