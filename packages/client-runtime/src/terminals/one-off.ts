import { NO_PAGERS, ONE_OFF_MAX_CHARS, oneOffOutput, type TerminalInfo } from "@agent-harness/contracts";
import type { Clock } from "../platform.js";
import type { Runtime } from "../runtime.js";
import type { TerminalHandle } from "../streams/terminals.js";
import type { TextScreens } from "./text-screen.js";

/** One-offs use terminals.run: closed stdin, no login startup and no controlling terminal. */

/**
 * Closes terminal `id` (`terminals.close`). A close the environment could not
 * be asked (unreachable, the socket gone with it) is sent once more when it
 * can be asked again, as the pane's size is; a refusal is a terminal already
 * closed or not there. The environment keeps an exited terminal listed until
 * it is closed, so a lost close would leave it counting against the session.
 */
export const closeTerminal = (runtime: Runtime, environmentId: string, id: string, newCommandId: () => string): void => {
  const close = () => runtime.requests.call(environmentId, "terminals.close", { commandId: newCommandId(), id });
  void close().then((answer) => {
    if (answer.ok) return;
    const stop = runtime.projections.environments.subscribe(() => {
      if (runtime.capability(environmentId, "terminals.close").status === "absent") return;
      stop();
      void close();
    });
  });
};

/** How long a `!!` command may run before its terminal is closed. */
export const ONE_OFF_TIMEOUT_MS = 60_000;

/** Lines of output kept for the agent; the rest are counted. */
export const ONE_OFF_MAX_LINES = 200;

/** The size a `!!` terminal opens at, and its output is read at. */
const ONE_OFF_SIZE = { cols: 120, rows: 40 } as const;

/** The first `max` lines, and a count of the rest, `more` lines past `text` among them. */
export const clipOutput = (text: string, max = ONE_OFF_MAX_LINES, more = 0): string => {
  const rows = text.split("\n");
  const dropped = Math.max(0, rows.length - max) + more;
  if (dropped === 0) return text;
  return [...rows.slice(0, max), `… ${String(dropped)} more line${dropped === 1 ? "" : "s"}`].join("\n");
};

/** The line feeds of output read through the screen at most; the lines after them are counted by their line feeds. */
const SHOWN_MAX_FEEDS = ONE_OFF_MAX_LINES * 8;

/**
 * The reader screen's scrollback: every row printed text can fill, `SHOWN_MAX_FEEDS` line feeds and the wrapping of
 * `ONE_OFF_MAX_CHARS` characters of two cells each (the widest a character is in the emulator; a character past the
 * basic plane is two of them), so no first line of text is lost. A program that moves down without a line feed (a
 * vertical tab, an index) or prints by escape (a repeat) can fill more: `shownOutput` then reads less.
 */
const SHOWN_SCROLLBACK = SHOWN_MAX_FEEDS + 1 + Math.ceil((2 * ONE_OFF_MAX_CHARS) / ONE_OFF_SIZE.cols);

/**
 * `raw` as a terminal shows it, cut to its first `ONE_OFF_MAX_LINES` lines with the rest counted. Only its start is read
 * through the screen, up to `SHOWN_MAX_FEEDS` line feeds, and less while the screen comes back full (its oldest lines may
 * be gone); the lines after that are counted by their line feeds, a line cut short counted among them.
 */
export const shownOutput = async (screens: TextScreens, raw: string): Promise<string> => {
  let end = raw.length;
  let at = -1;
  for (let feeds = 0; feeds < SHOWN_MAX_FEEDS; feeds++) {
    at = raw.indexOf("\n", at + 1);
    if (at === -1) break;
  }
  if (at !== -1) end = at + 1;
  for (;;) {
    const read = await readThrough(screens, raw.slice(0, end));
    if (read !== null) {
      const rest = raw.slice(end).trimEnd();
      return clipOutput(read, ONE_OFF_MAX_LINES, rest.length === 0 ? 0 : rest.split("\n").length);
    }
    end = shorter(raw, end);
  }
};

/** Where to cut `raw` short of `end`: after the last line feed in the first half, else at the half, never inside a pair of surrogates. */
const shorter = (raw: string, end: number): number => {
  const half = Math.floor(end / 2);
  const feed = half === 0 ? -1 : raw.lastIndexOf("\n", half - 1);
  if (feed !== -1) return feed + 1;
  const code = raw.charCodeAt(half - 1);
  return code >= 0xd800 && code <= 0xdbff ? half - 1 : half;
};

/** `raw` as the reader screen shows it, as text; null when the screen came back full, so its first lines may be gone. */
const readThrough = async (screens: TextScreens, raw: string): Promise<string | null> => {
  const screen = screens({ ...ONE_OFF_SIZE, scrollback: SHOWN_SCROLLBACK });
  await screen.write(raw);
  const text = screen.full() ? null : screen.text();
  screen.dispose();
  return text;
};

