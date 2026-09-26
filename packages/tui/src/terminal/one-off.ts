import type { Clock, Runtime, TerminalHandle } from "@agent-harness/client-runtime";
import type { Opened } from "../session/use-session.js";
import { createScreen } from "./screen.js";

/**
 * One-off commands (docs/specs/tui.md, "The composer": `!` runs a command
 * in an environment-owned terminal attached to the workspace, `!!` sends
 * its output). The environment has terminals, not a way to run one
 * command, so a one-off opens a terminal of its own for the session, whose
 * login shell is told to hand itself over to `/bin/sh` running the command:
 *
 * - **The command is never typed.** It goes in the terminal's environment
 *   (`terminals.open`'s variables); the line typed is always the same,
 *   `exec /bin/sh -c "$AGENT_HARNESS_ONE_OFF"`, which every POSIX shell and
 *   fish read alike, so no quoting of the command can go wrong in the
 *   user's shell. It starts with a space, which keeps it out of the history
 *   of fish, of bash with `ignorespace` and of zsh with `HIST_IGNORE_SPACE`.
 *   `sh` rather than the login shell, as Artemis's `!` ran it: a command,
 *   not a session. The terminal's exit is the command's: `exec` replaced the
 *   shell with `sh`, whose status is its last command's.
 * - **`!`** (`shownEnv`) is the command alone: it runs in the pane, where a
 *   person can answer it, page it and read it.
 * - **`!!`** (`oneOffEnv`) has nobody to answer it, so its script prints a
 *   marker, then takes its input from `/dev/null` and tells every pager to
 *   print (`PAGER`, `GIT_PAGER`, `MANPAGER`, `SYSTEMD_PAGER` are `cat`, in
 *   the terminal's variables and again in the script, since a login
 *   shell's rc file may set its own), then runs the command. A program that
 *   opens the terminal itself (`less` named outright, `sudo` or `ssh` asking
 *   a password) still waits, until the minute is up.
 * - **What the command said is what comes after the marker.** Before it are
 *   the login shell's greeting, its prompt and the typed line's echo; the
 *   marker is printed by the script and appears in none of them. With no
 *   marker the command never ran (a shell that could not hand itself to
 *   `sh`): nothing is sent, and the last line the terminal showed says why.
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

/** The line typed into a one-off terminal: its shell hands itself over to `sh` running the script. The space keeps it out of history. */
export const ONE_OFF_LINE = ` exec /bin/sh -c "$${ONE_OFF_VARIABLE}"\r`;

/** How long a `!!` command may run before its terminal is closed. */
export const ONE_OFF_TIMEOUT_MS = 60_000;

/** Output held after the marker, in characters; past it the command runs on, unheard. */
export const ONE_OFF_MAX_CHARS = 256 * 1024;

/** What is held of the terminal before the marker: its tail, to say why when the marker never comes. */
const PREAMBLE_MAX_CHARS = 16 * 1024;

/** Lines of output kept for the agent; the rest are counted. */
export const ONE_OFF_MAX_LINES = 200;

/** The size a `!!` terminal opens at, and its output is read at. */
const ONE_OFF_SIZE = { cols: 120, rows: 40 } as const;

/** The pagers a `!!` command finds, each told to print: nobody is there to press a key. */
export const NO_PAGERS: Readonly<Record<string, string>> = { PAGER: "cat", GIT_PAGER: "cat", MANPAGER: "cat", SYSTEMD_PAGER: "cat" };

/** The script `sh` runs for `!!`: the marker, no input, no pager, then the command as typed. */
export const oneOffScript = (command: string, marker: string): string =>
  [
    `printf '%s\\n' '${marker}'`,
    "exec </dev/null",
    `${Object.entries(NO_PAGERS)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ")}; export ${Object.keys(NO_PAGERS).join(" ")}`,
    command,
  ].join("\n");

/** The variables a `!!` terminal opens with. */
export const oneOffEnv = (command: string, marker: string): Record<string, string> => ({ ...NO_PAGERS, [ONE_OFF_VARIABLE]: oneOffScript(command, marker) });

/** The variables a `!` terminal opens with: the command alone, run where a person can answer it. */
export const shownEnv = (command: string): Record<string, string> => ({ [ONE_OFF_VARIABLE]: command });

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

/** What a `!!` terminal printed, held as it arrives: the tail of what came before the marker's line, and up to `ONE_OFF_MAX_CHARS` after it. */
export interface OneOffOutput {
  take(data: string): void;
  /** Starts again (a snapshot: the retained scrollback, from the start). */
  reset(): void;
  /** What came after the marker's line, and whether more came than was held; null before the marker's line has come. */
  said(): { readonly text: string; readonly cut: boolean } | null;
  /** The tail of what came before the marker (all of it, while no marker has come). */
  before(): string;
}

