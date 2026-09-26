import type { Clock, Timer } from "@agent-harness/client-runtime";

/**
 * What the terminal says while nobody is looking at it (docs/specs/tui.md,
 * "Cards" and "Attention"; carried from Artemis's `apps/tui/src/terminal.ts`
 * at 443cf2e): the window title, a notification or the bell, and the timer
 * that waits until a person has stopped typing before either rings. This is
 * all of the bytes and none of the policy; `policy.ts` says what to say and
 * `use-attention.ts` when.
 *
 * Carried as Artemis wrote it, with its variables renamed
 * (`AGENT_HARNESS_TUI_NO_TITLE`, `AGENT_HARNESS_TUI_NOTIFY`), its timer on
 * the platform's clock, and the taskbar light (`progressState`) left out,
 * since the terminal UI's attention is the title and the bell:
 *
 * - Nothing here throws, and nothing is written off a terminal: every write
 *   goes through one guard that requires a TTY and swallows the write's own
 *   failure.
 * - The title is a fixed 80 code points, padded, so a taskbar button does not
 *   jitter; the session's name is what gets cut, never the state word or the
 *   folder's tail.
 * - A notification's route is chosen by what the terminal is (the variables
 *   it sets for itself), never by what it claims: OSC 9 where it is known to
 *   be read, the bell where the terminal has its own idea of attention, OSC
 *   777 elsewhere on a desktop. `AGENT_HARNESS_TUI_NOTIFY` names one outright
 *   (`osc9`, `osc777`, `bell`) or switches it off (`off`, `0`, `false`),
 *   which matters over SSH, where the variables do not survive the hop.
 *   `AGENT_HARNESS_TUI_NO_TITLE=1` silences the title.
 * - Inside tmux an OSC is wrapped in a DCS passthrough; the bell is left to
 *   tmux.
 * - The timer (`AttentionTimer`) is the idle rule: a waiting prompt rings
 *   after six seconds of no keystroke, a finished turn after sixty, and every
 *   keystroke pushes both back.
 */

/** The part of `process.stdout` an escape sequence needs. */
export interface TerminalStdout {
  write(chunk: string): unknown;
  /** Escape bytes written to something that is not a terminal are just bytes in a file. */
  readonly isTTY?: boolean;
}

export interface TerminalDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** Where every sequence is written: `process.stdout` by default. */
  readonly stdout?: TerminalStdout;
  /** `process.platform`, or what a test says it is. */
  readonly platform?: string;
}

interface Wired {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: TerminalStdout | undefined;
  readonly platform: string;
}

const wire = (deps: TerminalDeps): Wired => ({
  env: deps.env ?? process.env,
  stdout: deps.stdout ?? process.stdout,
  platform: deps.platform ?? process.platform,
});

/** The variable that silences the title. */
export const NO_TITLE_VARIABLE = "AGENT_HARNESS_TUI_NO_TITLE";
/** The variable that names the notification route, or switches it off. */
export const NOTIFY_VARIABLE = "AGENT_HARNESS_TUI_NOTIFY";

const ESC = "\u001b";
const BEL = "\u0007";

/** An OSC sequence, BEL-terminated: every terminal here accepts BEL; not all accept ST. */
const osc = (body: string): string => `${ESC}]${body}${BEL}`;

/** The DCS passthrough tmux needs to forward a sequence to the real terminal: every escape inside doubled. */
const tmuxWrap = (sequence: string): string => `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`;

const present = (value: string | undefined): boolean => value !== undefined && value.length > 0;

const forTerminal = (deps: Wired, sequence: string): string => (present(deps.env["TMUX"]) ? tmuxWrap(sequence) : sequence);

/** The single write: a missing stream, one that is not a terminal and one that fails mid-write are all `false`. */
const emit = (deps: Wired, bytes: string): boolean => {
  const { stdout } = deps;
  if (stdout === undefined || stdout.isTTY !== true) return false;
  try {
    stdout.write(bytes);
    return true;
  } catch {
    return false;
  }
};