/** `raw` as a terminal `ONE_OFF_SIZE` wide shows it, as text. */
export const shownText = async (screens: TextScreens, raw: string): Promise<string> => {
  const screen = screens({ ...ONE_OFF_SIZE, scrollback: ONE_OFF_MAX_LINES * 20 });
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
      /** Its exit code; null when it did not exit (timed out, or its terminal went away). */
      readonly exitCode: number | null;
      readonly signal: number | null;
      readonly timedOut: boolean;
      /** Its terminal went away before it ended (closed by another client, lost to a restart of the environment): what it said is partial. */
      readonly gone: boolean;
      /** How long it was given. */
      readonly timeoutMs: number;
      /** More came than was held. */
      readonly cut: boolean;
      /** Its start was gone from the terminal's scrollback when its subscription started again. */
      readonly dropped: boolean;
    }
  | { readonly ok: false; readonly line: string };

export interface OneOffDeps {
  readonly runtime: Runtime;
  readonly clock: Clock;
  readonly newCommandId: () => string;
  readonly newTerminalId: () => string;
  /** The emulator the renderer draws a terminal with, which what the command printed is read through. */
  readonly screens: TextScreens;
  readonly timeoutMs?: number;
}

/** The session a one-off runs for, on its environment. */
export interface OneOffTarget {
  readonly environmentId: string;
  readonly sessionId: string;
}

type Ended = { readonly exitCode: number | null; readonly signal: number | null; readonly timedOut: boolean; readonly gone: boolean };

/** Runs `command` for `!!` in a terminal of its own on the session's environment and reads what it printed. */
export const runOneOff = async (deps: OneOffDeps, target: OneOffTarget, command: string): Promise<OneOffResult> => {
  const { runtime, clock } = deps;
  const { environmentId, sessionId } = target;
  const timeoutMs = deps.timeoutMs ?? ONE_OFF_TIMEOUT_MS;
  const id = deps.newTerminalId();
  const opened = await runtime.requests.call(environmentId, "terminals.run", {
    commandId: deps.newCommandId(),
    id,
    sessionId,
    ...ONE_OFF_SIZE,
    command,
    env: { ...NO_PAGERS },
  });
  if (!opened.ok) return { ok: false, line: opened.error.message };
  if (opened.result.receipt.status === "rejected") return { ok: false, line: opened.result.receipt.error.message };

  const heard = oneOffOutput();
  let handle: TerminalHandle | undefined;
  let timer: { cancel(): void } | undefined;
  const ended = new Promise<Ended>((resolve) => {
    timer = clock.setTimeout(() => resolve({ exitCode: null, signal: null, timedOut: true, gone: false }), timeoutMs);
    handle = runtime.subscriptions.terminal(environmentId, id, (output) => {
      if (output.kind === "reset") heard.reset(output.data, output.truncated);
      else if (output.kind === "output") heard.take(output.data);
      else resolve({ exitCode: output.exit.exitCode, signal: output.exit.signal, timedOut: false, gone: false });
    });
    // A terminal gone with no exit said (closed by another client, lost to a restart) says nothing more.
    handle.state.subscribe((view) => {
      if (view.status === "ended" && view.exit === null) resolve({ exitCode: null, signal: null, timedOut: false, gone: true });
    });
  });
  const end = await ended;
  timer?.cancel();
  handle?.release();
  closeTerminal(runtime, environmentId, id, deps.newCommandId);
  const said = heard.said();
  return { ok: true, output: await shownOutput(deps.screens, said.text), ...end, timeoutMs, cut: said.cut, dropped: said.dropped };
};

const seconds = (ms: number): string => `${String(Math.round(ms / 1000))}s`;

/**
 * The message `!!` sends: the command named, its output
 * fenced, and how it ended when that was not cleanly; a command that
 * printed nothing and ended cleanly is said to have printed nothing.
 */
export const oneOffMessage = (command: string, result: Extract<OneOffResult, { readonly ok: true }>): string => {
  const notes = [
    result.cut ? `… output stopped after ${String(ONE_OFF_MAX_CHARS / 1024)}K characters` : undefined,
    result.timedOut ? `timed out after ${seconds(result.timeoutMs)}` : undefined,
    result.gone ? "the terminal went away before the command ended" : undefined,
    result.signal !== null ? `killed by signal ${String(result.signal)}` : result.exitCode !== null && result.exitCode !== 0 ? `exit ${String(result.exitCode)}` : undefined,
  ].filter((note): note is string => note !== undefined);
  const body = [...(result.dropped ? ["… earlier output dropped"] : []), result.output, ...notes].filter((part) => part.length > 0).join("\n");
  // Nothing printed and a clean end: said in words, since an empty fence reads as one blank line of output.
  if (body.length === 0) return `Ran \`${command}\`; it printed nothing.`;
  return `Ran \`${command}\`:\n\`\`\`\n${body}\n\`\`\``;
};

/**
 * The terminal a pane reopens as its session's shell: the newest `terminals.list` has still running that is not a one-off
 * this client started (`oneOffs`, by lowercased id), which only its own `!` or `!!` shows; undefined when there is none.
 */
export const reusableTerminal = (terminals: readonly TerminalInfo[], oneOffs: ReadonlySet<string>): TerminalInfo | undefined =>
  terminals.filter((t) => t.exitCode === null && !oneOffs.has(t.id.toLowerCase())).at(-1);