export const oneOffOutput = (marker: string, max = ONE_OFF_MAX_CHARS): OneOffOutput => {
  let before = "";
  let after: string | null = null;
  let cut = false;
  const hold = (data: string) => {
    const room = max - (after ?? "").length;
    if (data.length > room) cut = true;
    after = (after ?? "") + data.slice(0, Math.max(0, room));
  };
  return {
    take(data) {
      if (after !== null) return hold(data);
      before += data;
      const at = before.indexOf(marker);
      const end = at === -1 ? -1 : before.indexOf("\n", at);
      if (end === -1) {
        // The marker may be arriving in pieces: the tail kept is always longer than it.
        if (before.length > PREAMBLE_MAX_CHARS) before = before.slice(-PREAMBLE_MAX_CHARS);
        return;
      }
      const rest = before.slice(end + 1);
      before = before.slice(0, at);
      hold(rest);
    },
    reset() {
      before = "";
      after = null;
      cut = false;
    },
    said: () => (after === null ? null : { text: after, cut }),
    before: () => before,
  };
};

/** `raw` as a terminal `ONE_OFF_SIZE` wide shows it, as text. */
export const shownText = async (raw: string): Promise<string> => {
  const screen = createScreen({ ...ONE_OFF_SIZE, scrollback: ONE_OFF_MAX_LINES * 20 });
  await screen.write(raw);
  const text = screen.text();
  screen.dispose();
  return text;
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
      /** How long it was given. */
      readonly timeoutMs: number;
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

type Ended = { readonly exitCode: number | null; readonly signal: number | null; readonly timedOut: boolean };

/** Runs `command` for `!!` in a terminal of its own on the session's environment and reads what it printed. */
export const runOneOff = async (deps: OneOffDeps, target: Opened, command: string): Promise<OneOffResult> => {
  const { runtime, clock } = deps;
  const { environmentId, sessionId } = target;
  const timeoutMs = deps.timeoutMs ?? ONE_OFF_TIMEOUT_MS;
  const id = deps.newTerminalId();
  const marker = `agent-harness-one-off-${id}`;
  const opened = await runtime.requests.call(environmentId, "terminals.open", {
    commandId: deps.newCommandId(),
    id,
    sessionId,
    ...ONE_OFF_SIZE,
    env: oneOffEnv(command, marker),
  });
  if (!opened.ok) return { ok: false, line: opened.error.message };
  if (opened.result.receipt.status === "rejected") return { ok: false, line: opened.result.receipt.error.message };

  const heard = oneOffOutput(marker);
  let handle: TerminalHandle | undefined;
  let timer: { cancel(): void } | undefined;
  const ended = new Promise<Ended>((resolve) => {
    timer = clock.setTimeout(() => resolve({ exitCode: null, signal: null, timedOut: true }), timeoutMs);
    handle = runtime.subscriptions.terminal(environmentId, id, (output) => {
      if (output.kind === "reset") {
        heard.reset();
        heard.take(output.data);
      } else if (output.kind === "output") heard.take(output.data);
      else resolve({ exitCode: output.exit.exitCode, signal: output.exit.signal, timedOut: false });
    });
    // A terminal gone before it could be heard (closed by another client) says nothing more.
    handle.state.subscribe((view) => {
      if (view.status === "ended" && view.exit === null) resolve({ exitCode: null, signal: null, timedOut: false });
    });
  });
  const typed = await runtime.requests.call(environmentId, "terminals.write", { commandId: deps.newCommandId(), id, data: ONE_OFF_LINE });
  const end: Ended = typed.ok && typed.result.receipt.status === "accepted" ? await ended : { exitCode: null, signal: null, timedOut: false };
  timer?.cancel();
  handle?.release();
  // Closed whichever way it ended: an exited terminal stays listed until it is.
  void runtime.requests.call(environmentId, "terminals.close", { commandId: deps.newCommandId(), id });
  if (!typed.ok) return { ok: false, line: typed.error.message };
  if (typed.result.receipt.status === "rejected") return { ok: false, line: typed.result.receipt.error.message };

  const said = heard.said();
  if (said === null) {
    // The command never ran: what the terminal showed is the shell's, never the command's, so none of it goes to the agent.
    const last = (await shownText(heard.before())).split("\n").findLast((line) => line.trim().length > 0);
    const why = end.timedOut ? `within ${seconds(timeoutMs)}` : "before its terminal ended";
    return { ok: false, line: `The shell never started it ${why}${last === undefined ? "." : `; it last showed: ${last.trim()}`}` };
  }
  return { ok: true, output: clipOutput(await shownText(said.text)), ...end, timeoutMs, cut: said.cut };
};

const seconds = (ms: number): string => `${String(Math.round(ms / 1000))}s`;

/**
 * The message `!!` sends (Artemis's form): the command named, its output
 * fenced, and how it ended when that was not cleanly.
 */
export const oneOffMessage = (command: string, result: Extract<OneOffResult, { readonly ok: true }>): string => {
  const notes = [
    result.cut ? `… output stopped after ${String(ONE_OFF_MAX_CHARS / 1024)}K characters` : undefined,
    result.timedOut ? `timed out after ${seconds(result.timeoutMs)}` : undefined,
    result.signal !== null ? `killed by signal ${String(result.signal)}` : result.exitCode !== null && result.exitCode !== 0 ? `exit ${String(result.exitCode)}` : undefined,
  ].filter((note): note is string => note !== undefined);
  const body = [result.output, ...notes].filter((part) => part.length > 0).join("\n");
  return `Ran \`${command}\`:\n\`\`\`\n${body}\n\`\`\``;
};
