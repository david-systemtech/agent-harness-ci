import {
  closeTerminal,
  nextWrite,
  reusableTerminal,
  terminalAnswers,
  uuidv4,
  type Clock,
  type Runtime,
  type TerminalHandle,
  type TerminalOutput,
  type TerminalStreamView,
} from "@agent-harness/client-runtime";
import { TOOL_TERMINAL_KEPT_MS } from "@agent-harness/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import type { TerminalAsk } from "./terminal-panes.js";
import { openStyled } from "./xterm-styles.js";

/**
 * The terminal pane's xterm.js and the terminal it draws (docs/specs/gui.md,
 * "The seven panes and the grid"; #409). The environment owns the terminal;
 * the pane only draws it, so hiding the pane, hiding the column or opening
 * another session leaves it running, and only the pane's close button
 * closes it (`terminals.close`).
 *
 * - **The session's shell**: `terminals.list` first, and the newest terminal
 *   it has running that is not a one-off this window started is drawn,
 *   sized to the pane; with none, `terminals.open` opens one with a minted
 *   id at the pane's size. While the connection cannot open one (the
 *   environment unreachable, or paired without the `terminal` scope) it is
 *   refused at once with the capability's line, nothing asked, and tried
 *   again once the connection can.
 * - **Drawing**: `subscriptions.terminal` hands the retained scrollback as a
 *   reset, which xterm.js draws afresh, then each chunk once, in order.
 *   After a reconnect the runtime resubscribes from its cursor and the
 *   environment replays what was missed, so the screen goes on where it
 *   stopped.
 * - **Keys** typed within one animation frame go in one `terminals.write`,
 *   the next frame's after it has answered, never held past a failure: one
 *   that fails is dropped and said, since keys typed late into whatever runs
 *   then are worse than keys lost. What xterm.js answers a query with is sent
 *   only for output heard live while the pane has the keys, so replayed
 *   scrollback is never answered twice.
 * - **Sizes**: every fit that changes the pane's columns or rows is sent
 *   through `terminals.resize`, as is the pane's size when a terminal is
 *   found at another; one that could not be sent is sent once the
 *   environment can be asked again; one refused (the terminal gone or its
 *   shell exited) is the terminal's end.
 * - **`!`** runs a command in a terminal of its own, shown in the pane in
 *   place of the shell, using `terminals.run` with stdin closed. When it exits its terminal is closed and the
 *   pane keeps what it showed, marked with how it ended, until a key there,
 *   `/terminal` or another `!` takes it away. One the pane goes from while it
 *   runs goes on unseen and is closed when it exits.
 * - **An ending**: a shell that exits is closed, so it is not reopened, and
 *   the pane says how it ended, with a new terminal a button away.
 * - **A tool terminal** (#426), which `tools.run` opened for an install or
 *   an update, is drawn in place of a shell: attached at once at the size
 *   the environment opened it at, never opened, reopened or closed by the
 *   pane on its own. Once its command exits the environment keeps it, and
 *   the pane keeps showing it with how it ended, until the close button
 *   closes it or it is gone from the environment, which the pane is told.
 *   The environment closes it `TOOL_TERMINAL_KEPT_MS` after the exit on its
 *   clock telling no one, since the subscription ended with the exit
 *   (#864): once the environment's clock as this window reckons it
 *   (`environmentNow`) is that long past the exit's time, the pane asks
 *   after it again (`terminals.subscribe`), and is told it is gone when it
 *   is not there; one still held is asked after again a minute later on
 *   that clock.
 */

/** What the pane says about the terminal it draws. */
export interface PaneView {
  /** The `!` command it shows; null for the session's shell. */
  readonly command: string | null;
  /** How the terminal it shows ended (`exit 2`, `closed`), once it has; null while it runs or is being found. */
  readonly ended: string | null;
  /** The pane's one line: why there is no terminal, or how its subscription stands; null for none. */
  readonly line: string | null;
}