const titleMuted = (deps: Wired): boolean => (deps.env[NO_TITLE_VARIABLE] ?? "") === "1";

/** C0 and C1 controls: a session's name is model output and can contain anything. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Code points, not UTF-16 units, so a cut never lands inside a surrogate pair. */
const points = (value: string): readonly string[] => Array.from(value);

const cut = (value: string, limit: number): string => {
  const glyphs = points(value);
  return glyphs.length <= limit ? value : glyphs.slice(0, Math.max(0, limit)).join("");
};

/** Every control a space, so an embedded BEL or ESC cannot end the sequence early; the padding is left as it is. */
const safe = (value: string, limit: number): string => cut(value.replace(CONTROLS, " "), limit);

/** One line, for text being composed rather than passed through. */
const plain = (value: string, limit: number): string => cut(safe(value, limit * 4).replace(/\s+/gu, " ").trim(), limit);

/** Shortened from the right, where a sentence keeps its least important words. */
const headEllipsis = (value: string, limit: number): string => (points(value).length <= limit ? value : `${cut(value, Math.max(0, limit - 1))}…`);

/** Shortened from the left: the end of a path is the part that names it. */
const tailEllipsis = (value: string, limit: number): string => {
  const glyphs = points(value);
  return glyphs.length <= limit ? value : `…${glyphs.slice(glyphs.length - Math.max(0, limit - 1)).join("")}`;
};

/** What the window says about the harness. */
export type TerminalActivity = "ready" | "working" | "needs-you";

export interface TitleInput {
  readonly state: TerminalActivity;
  /** The open session's name; absent before there is one, when the folder stands in. */
  readonly title?: string | undefined;
  /** The workspace the title is about. */
  readonly folder: string;
  /** How many sessions wait on a person, when it is more than one. */
  readonly needing?: number | undefined;
}

/** Padded to, and never longer than, this many code points. */
export const TITLE_WIDTH = 80;

/** The folder's share of the width; the rest is the session's. */
const FOLDER_WIDTH = 24;

/** The largest count worth printing; the cap keeps the state word a bounded width. */
const MAX_NEEDING = 99;

const SEPARATOR = " · ";

/** The three states: the rail's glyphs, and a working glyph that does not animate. */
const lead = (state: TerminalActivity, needing: number | undefined): string => {
  switch (state) {
    case "needs-you": {
      const count = typeof needing === "number" && Number.isFinite(needing) ? Math.floor(needing) : 1;
      if (count <= 1) return "⚿ needs you";
      return `⚿ ${count > MAX_NEEDING ? `${MAX_NEEDING}+` : count} need you`;
    }
    case "working":
      return "⠹ working";
    case "ready":
      return "◇ ready";
  }
};

/** Exactly `TITLE_WIDTH` code points, never more and never fewer. */
const pad = (value: string): string => {
  const width = points(value).length;
  return width >= TITLE_WIDTH ? cut(value, TITLE_WIDTH) : value + " ".repeat(TITLE_WIDTH - width);
};

/**
 * The title, at exactly `TITLE_WIDTH` code points: `⚿ needs you · Rework
 * the parser (harness)`; with no session name the folder is the subject.
 */
export const titleFor = (input: TitleInput): string => {
  const head = lead(input.state, input.needing);
  const folder = tailEllipsis(plain(input.folder, FOLDER_WIDTH * 2), FOLDER_WIDTH);
  const name = plain(input.title ?? "", TITLE_WIDTH * 2);
  if (name.length === 0) return pad(folder.length === 0 ? head : `${head}${SEPARATOR}${folder}`);
  const parenthetical = folder.length === 0 ? "" : ` (${folder})`;
  const room = TITLE_WIDTH - points(head).length - SEPARATOR.length - points(parenthetical).length;
  return pad(`${head}${SEPARATOR}${headEllipsis(name, room)}${parenthetical}`);
};