/** What a pane draws: a session's shell and `!` commands, or one tool terminal (#426). */
export type PaneSource =
  /** The session's shell, and the one-offs this window started, which the pane never reopens as the shell and adds its `!` commands to. */
  | { readonly kind: "session"; readonly sessionId: string; readonly oneOffs: Set<string> }
  /**
   * A tool terminal `tools.run` opened, by its id, at the size the environment opened it at; `gone` hears that the
   * environment no longer holds it, and `clock`, the window's, wakes the pane to ask once its kept time is up.
   */
  | {
      readonly kind: "tool";
      readonly terminal: { readonly id: string; readonly cols: number; readonly rows: number };
      readonly gone: () => void;
      readonly clock: Clock;
    };

export interface PaneTerminalOptions {
  readonly runtime: Runtime;
  readonly environmentId: string;
  readonly source: PaneSource;
  /** The element xterm.js opens in. */
  readonly host: HTMLElement;
  readonly theme: ITheme;
  readonly onScreen: boolean;
  /** The environment's name now, for the lines said. */
  readonly nameOf: () => string;
  /** The pane's view changed. */
  readonly changed: (view: PaneView) => void;
  /** The phone's one-shot Ctrl modifier changed. */
  readonly controlChanged?: (active: boolean) => void;
  readonly selectionChanged?: (text: string) => void;
}

export interface PaneTerminal {
  /** An ask from the window: the shell, a `!` command, the keys, or the close button. */
  ask(ask: TerminalAsk): void;
  /** Shows the session's shell, or draws the tool terminal, unless an ask already showed something. */
  start(): void;
  theme(theme: ITheme): void;
  /** Whether the pane is on screen: shown, in a column not hidden. It fits, and takes the keys it was asked to, only then. */
  onScreen(onScreen: boolean): void;
  /** Touch keyboard controls, sent through the same write queue as typed keys. */
  control(key: "ctrl" | "escape" | "tab"): void;
  /** Select visible cells between two touch positions, in viewport pixels. */
  selectTouch(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }): void;
  /** The pane goes (hidden for good, another session, the window closing); the terminal it shows runs on. */
  dispose(): void;
}

interface Size {
  readonly cols: number;
  readonly rows: number;
}

/** One terminal the pane draws, from being found or opened until another takes its place. */
interface Drawn {
  readonly answers: ReturnType<typeof terminalAnswers>;
  readonly command: string | null;
  terminalId: string | null;
  handle: TerminalHandle | null;
  /** The size the environment last took for the terminal; one in flight is `sizing`. */
  sized: Size | null;
  sizing: boolean;
  /** The environment refused a size: the terminal is not there or its shell exited, so it is sent none again. */
  unsizable: boolean;
  /** Keys not yet sent, and whether a write or a frame waits to send them. */
  outgoing: string;
  sending: boolean;
  frame: number | null;
  ended: string | null;
  line: string | null;
  /** No terminal can be opened now (the capability is absent): one is looked for again once it can. */
  refused: boolean;
  /** The environment still holds its terminal, so the close button closes it there. */
  held: boolean;
  /** Another took its place, or the pane went. */
  gone: boolean;
  readonly stops: (() => void)[];
}

type Exit = Extract<TerminalOutput, { readonly kind: "exited" }>["exit"];

/** How a terminal that exited on its own ended, as a mark (`exit 2`) or in a sentence (`exited with code 2`); a signal wins over the code. */
const exitWords = (exit: Exit, form: "mark" | "sentence"): string =>
  exit.signal !== null
    ? `${form === "sentence" ? "was " : ""}killed by signal ${String(exit.signal)}`
    : form === "sentence"
      ? `exited with code ${String(exit.exitCode)}`
      : `exit ${String(exit.exitCode)}`;

const endingMark = (exit: Exit): string =>
  exit.cause === "closed" ? "closed" : exit.cause === "deleted" ? "gone with its session" : exit.cause === "failed" ? "could not start" : exitWords(exit, "mark");

const endingSentence = (exit: Exit, name: string): string =>
  exit.cause === "closed"
    ? `The terminal on ${name} was closed.`
    : exit.cause === "deleted"
      ? `The terminal on ${name} went with its session.`
      : exit.cause === "failed"
        ? `The terminal on ${name} could not start its shell.`
        : `The terminal on ${name} ${exitWords(exit, "sentence")}.`;

const sameSize = (a: Size | null, b: Size) => a !== null && a.cols === b.cols && a.rows === b.rows;

/** How long after asking finds a kept tool terminal still held it is asked after again, on the environment's clock: this window's reckoning of that clock is off by the socket's latency, and by any drift since `hello`. */
const KEPT_ASKED_AGAIN_MS = 60_000;

/** The bundled machine face; xterm takes a concrete family and pixel size rather than CSS variables. */
const FACE = '"JetBrains Mono Variable"';
const FONT_FAMILY = `${FACE}, ui-monospace, monospace`;
const fontSize = () => 12 * (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--font-scale")) || 1);

/**
 * The bundled face loading, or null when it is loaded already or the document loads no fonts. xterm.js measures its
 * cells and its glyphs as it opens and not again when a face loads later, so a terminal opened on a fallback face
 * keeps that face's spacing until it is resized (#1864). Settles whether or not the face loads.
 */
const faceLoading = (): Promise<unknown> | null => {
  const fonts = document.fonts as Partial<FontFaceSet> | undefined;
  const face = `${fontSize()}px ${FACE}`;
  if (fonts?.load === undefined || fonts.check?.(face) !== false) return null;
  return fonts.load(face).catch(() => undefined);
};

/** xterm's Ctrl mappings, including keys present on phone numeric keyboards. */
const controlData = (key: string): string => {
  if (key === " ") return "\x00";
  if (key === "8" || key === "?") return "\x7f";
  if (/^[3-7]$/.test(key)) return String.fromCharCode(key.charCodeAt(0) - 24);
  return /^[a-z@[\]\\^_]$/i.test(key) ? String.fromCharCode(key.toUpperCase().charCodeAt(0) & 31) : key;
};

export const createPaneTerminal = (options: PaneTerminalOptions): PaneTerminal => {
  const { runtime, environmentId, source, host, nameOf } = options;
  const term = new Terminal({ theme: options.theme, allowTransparency: true, scrollback: 10000, fontFamily: FONT_FAMILY, fontSize: fontSize(), lineHeight: 1.3 });
  const fit = new FitAddon();
  term.loadAddon(fit);

  let drawn: Drawn | null = null;
  let onScreen = options.onScreen;
  /**
   * xterm.js measures its cells as it opens, so it opens in the pane the first time the pane is on screen, never
   * hidden, and in the bundled face once that has loaded; until then what the terminal prints is taken in all the same.
   */
  let opened = false;
  let opening = false;
  const openOnScreen = () => {
    if (opened || opening || !onScreen) return;
    const loading = faceLoading();
    if (loading === null) return openNow();
    opening = true;
    void loading.then(() => {
      opening = false;
      if (disposed || !onScreen) return;
      openNow();
      fitNow();
      if (wantsKeys) takeKeys();
    });
  };
  const openNow = () => {
    opened = true;
    openStyled(term, host);
  };
  let wantsKeys = false;
  let disposed = false;
  let control = false;
  const setControl = (active: boolean) => {
    control = active;
    options.controlChanged?.(active);
  };
  /** Output is taken into xterm.js one chunk at a time, so what it answers while it parses is known to be to that chunk. */
  let feeding: Promise<void> = Promise.resolve();
  /** Whether what xterm.js sends now may go to the terminal: not while it parses output replayed rather than heard live. */
  let sendsAnswers = true;
  let startupAnswer = false;
  const stops: (() => void)[] = [];

  const tell = () => {
    if (disposed) return;
    options.changed({ command: drawn?.command ?? null, ended: drawn?.ended ?? null, line: drawn?.line ?? null });
  };
  const say = (d: Drawn, line: string | null) => {
    d.line = line;
    if (d === drawn) tell();
  };

  const take = (d: Drawn, data: string, live: boolean, startup = false) => {
    feeding = feeding.then(
      () =>
        new Promise<void>((resolve) => {
          if (disposed || d.gone) return resolve();
          sendsAnswers = live;
          startupAnswer = startup;
          term.write(data, () => {
            sendsAnswers = true;
            startupAnswer = false;
            resolve();
          });
        }),
    );
  };
  const clear = () => {
    feeding = feeding.then(() => {
      if (!disposed) term.reset();
    });
  };

  const pump = (d: Drawn) => {
    if (d.sending || d.gone || d.terminalId === null || d.outgoing.length === 0) return;
    const data = nextWrite(d.outgoing);
    d.outgoing = d.outgoing.slice(data.length);
    d.sending = true;
    void runtime.requests.call(environmentId, "terminals.write", { commandId: uuidv4(), id: d.terminalId, data }).then((answer) => {
      d.sending = false;
      if (d.gone) return;
      const failure = !answer.ok ? answer.error.message : answer.result.receipt.status === "rejected" ? answer.result.receipt.error.message : undefined;
      if (failure !== undefined) {
        // Never held for later: typed late into whatever runs then would be worse than lost.
        d.outgoing = "";
        return say(d, `Not sent to the terminal on ${nameOf()}: ${failure}`);
      }
      frameFor(d);
    });
  };
  /** The keys gathered in this animation frame go in one write once it is drawn. */
  const frameFor = (d: Drawn) => {
    if (d.frame !== null || d.outgoing.length === 0) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = null;
      pump(d);
    });
  };

  /** Sends the pane's size when the environment has another for the terminal; one that could not be sent waits for the connection. */
  const sizeTo = (d: Drawn) => {
    const size = { cols: term.cols, rows: term.rows };
    if (d.terminalId === null || d.sizing || d.gone || d.unsizable || d.ended !== null || sameSize(d.sized, size)) return;
    d.sizing = true;
    void runtime.requests.call(environmentId, "terminals.resize", { commandId: uuidv4(), id: d.terminalId, ...size }).then((answer) => {
      d.sizing = false;
      // An environment that could not be reached is sent it again once it can be.
      if (!answer.ok) return;
      if (answer.result.receipt.status === "rejected") return void (d.unsizable = true);
      d.sized = size;
      sizeTo(d);
    });
  };

  const fitNow = () => {
    if (!onScreen || !opened || disposed) return;
    const scaled = fontSize();
    if (term.options.fontSize !== scaled) term.options.fontSize = scaled;
    const proposed = fit.proposeDimensions();
    if (proposed === undefined || !(proposed.cols > 0 && proposed.rows > 0)) return;
    if (proposed.cols !== term.cols || proposed.rows !== term.rows) term.resize(proposed.cols, proposed.rows);
    if (drawn !== null) sizeTo(drawn);
  };

  const hear = (d: Drawn, output: TerminalOutput) => {
    if (d.gone) return;
    if (output.kind === "reset") {
      clear();
      const startup = d.answers.take("reset", false, host.contains(document.activeElement));
      return take(d, output.data, startup, startup);
    }
    if (output.kind === "output") {
      const answer = d.answers.take("output", output.live, host.contains(document.activeElement));
      return take(d, output.data, output.live, answer);
    }
    const { cause } = output.exit;
    const ended = cause === "exited" || cause === "failed";
    // An exited terminal stays listed until it is closed: closed now, so it is not reopened. A tool terminal the environment keeps.
    if (d.terminalId !== null && ended && source.kind === "session") closeTerminal(runtime, environmentId, d.terminalId, uuidv4);
    d.held = ended && source.kind === "tool";
    d.ended = endingMark(output.exit);
    say(d, d.command === null ? endingSentence(output.exit, nameOf()) : null);
    if (d.held) askAt(d, Date.parse(output.occurredAt) + TOOL_TERMINAL_KEPT_MS);
    else if (source.kind === "tool") source.gone();
  };

  /** Asks after the kept tool terminal `d` draws once the environment's clock, as this window reckons it, reaches `at`. */
  const askAt = (d: Drawn, at: number) => {
    if (source.kind !== "tool") return;
    const timer = source.clock.setTimeout(() => askAfterKept(d), Math.max(0, at - runtime.environmentNow(environmentId).getTime()));
    d.stops.push(() => timer.cancel());
  };

  /** Subscribes the kept tool terminal `d` draws again: not there, it is gone, and the pane is told; still held, it is asked after again a minute later. */
  const askAfterKept = (d: Drawn) => {
    if (d.gone || d.terminalId === null || source.kind !== "tool") return;
    const asked = runtime.subscriptions.terminal(environmentId, d.terminalId, () => undefined);
    const stop = asked.state.subscribe((view) => {
      if (view.status !== "ended") return;
      stop();
      asked.release();
      if (view.exit !== null) return askAt(d, runtime.environmentNow(environmentId).getTime() + KEPT_ASKED_AGAIN_MS);
      d.held = false;
      source.gone();
    });
    d.stops.push(stop, () => asked.release());
  };

  const followState = (d: Drawn, view: TerminalStreamView) => {
    if (d.gone || d.ended !== null) return;
    // Not there any more (closed from elsewhere, gone with a restart): said, with a new terminal a button away.
    if (view.status === "ended" && view.exit === null) {
      d.ended = "gone";
      d.held = false;
      say(d, `The terminal on ${nameOf()} is gone${view.fault === null ? "." : `: ${view.fault}`}`);
      if (source.kind === "tool") source.gone();
      return;
    }
    say(d, view.status === "unreachable" ? `${nameOf()} cannot be reached: the terminal runs on there, and what it prints meanwhile shows once it is back.` : null);
  };

  /** Draws terminal `id`, which the environment has at `has`. */
  const attach = (d: Drawn, id: string, has: Size) => {
    d.terminalId = id;
    d.held = true;
    d.sized = has;
    d.handle = runtime.subscriptions.terminal(environmentId, id, (output) => hear(d, output));
    const handle = d.handle;
    d.stops.push(
      handle.state.subscribe((view) => followState(d, view)),
      // The environment answering again after a blip: a size the pane took meanwhile, which could not be sent, is sent now.
      runtime.projections.environments.subscribe(() => {
        if (runtime.capability(environmentId, "terminals.resize").status !== "absent") sizeTo(d);
      }),
    );
    sizeTo(d);
    frameFor(d);
  };

  /** A new terminal for the pane in place of the one drawn, its terminal not yet known. */
  const begin = (command: string | null): Drawn => {
    setControl(false);
    if (drawn !== null) letGo(drawn);
    const d: Drawn = {
      answers: terminalAnswers(),
      command,
      terminalId: null,
      handle: null,
      sized: null,
      sizing: false,
      unsizable: false,
      outgoing: "",
      sending: false,
      frame: null,
      ended: null,
      line: null,
      refused: false,
      held: false,
      gone: false,
      stops: [],
    };
    drawn = d;
    clear();
    tell();
    return d;
  };

  /** Lets go of `d`: a `!` command still running goes on unseen, and its terminal is closed when it exits. */
  const letGo = (d: Drawn) => {
    d.gone = true;
    if (d.frame !== null) cancelAnimationFrame(d.frame);
    for (const stop of d.stops.splice(0)) stop();
    const { handle } = d;
    if (handle === null) return;
    if (d.command === null || d.ended !== null || d.terminalId === null) return handle.release();
    const id = d.terminalId;
    // Heard until it exits, so its terminal is closed then, or let go once it is gone.
    const unseen = runtime.subscriptions.terminal(environmentId, id, (output) => {
      if (output.kind !== "exited") return;
      if (output.exit.cause === "exited" || output.exit.cause === "failed") closeTerminal(runtime, environmentId, id, uuidv4);
      unseen.release();
    });
    unseen.state.subscribe((view) => view.status === "ended" && view.exit === null && unseen.release());
    handle.release();
  };

  /** Whether a new terminal cannot be opened now, the capability's line said at once when it cannot. */
  const refusal = (d: Drawn, prefix: string, method: "terminals.open" | "terminals.run" = "terminals.open"): boolean => {
    const capability = runtime.capability(environmentId, method);
    if (capability.status !== "absent") return false;
    say(d, `${prefix}: ${capability.message}`);
    return true;
  };

  const failed = (d: Drawn, why: string) => {
    d.ended = "not opened";
    say(d, `No terminal on ${nameOf()}: ${why}`);
  };

  const size = (): Size => ({ cols: term.cols, rows: term.rows });

  /** The session whose shell and `!` commands the pane draws; null for a tool terminal's pane, which opens none. */
  const session = source.kind === "session" ? source : null;

  const findShell = (d: Drawn, reuse = true) => {
    if (d.gone || session === null) return;
    const { sessionId, oneOffs } = session;
    d.refused = refusal(d, "No terminal");
    if (d.refused) {
      // Looked for again once the connection can open one.
      const stop = runtime.projections.environments.subscribe(() => {
        if (d.gone || runtime.capability(environmentId, "terminals.open").status === "absent") return;
        stop();
        findShell(d, reuse);
      });
      d.stops.push(stop);
      return;
    }
    say(d, null);
    void (async () => {
      const listed = await runtime.requests.call(environmentId, "terminals.list", { sessionId });
      if (d.gone) return;
      if (!listed.ok) return failed(d, listed.error.message);
      const running = reuse ? reusableTerminal(listed.result.terminals, oneOffs) : undefined;
      if (running !== undefined) return attach(d, running.id, { cols: running.cols, rows: running.rows });
      const id = uuidv4();
      const asked = size();
      const opened = await runtime.requests.call(environmentId, "terminals.open", { commandId: uuidv4(), id, sessionId, ...asked });
      if (d.gone) {
        // Opened for a pane that went meanwhile: it runs on, and is the one the pane finds next time.
        return;
      }
      if (!opened.ok) return failed(d, opened.error.message);
      if (opened.result.receipt.status === "rejected") return failed(d, opened.result.receipt.error.message);
      d.answers.start();
      attach(d, id, asked);
    })();
  };

  const run = (command: string) => {
    if (session === null) return;
    const { sessionId, oneOffs } = session;
    const d = begin(command);
    if (refusal(d, "Not run", "terminals.run")) {
      d.ended = "not run";
      return tell();
    }
    const id = uuidv4();
    oneOffs.add(id);
    const asked = size();
    void runtime.requests.call(environmentId, "terminals.run", { commandId: uuidv4(), id, sessionId, ...asked, command }).then((opened) => {
      const refused = !opened.ok ? opened.error.message : opened.result.receipt.status === "rejected" ? opened.result.receipt.error.message : undefined;
      // Gone before its receipt came: close the command already started for that pane.
      if (d.gone) return refused === undefined ? closeTerminal(runtime, environmentId, id, uuidv4) : undefined;
      if (refused !== undefined) return failed(d, refused);
      d.outgoing = "";
      d.answers.start();
      attach(d, id, asked);
    });
  };

  const shell = () => findShell(begin(null));

  const takeKeys = () => {
    if (!onScreen || !opened) return void (wantsKeys = true);
    wantsKeys = false;
    term.focus();
  };

  const keys = term.onData((data) => {
    const d = drawn;
    // What xterm.js answers while it parses replayed output, or while the pane does not have the keys, is not sent.
    if (d === null || d.gone || !sendsAnswers || (!startupAnswer && !host.contains(document.activeElement))) return;
    // A key in a `!` command's pane once it has ended takes the pane back to the shell.
    if (d.command !== null && d.ended !== null) return void shell();
    // With no terminal to take them (it ended, or none can be opened now), keys are dropped, never held for a later one.
    if (d.ended !== null || d.refused) return;
    if (d.command !== null) return;
    if (control && !startupAnswer) {
      setControl(false);
      if (data.length === 1) data = controlData(data);
    }
    d.outgoing += data;
    frameFor(d);
  });
  stops.push(() => keys.dispose());
  const selection = term.onSelectionChange(() => options.selectionChanged?.(term.getSelection()));
  stops.push(() => selection.dispose());
  // xterm's virtual viewport handles wheels, but has no swipe scroller.
  // Keep fractional rows across moves; multi-touch belongs to browser zoom.
  let touchY: number | null = null;
  const touchStart = (event: TouchEvent) => {
    touchY = onScreen && event.touches.length === 1 ? event.touches[0]!.clientY : null;
  };
  const touchMove = (event: TouchEvent) => {
    if (!onScreen || event.touches.length !== 1) return void (touchY = null);
    if (touchY === null) return;
    const height = host.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? 0;
    if (height <= 0) return;
    event.preventDefault();
    const rowHeight = height / term.rows;
    const lines = Math.trunc((touchY - event.touches[0]!.clientY) / rowHeight);
    if (lines === 0) return;
    touchY -= lines * rowHeight;
    term.scrollLines(lines);
  };
  const touchEnd = () => { touchY = null; };
  host.addEventListener("touchstart", touchStart, { passive: true });
  host.addEventListener("touchmove", touchMove, { passive: false });
  host.addEventListener("touchend", touchEnd);
  host.addEventListener("touchcancel", touchEnd);
  stops.push(() => {
    host.removeEventListener("touchstart", touchStart);
    host.removeEventListener("touchmove", touchMove);
    host.removeEventListener("touchend", touchEnd);
    host.removeEventListener("touchcancel", touchEnd);
  });
  const observer = new ResizeObserver(() => fitNow());
  observer.observe(host);
  stops.push(() => observer.disconnect());
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", fitNow);
  window.addEventListener("resize", fitNow);
  stops.push(() => {
    viewport?.removeEventListener("resize", fitNow);
    window.removeEventListener("resize", fitNow);
  });
  const rootSize = new MutationObserver(fitNow);
  rootSize.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  stops.push(() => rootSize.disconnect());
  openOnScreen();

  return {
    ask(ask) {
      if (disposed) return;
      switch (ask.kind) {
        case "new":
          findShell(begin(null), false);
          takeKeys();
          return;
        case "shell":
          if (drawn === null || drawn.command !== null || drawn.ended !== null) shell();
          if (ask.focus) takeKeys();
          return;
        case "run":
          return run(ask.command);
        case "keys":
          return takeKeys();
        case "close": {
          const d = drawn;
          if (d === null) return;
          if (d.terminalId !== null && d.held) closeTerminal(runtime, environmentId, d.terminalId, uuidv4);
          // Ended, so letting it go leaves nothing heard: the pane goes with it.
          d.ended = "closed";
          return letGo(d);
        }
      }
    },
    start() {
      if (drawn !== null) return;
      if (source.kind === "session") return shell();
      const { id, cols, rows } = source.terminal;
      attach(begin(null), id, { cols, rows });
    },
    theme(theme) {
      term.options.theme = theme;
      term.options.fontSize = fontSize();
      fitNow();
    },
    onScreen(next) {
      onScreen = next;
      if (!next) return setControl(false);
      openOnScreen();
      fitNow();
      if (wantsKeys) takeKeys();
    },
    control(key) {
      if (disposed || !onScreen || drawn === null || drawn.gone || drawn.ended !== null || drawn.refused || drawn.command !== null) return;
      takeKeys();
      if (key === "ctrl") return setControl(!control);
      setControl(false);
      drawn.outgoing += key === "escape" ? "\x1b" : "\t";
      frameFor(drawn);
    },
    selectTouch(from, to) {
      if (disposed || !onScreen || !opened) return;
      const rect = host.querySelector(".xterm-screen")?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const cell = (point: { readonly x: number; readonly y: number }) => {
        const column = Math.max(0, Math.min(term.cols - 1, Math.floor((point.x - rect.left) * term.cols / rect.width)));
        const row = Math.max(0, Math.min(term.rows - 1, Math.floor((point.y - rect.top) * term.rows / rect.height)));
        return (term.buffer.active.viewportY + row) * term.cols + column;
      };
      const start = Math.min(cell(from), cell(to));
      const end = Math.max(cell(from), cell(to));
      term.select(start % term.cols, Math.floor(start / term.cols), end - start + 1);
    },
    dispose() {
      if (disposed) return;
      if (drawn !== null) letGo(drawn);
      disposed = true;
      for (const stop of stops.splice(0)) stop();
      term.dispose();
    },
  };
};