/** Sets the window title with OSC 0 (the icon name too, which a tmux window flag reads); `false` when nothing was written. */
export const setTitle = (title: string, deps: TerminalDeps = {}): boolean => {
  const wired = wire(deps);
  if (titleMuted(wired)) return false;
  return emit(wired, forTerminal(wired, osc(`0;${safe(title, TITLE_WIDTH * 4)}`)));
};

/** Hands the title back by writing an empty one: there is no portable restore, and an unbalanced title stack is worse. */
export const clearTitle = (deps: TerminalDeps = {}): boolean => {
  const wired = wire(deps);
  if (titleMuted(wired)) return false;
  return emit(wired, forTerminal(wired, osc("0;")));
};

/**
 * How this terminal is told something happened: `osc9` (iTerm2's
 * notification, adopted by Ghostty, kitty, WezTerm and Warp), `osc777`
 * (rxvt's `notify`, a Linux desktop's daemon), `bell` (what the terminals
 * with their own idea of attention want), or `none`.
 */
export type NotificationMethod = "osc9" | "osc777" | "bell" | "none";

const FORCED: Readonly<Record<string, NotificationMethod>> = { osc9: "osc9", osc777: "osc777", bell: "bell", off: "none", "0": "none", false: "none" };

const autoMethod = (deps: Wired): NotificationMethod => {
  const program = (deps.env["TERM_PROGRAM"] ?? "").toLowerCase();
  const term = (deps.env["TERM"] ?? "").toLowerCase();
  if (program === "iterm.app" || program === "ghostty" || program === "wezterm" || program === "warpterminal" || program === "warp") return "osc9";
  if (present(deps.env["KITTY_WINDOW_ID"]) || term.includes("kitty")) return "osc9";
  if (present(deps.env["WEZTERM_PANE"])) return "osc9";
  if (program === "apple_terminal" || program === "vscode" || program === "alacritty") return "bell";
  // Alacritty never sets `TERM_PROGRAM`: its own variables and its terminfo name tell it.
  if (present(deps.env["ALACRITTY_WINDOW_ID"]) || present(deps.env["ALACRITTY_SOCKET"]) || term.startsWith("alacritty")) return "bell";
  if (present(deps.env["WT_SESSION"]) || deps.platform === "win32") return "bell";
  return "osc777";
};

/** Which route this terminal gets: `AGENT_HARNESS_TUI_NOTIFY`'s, else the terminal's own by its variables; none off a terminal. */
export const notificationMethod = (deps: TerminalDeps = {}): NotificationMethod => {
  const wired = wire(deps);
  if (wired.stdout === undefined || wired.stdout.isTTY !== true) return "none";
  const forced = FORCED[(wired.env[NOTIFY_VARIABLE] ?? "").trim().toLowerCase()];
  return forced ?? autoMethod(wired);
};

export type AttentionKind = "needs-you" | "finished";

/** What a notification says: why it rang, the session it is about, and one sentence. */
export interface AttentionNotice {
  readonly kind: AttentionKind;
  readonly title: string;
  readonly body: string;
}

/** Long enough for a session's name and a sentence; short enough not to be a payload. */
const NOTIFY_TITLE_LIMIT = 120;
const NOTIFY_BODY_LIMIT = 240;

/**
 * Rings the terminal and says how: OSC 9 carries the body alone (its one
 * field), OSC 777 a title (a semicolon made a comma) and a body, the bell
 * nothing. `none` whenever nothing was written.
 */
export const notify = (notice: AttentionNotice, deps: TerminalDeps = {}): NotificationMethod => {
  const wired = wire(deps);
  const method = notificationMethod(deps);
  if (method === "none") return "none";
  const title = plain(notice.title, NOTIFY_TITLE_LIMIT).replaceAll(";", ",");
  const body = plain(notice.body, NOTIFY_BODY_LIMIT);
  const bytes = method === "bell" ? BEL : forTerminal(wired, method === "osc9" ? osc(`9;${body}`) : osc(`777;notify;${title};${body}`));
  return emit(wired, bytes) ? method : "none";
};

/**
 * The attention seam (docs/specs/tui.md, "Attention"): what the screen asks
 * of the terminal's chrome. The terminal UI's writes the bytes above to its
 * terminal (`terminalChrome`); a test's records what it was asked, so no
 * test ever sets a real title or rings a real bell.
 */
export interface TerminalChrome {
  setTitle(title: string): void;
  clearTitle(): void;
  notify(notice: AttentionNotice): void;
}

/** The chrome of the terminal `deps` names: its stream, its variables, its platform. */
export const terminalChrome = (deps: TerminalDeps = {}): TerminalChrome => ({
  setTitle: (title) => void setTitle(title, deps),
  clearTitle: () => void clearTitle(deps),
  notify: (notice) => void notify(notice, deps),
});

/** A chrome that says nothing: the screen's preset, so nothing is written unless a terminal's chrome is handed in. */
export const quietChrome = (): TerminalChrome => ({ setTitle: () => undefined, clearTitle: () => undefined, notify: () => undefined });

/** A waiting prompt is urgent: six seconds of stillness is enough to believe the person left. */
export const NEEDS_YOU_IDLE_MS = 6_000;

/** A finished turn is not: a minute of stillness means the person really is elsewhere. */
export const FINISHED_IDLE_MS = 60_000;

const IDLE_MS: Readonly<Record<AttentionKind, number>> = { "needs-you": NEEDS_YOU_IDLE_MS, finished: FINISHED_IDLE_MS };

/**
 * The idle rule: ring only at somebody who has stopped typing. Both kinds
 * hang off the last keystroke, so a person typing hears nothing; `arm`
 * counts from that keystroke rather than from now, but never calls back
 * synchronously; firing disarms, so one event is one bell. On the
 * platform's clock, so a test's manual clock drives it.
 */
export class AttentionTimer {
  readonly #clock: Clock;
  readonly #delays: Readonly<Record<AttentionKind, number>>;
  readonly #armed = new Map<AttentionKind, Timer>();
  readonly #fires = new Map<AttentionKind, () => void>();
  #touched: number;

  constructor(clock: Clock, delays: Partial<Record<AttentionKind, number>> = {}) {
    this.#clock = clock;
    this.#delays = { ...IDLE_MS, ...delays };
    this.#touched = this.#now();
  }

  /** A keystroke: pushes everything armed back out to its full delay. */
  touch(): void {
    this.#touched = this.#now();
    for (const kind of [...this.#armed.keys()]) this.#schedule(kind, this.#delays[kind]);
  }

  /** Rings `fire` once the person has been still for this kind's delay; arming twice replaces the first. */
  arm(kind: AttentionKind, fire: () => void): void {
    this.#fires.set(kind, fire);
    this.#schedule(kind, Math.max(0, this.#delays[kind] - (this.#now() - this.#touched)));
  }

  /** The turn moved on, or the person came back: nothing rings. */
  disarm(kind: AttentionKind): void {
    this.#armed.get(kind)?.cancel();
    this.#armed.delete(kind);
    this.#fires.delete(kind);
  }

  /** On the way out: no timer outlives what armed it. */
  disarmAll(): void {
    for (const kind of [...this.#armed.keys()]) this.disarm(kind);
  }

  isArmed(kind: AttentionKind): boolean {
    return this.#armed.has(kind);
  }

  /** How long the person has been still. */
  idleMs(): number {
    return this.#now() - this.#touched;
  }

  #now(): number {
    return this.#clock.now().getTime();
  }

  #schedule(kind: AttentionKind, ms: number): void {
    this.#armed.get(kind)?.cancel();
    this.#armed.set(
      kind,
      this.#clock.setTimeout(() => {
        this.#armed.delete(kind);
        const fire = this.#fires.get(kind);
        this.#fires.delete(kind);
        fire?.();
      }, ms),
    );
  }
}
