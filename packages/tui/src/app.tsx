import { Box, Text, render as inkRender, useApp, useInput, useStdout, type Instance, type RenderOptions } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import type { Clock, EnvironmentView, GrantReader, Observable, PairingInput } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { ANSWERED, BUILD_WORDS, type AnsweredKey } from "./answered.js";
import { applyAction, actionsFor, listClientSessions, removeEnvironment, revokeClientSession, type ClientSessionRow } from "./commands/environment.js";
import { parseCommand } from "./commands/parse.js";
import { mintPairing, pairingLine, type MintedLines } from "./commands/pair.js";
import { startLocalEnvironment } from "./commands/service.js";
import { nextFocus, type Focus } from "./focus.js";
import { createFrameScheduler } from "./frames.js";
import { helpLines } from "./help.js";
import { FIRST_ANYWHERE, direction, dispatch, keysText, type Handler, type InkKey, type Keymap, type LoadedKeymap, type Lookup } from "./keys.js";
import type { LocalService } from "./platform/services.js";
import { inMemoryPresentation, type Presentation } from "./presentation.js";
import { PickerCard, erasedFrom, movedBy, printableText, rowAt, typedInto, type Picker } from "./rail/picker.js";
import { RAIL_WIDTH, RailView } from "./rail/rail.js";
import { useRail } from "./rail/use-rail.js";
import type { RuntimeHost } from "./runtime-host.js";
import { ClientSessionsCard, EnvironmentMenu, EnvironmentsCard, HelpCard, MintedCard } from "./screens/cards.js";
import { Composer, Header, HintLine, Line, PairingPrompt, RAIL_MIN_COLUMNS } from "./screens/layout.js";
import {
  activityLine,
  currentEnvironment,
  findEnvironment,
  isPlaceholder,
  knownEnvironments,
  localEnvironment,
  localIsDown,
  messageOf,
  nameOf,
  offerLine,
  type Fault,
} from "./view.js";

/**
 * The Ink root (docs/specs/tui.md, "Rendering"): Ink 7 on the alternate
 * screen, `exitOnCtrlC` off (Ctrl+C is the `app.interruptOrQuit` action),
 * `incrementalRendering` on, and no synchronized-output escape of its own
 * (Ink 7.1.1 wraps each frame in one on a terminal). What the runtime
 * changes is drawn through the frame scheduler, one frame per 16 ms;
 * keyboard input bypasses it. `interactive` is said outright: Ink 7.1.1
 * guesses it from `stdout.isTTY` and the `CI` variable, and a shell with
 * `CI` set would otherwise get no alternate screen, no incremental
 * rendering and no synchronized output; `runTui` has already refused
 * anything that is not a terminal.
 */

/** Ink's own throttle, set out of the way (one millisecond) so the frame scheduler's 16 ms, which keys bypass, is the one that counts. */
export const INK_MAX_FPS = 1000;

/** How the terminal UI asks Ink to render. */
export const inkOptions = (streams: Pick<RenderOptions, "stdin" | "stdout" | "stderr">): RenderOptions => ({
  ...streams,
  interactive: true,
  alternateScreen: true,
  exitOnCtrlC: false,
  incrementalRendering: true,
  maxFps: INK_MAX_FPS,
});

/** Ink's `render`, or a test's stand-in for it. */
export type InkRender = (element: ReactElement, options: RenderOptions) => Instance;

/** Renders `element` with the terminal UI's options; `render` is Ink's unless a test hands in another. */
export const mountApp = (element: ReactElement, streams: Pick<RenderOptions, "stdin" | "stdout" | "stderr">, render: InkRender = inkRender): Instance =>
  render(element, inkOptions(streams));

/** The flags of `agent-harness tui` the screen reads (the entry point parses them). */
export interface ScreenFlags {
  /** `--environment <name or id>`: the environment the header is about. */
  readonly environment?: string | undefined;
  /** `--session <id>` and `-c`: a session to open, which the transcript ticket does. */
  readonly session?: string | undefined;
  readonly continueLatest?: boolean | undefined;
  /** Where a new session's workspace is: `--cwd`, else the current directory. Shown in the header. */
  readonly workspace: string;
}

export interface AppProps {
  readonly host: RuntimeHost;
  /** The platform's clock: frames and the service wait run on it. */
  readonly clock: Clock;
  readonly services: LocalService;
  /** The local grant reader, to tell a stopped service from none at all. */
  readonly grant: GrantReader | undefined;
  /** The keymap at launch: the defaults with the keybindings file applied. */
  readonly keymap: Keymap;
  /** The keybindings file `/reload` reads again, against the map then in force; none, and `/reload` says so. */
  readonly keybindings?: { readonly path: string; readonly reload: (previous: Keymap) => LoadedKeymap };
  readonly flags: ScreenFlags;
  /** Lines to show at launch: a keybindings file's problems. */
  readonly notes?: readonly string[];
  /** Faults the runtime could hand no caller, newest last. */
  readonly faults?: Observable<readonly Fault[]>;
  /** A fixed frame size (tests); preset: the terminal's, following resizes. */
  readonly size?: { readonly columns: number; readonly rows: number };
  /** Mints a command id for a direct `admin` command. */
  readonly newCommandId: () => string;
  /** The client-local presentation (the rail's folds): the state directory's; preset, held in memory. */
  readonly presentation?: Presentation;
}

type Card =
  | { readonly kind: "none" }
  | { readonly kind: "environments"; readonly cursor: number }
  | { readonly kind: "menu"; readonly environmentId: string; readonly cursor: number }
  | {
      readonly kind: "client-sessions";
      readonly environmentId: string;
      readonly cursor: number;
      readonly rows: readonly ClientSessionRow[] | undefined;
      /** Which listing the card waits for: an earlier one answering late is not drawn. */
      readonly listing: number;
    }
  | { readonly kind: "minted"; readonly lines: MintedLines }
  /** A rail's picker: snooze, tag, group, search, restore, or a step of starting a session. */
  | { readonly kind: "picker"; readonly picker: Picker }
  /** The help overlay: the effective map, scrolled to `top`, over `under`, the card it goes back to when it closes. */
  | { readonly kind: "help"; readonly top: number; readonly under: Card };

interface Question {
  readonly text: string;
  readonly yes: () => void;
  readonly no?: () => void;
}

interface Screen {
  readonly composer: string;
  readonly card: Card;
  readonly question: Question | undefined;
  /** The last command's result: one line. */
  readonly line: string | undefined;
  /** The service-down offer: declined with `n`; `running` while `y`'s start runs, `handed-over` once the runtime has it. */
  readonly offer: "open" | "declined" | "running" | "handed-over";
  /** What the offer needs to know, asked once the local environment is down: undefined until answered. */
  readonly installed: boolean | undefined;
  readonly grantPresent: boolean | undefined;
}

const useObservable = <T,>(observable: Observable<T>): T => useSyncExternalStore(observable.subscribe, observable.read);

const NO_FAULTS: Observable<readonly Fault[]> = { read: () => [], subscribe: () => () => undefined };

export const App = (props: AppProps) => {
  const { host, clock } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const runtime = useObservable(host.current);
  const scheduler = useMemo(() => createFrameScheduler(clock), [clock]);
  useEffect(() => () => scheduler.dispose(), [scheduler]);
  useSyncExternalStore(scheduler.subscribe, scheduler.frame);
  // Aborted when the terminal UI quits or is unmounted: work it started (the service wait) stops with it.
  const quit = useMemo(() => new AbortController(), []);
  useEffect(() => () => quit.abort(), [quit]);

  // What the runtime changes reaches the screen through the scheduler, never at once.
  useEffect(() => {
    const request = () => scheduler.request();
    const stops = [
      runtime.projections.environments.subscribe(request),
      runtime.projections.sessionList.subscribe(request),
      runtime.projections.notices.subscribe(request),
      runtime.local.subscribe(request),
      runtime.preferences.subscribe(request),
      host.started.subscribe(request),
      (props.faults ?? NO_FAULTS).subscribe(request),
    ];
    return () => stops.forEach((stop) => stop());
  }, [runtime, host, scheduler, props.faults]);

  const [terminalSize, setTerminalSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  useEffect(() => {
    if (props.size) return;
    const resized = () => setTerminalSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resized);
    return () => void stdout.off("resize", resized);
  }, [stdout, props.size]);
  const size = props.size ?? terminalSize;

  const startNote =
    props.flags.session !== undefined || props.flags.continueLatest
      ? "Opening a session here arrives with the transcript; --session and -c are kept for it."
      : undefined;
  const [screen, setScreen] = useState<Screen>({
    composer: "",
    card: { kind: "none" },
    question: undefined,
    line: [...(props.notes ?? []), ...(startNote ? [startNote] : [])].join(" ") || undefined,
    offer: "open",
    installed: undefined,
    grantPresent: undefined,
  });
  const update = (change: Partial<Screen>) => setScreen((current) => ({ ...current, ...change }));
  // The keymap in force: the launch map, until `/reload` reads the file again.
  const [keymap, setKeymap] = useState(props.keymap);
  // What has the keys when no card does: the composer, the rail or the transcript (Tab walks them, `nextFocus`).
  const [focus, setFocus] = useState<Focus>("composer");
  const help = useMemo(() => helpLines(keymap, ANSWERED, BUILD_WORDS), [keymap]);
  const say = (line: string) => update({ line });

  // Read at render: a frame the scheduler drew, or a key's, shows the runtime as it is now.
  const views = runtime.projections.environments.read();
  const notices = runtime.projections.notices.read();
  const local = runtime.local.read();
  const preferences = runtime.preferences.read();
  const started = host.started.read();
  const faults = (props.faults ?? NO_FAULTS).read();
  const current = currentEnvironment(views, preferences, props.flags.environment);
  const localView = localEnvironment(views);
  // The placeholder stands for a local environment never seen: it is no reason to offer a start on its own.
  const rememberedLocal = localView !== undefined && !isPlaceholder(localView);
  const known = knownEnvironments(views);
  const down = started && localIsDown(views, local);

  // The stops Tab walks that come and go: the rail, with nothing to list; the delegated strip and the terminal pane are
  // not drawn by this build. Under 100 columns the rail is not drawn beside the pane: with the focus it is drawn in the
  // pane's place, the picker that stands in for it. A rail that goes takes the focus back to the composer.
  const railListed = views.length > 0;
  const railDrawn = size.columns >= RAIL_MIN_COLUMNS && railListed;
  const stops = { sidebar: railListed, delegated: false, terminal: false };
  const focused: Focus = focus === "sidebar" && !railListed ? "composer" : focus;
  useEffect(() => {
    if (focus !== focused) setFocus(focused);
  }, [focus, focused]);

  // `--environment` names the environment the header is about: it becomes the last used once it is known,
  // at launch or when it is paired later; a miss at launch is said once, and the watch goes on.
  const named = useRef<{ readonly found: boolean; readonly missSaid: boolean }>({ found: false, missSaid: false });
  useEffect(() => {
    const wanted = props.flags.environment;
    if (wanted === undefined || named.current.found || !started) return;
    const found = findEnvironment(known, wanted);
    if (found) {
      named.current = { ...named.current, found: true };
      void runtime.connections.setLastUsed(found.environmentId).catch(() => undefined);
    } else if (!named.current.missSaid) {
      named.current = { ...named.current, missSaid: true };
      say(`No environment named ${wanted} is known here; showing ${current ? nameOf(current) : "none"}.`);
    }
  });

  // The offer needs to know whether a service is installed and whether the grant file is there: asked afresh
  // each time the local environment goes down, and after a start that failed.
  const asked = useRef(false);
  const probe = () => {
    // Either answer failing is taken as no: the offer still stands on the other.
    const grantPresent = props.grant?.read().then((g) => g !== undefined) ?? Promise.resolve(false);
    void Promise.all([props.services.installed().catch(() => false), grantPresent.catch(() => false)]).then(([installed, present]) =>
      update({ installed, grantPresent: present }),
    );
  };
  useEffect(() => {
    if (!down || asked.current) return;
    asked.current = true;
    probe();
  });
  // Back up: the next time it goes down is a new outage, offered again (a `n` answered this one) and asked again.
  useEffect(() => {
    if (down) return;
    asked.current = false;
    setScreen((s) =>
      s.offer === "running" || (s.offer !== "declined" && s.installed === undefined && s.grantPresent === undefined)
        ? s
        : { ...s, offer: s.offer === "declined" ? "open" : s.offer, installed: undefined, grantPresent: undefined },
    );
  }, [down]);

  const offerStands =
    down &&
    screen.installed !== undefined &&
    (screen.offer === "open" || screen.offer === "handed-over") &&
    (screen.grantPresent === true || rememberedLocal || screen.installed);
  const startingService = screen.offer === "running";

  const startService = () => {
    const installed = screen.installed ?? true;
    update({ offer: "running", line: undefined });
    const failed = (line: string) => {
      update({ offer: "open", line });
      // What failed may have changed what is installed (an install that went through before its start failed).
      probe();
    };
    void startLocalEnvironment({ host, services: props.services, clock, installed, signal: quit.signal }).then(
      (outcome) => quit.signal.aborted || (outcome.ok ? update({ offer: "handed-over" }) : failed(outcome.message)),
      (error: unknown) => quit.signal.aborted || failed(messageOf(error)),
    );
  };

  const question: Question | undefined =
    screen.question ??
    (offerStands
      ? {
          text: offerLine(screen.installed ?? true),
          yes: startService,
          no: () => update({ offer: "declined", line: `Not started: \`${PRODUCT_NAME} service start\` starts it later.` }),
        }
      : undefined);

  const pair = (input: PairingInput, rePair?: string) => {
    say(`Pairing with ${"link" in input ? input.link : input.address}…`);
    void runtime.connections.add(input, rePair === undefined ? undefined : { rePair }).then(
      (outcome) => {
        if (outcome.status === "re-pair-offered") {
          update({
            line: undefined,
            question: { text: pairingLine(outcome, views), yes: () => pair(input, outcome.environmentId), no: () => say("Not paired again.") },
          });
          return;
        }
        say(pairingLine(outcome, runtime.projections.environments.read()));
      },
      (error: unknown) => say(`Not paired: ${messageOf(error)}`),
    );
  };

  const submit = (typed: string) => {
    const command = parseCommand(typed);
    switch (command.kind) {
      case "pair":
        return pair(command.input);
      case "pair-create": {
        if (!current) return say("There is no environment to create a pairing code on: /pair one first.");
        say(`Creating a pairing code on ${nameOf(current)}…`);
        // A card opened while the code was minted stays: the code then comes on the line, never lost.
        const cardAsked = screen.card;
        void mintPairing(runtime, current, props.newCommandId()).then((outcome) =>
          outcome.ok
            ? setScreen((s) => (s.card === cardAsked ? { ...s, line: undefined, card: { kind: "minted", lines: outcome.lines } } : { ...s, line: outcome.lines.line }))
            : say(outcome.line),
        );
        return;
      }
      case "environment":
        return update({ card: { kind: "environments", cursor: 0 } });
      case "help":
        return update({ card: { kind: "help", top: 0, under: screen.card.kind === "help" ? screen.card.under : screen.card } });
      case "reload": {
        if (!props.keybindings) return say("There is no keybindings file to read here.");
        const loaded = props.keybindings.reload(keymap);
        setKeymap(loaded.keymap);
        const count = loaded.keymap.remapped.size;
        if (loaded.missing === true) return say(`There is no keybindings file at ${props.keybindings.path}; the default keys stand.`);
        return say(
          loaded.problems.length > 0
            ? loaded.problems.join(" ")
            : `Keybindings read again from ${props.keybindings.path}: ${count} ${count === 1 ? "action" : "actions"} remapped.`,
        );
      }
      case "rail":
        return rail.run(command.command);
      case "usage":
        return say(command.line);
      case "unknown":
        return say(`/${command.name} is not a command here yet: /help lists the ones that are.`);
      case "text":
        if (command.text !== "") say("There is no session open to send to.");
        return;
    }
  };

  const viewOf = (environmentId: string): EnvironmentView | undefined => views.find((v) => v.environmentId === environmentId);

  const presentation = useMemo(() => props.presentation ?? inMemoryPresentation(), [props.presentation]);
  const rail = useRail({
    runtime,
    views,
    keymap,
    presentation,
    startingService,
    current,
    workspace: props.flags.workspace,
    say,
    ask: (asked) => update({ question: asked }),
    open: (picker) => update({ card: { kind: "picker", picker } }),
    focus: () => setFocus("sidebar"),
    leave: () => setFocus("composer"),
  });

  // A connection's menu or client sessions whose environment is gone (removed meanwhile) gives way to the list of environments.
  const shownEnvironment = screen.card.kind === "menu" || screen.card.kind === "client-sessions" ? screen.card.environmentId : undefined;
  const shownGone = shownEnvironment !== undefined && !views.some((v) => v.environmentId === shownEnvironment);
  useEffect(() => {
    if (shownGone) setScreen((s) => (s.card.kind === "menu" || s.card.kind === "client-sessions" ? { ...s, card: { kind: "environments", cursor: 0 } } : s));
  }, [shownGone]);

  const listings = useRef(0);
  const openClientSessions = (view: EnvironmentView) => {
    const listing = ++listings.current;
    update({ card: { kind: "client-sessions", environmentId: view.environmentId, cursor: 0, rows: undefined, listing } });
    void listClientSessions(runtime, view).then((outcome) =>
      setScreen((s) =>
        s.card.kind === "client-sessions" && s.card.listing === listing
          ? outcome.ok
            ? { ...s, card: { ...s.card, rows: outcome.rows } }
            : { ...s, card: { kind: "menu", environmentId: view.environmentId, cursor: 0 }, line: outcome.line }
          : s,
      ),
    );
  };

  const choose = (card: Card) => {
    if (card.kind === "picker") {
      const row = rowAt(card.picker);
      if (!row) return;
      if (row.absent !== undefined) return say(`${row.text}: ${row.absent}.`);
      // A step on opens the next picker; a row that is done closes the card.
      const next = row.choose?.();
      return setScreen((s) => (s.card === card ? { ...s, card: next ? { kind: "picker", picker: next } : { kind: "none" } } : s));
    }
    if (card.kind === "environments") {
      const view = views[clampCursor(card.cursor, views.length)];
      if (view) update({ card: { kind: "menu", environmentId: view.environmentId, cursor: 0 } });
      return;
    }
    if (card.kind === "menu") {
      const view = viewOf(card.environmentId);
      if (!view) return update({ card: { kind: "environments", cursor: 0 } });
      const actions = actionsFor(view);
      const action = actions[clampCursor(card.cursor, actions.length)];
      if (action === "sessions") return openClientSessions(view);
      if (action === "remove") {
        return update({
          question: {
            text: `Remove ${nameOf(view)}? Its client session there is revoked and its saved connection forgotten. y/n`,
            yes: () => {
              update({ card: { kind: "environments", cursor: 0 } });
              void removeEnvironment(runtime, view).then(say);
            },
          },
        });
      }
      if (action) void applyAction(runtime, view, action).then(say);
      return;
    }
    if (card.kind === "client-sessions") {
      const view = viewOf(card.environmentId);
      const row = card.rows?.[clampCursor(card.cursor, card.rows.length)];
      if (!view || !row) return;
      update({
        question: {
          text: `Revoke ${row.label} on ${nameOf(view)}? y/n`,
          yes: () => void revokeClientSession(runtime, view, row, props.newCommandId()).then((line) => {
            say(line);
            openClientSessions(view);
          }),
        },
      });
    }
  };

  const back = (card: Card): Card => {
    switch (card.kind) {
      case "menu":
        return { kind: "environments", cursor: Math.max(0, views.findIndex((v) => v.environmentId === card.environmentId)) };
      case "client-sessions":
        return { kind: "menu", environmentId: card.environmentId, cursor: 0 };
      case "help":
        return card.under;
      case "picker":
        // The query first, then a step back, then the card closes.
        if (card.picker.typed && card.picker.query !== "") return { kind: "picker", picker: { ...card.picker, query: "", cursor: 0 } };
        return card.picker.back ? { kind: "picker", picker: card.picker.back } : { kind: "none" };
      default:
        return { kind: "none" };
    }
  };

  const rowsOf = (card: Card): number => {
    switch (card.kind) {
      case "environments":
        return views.length;
      case "menu": {
        const view = viewOf(card.environmentId);
        return view ? actionsFor(view).length : 0;
      }
      case "client-sessions":
        return card.rows?.length ?? 0;
      case "picker":
        return card.picker.rows(card.picker.query).length;
      default:
        return 0;
    }
  };

  // The help overlay's body: the frame less the header, the three lines and the composer under the card, and the card's title and foot.
  const helpHeight = Math.max(1, size.rows - 7);
  const helpMaxTop = Math.max(0, help.length - helpHeight);
  // A taller terminal, or a shorter map after `/reload`, leaves less to scroll: the overlay's place is clamped to it.
  useEffect(() => {
    setScreen((s) => (s.card.kind === "help" && s.card.top > helpMaxTop ? { ...s, card: { ...s.card, top: helpMaxTop } } : s));
  }, [helpMaxTop]);

  useInput((input: string, key: InkKey) => {
    // A key draws what the scheduler holds back, with its own echo.
    scheduler.bypass();
    const card = screen.card;
    const listCard = card.kind === "environments" || card.kind === "menu" || card.kind === "client-sessions" || card.kind === "picker";
    // A list or the help overlay has the keys whatever has the focus; the focus has them back when it closes.
    const cardHasKeys = listCard || card.kind === "help";
    const composerHasKeys = focused === "composer" && !cardHasKeys;
    const scroll = (to: (top: number) => number): false | void =>
      card.kind === "help" ? update({ card: { ...card, top: Math.min(Math.max(to(Math.min(card.top, helpMaxTop)), 0), helpMaxTop) } }) : false;
    const move = (action: "picker.move" | "picker.moveVi") => (name: string) => {
      const step = direction(keymap, action, name);
      if (card.kind === "help") return scroll((top) => top + step);
      if (!listCard) return false;
      if (card.kind === "picker") return update({ card: { kind: "picker", picker: movedBy(card.picker, step) } });
      update({ card: { ...card, cursor: clampCursor(card.cursor + step, rowsOf(card)) } });
    };
    // Every key the screen answers, by action: the key is looked up in the keymap in force, never matched here.
    const handlers: Record<AnsweredKey, Handler> = {
      ...rail.handlers,
      "app.focus.next": () => (card.kind === "none" ? setFocus(nextFocus(focused, stops)) : false),
      "row.leave": () => setFocus("composer"),
      "app.interruptOrQuit": () => {
        // The draft is cleared only where it is being typed: with the rail or the transcript focused it is kept.
        if (screen.composer !== "" && composerHasKeys) return update({ composer: "" });
        if (screen.question) return update({ question: undefined });
        if (card.kind !== "none") return update({ card: card.kind === "help" ? card.under : { kind: "none" } });
        quit.abort();
        exit();
      },
      "app.help": () => {
        if (card.kind === "help") return update({ card: card.under });
        // Artemis's map: from an empty composer; with text there it is a character like any other. With the
        // focus in the rail or the transcript nothing is being typed, so it is the map (Artemis's rail rule).
        if (screen.composer !== "" && composerHasKeys) return false;
        update({ card: { kind: "help", top: 0, under: card } });
      },
      "confirm.yes": () => {
        if (!question) return false;
        update({ question: undefined });
        question.yes();
      },
      "confirm.no": () => {
        if (!question) return false;
        update({ question: undefined });
        question.no?.();
      },
      "picker.move": move("picker.move"),
      "picker.moveVi": move("picker.moveVi"),
      "picker.choose": () => (listCard ? choose(card) : false),
      "picker.leave": () => (card.kind === "none" ? false : update({ card: back(card) })),
      "pager.halfDown": () => scroll((top) => top + Math.max(1, Math.floor(helpHeight / 2))),
      "pager.halfUp": () => scroll((top) => top - Math.max(1, Math.floor(helpHeight / 2))),
      "pager.top": () => scroll(() => 0),
      "pager.bottom": () => scroll(() => helpMaxTop),
      "pager.close": () => (card.kind === "help" ? update({ card: card.under }) : false),
      "composer.send": () => {
        const typed = screen.composer;
        update({ composer: "" });
        submit(typed);
      },
      "composer.backspace": () => setScreen((s) => ({ ...s, composer: [...s.composer].slice(0, -1).join("") })),
    };
    // Where a key is looked up, in order: the quit and the jump to what needs you, which nothing may take; a
    // question just asked (a removal or a revoke the card asks to confirm, a re-pair), which has the keys until it
    // is answered; the open card; unless a list or the help overlay has the keys, what has the focus and then the
    // standing service-down offer; the rest of what is answered anywhere. Neither question is looked up while its
    // letters are being typed into the composer. So a card's Esc or `n` is the card's, never the offer's answer,
    // and never an interrupt.
    const typing = composerHasKeys && screen.composer !== "";
    // A list typed at (a typed picker, the rail's filter) takes text before any key is looked up: its letters are
    // `picker.filter` and the filter's, never a letter-keyed action or a question's answer, while no question was just asked.
    const text = printableText(input, key);
    if (!screen.question) {
      if (card.kind === "picker" && card.picker.typed && (text !== undefined || key.backspace || key.delete)) {
        return setScreen((s) =>
          s.card.kind === "picker" ? { ...s, card: { kind: "picker", picker: text !== undefined ? typedInto(s.card.picker, text) : erasedFrom(s.card.picker) } } : s,
        );
      }
      if (card.kind === "none" && focused === "sidebar" && text !== undefined && rail.type(text)) return;
    }
    const lookups: Lookup[] = [{ context: "anywhere", only: FIRST_ANYWHERE }];
    if (screen.question && !typing) lookups.push("confirm");
    if (card.kind === "help") lookups.push("pager", "picker");
    else if (card.kind !== "none") lookups.push("picker");
    if (!cardHasKeys) {
      lookups.push(focused);
      if (!screen.question && question && !typing) lookups.push("confirm");
    }
    lookups.push({ context: "anywhere", except: FIRST_ANYWHERE });
    if (dispatch(keymap, lookups, handlers, input, key)) return;
    // A key nothing answered is dropped unless the composer has the keys: the rail and the transcript take
    // every key, answered or not, so a letter pressed there is never typed into a draft out of sight.
    if (cardHasKeys || focused !== "composer") return;
    // What is typed is text, not a key: a sigil (`/`) included, whatever the keymap says.
    if (input !== "" && !key.ctrl && !key.meta && !key.escape && !key.tab && !key.return) {
      const text = input.replace(/[\r\n]+/g, " ");
      setScreen((s) => ({ ...s, composer: s.composer + text }));
    }
  });

  const card = screen.card;
  // The help overlay takes the width, as Artemis's did.
  const showRail = railDrawn && card.kind !== "help";
  const cardHasKeys = card.kind === "environments" || card.kind === "menu" || card.kind === "client-sessions" || card.kind === "picker" || card.kind === "help";
  // Under 100 columns the rail, with the focus, is drawn in the pane's place: the picker that stands in for it.
  const railInPane = !railDrawn && railListed && focused === "sidebar" && card.kind === "none";
  // The rows the rail and a picker have: the frame less the header and the four lines under the pane.
  const paneRows = Math.max(1, size.rows - 5);
  const keys = (action: Parameters<typeof keysText>[1]) => keysText(keymap, action);
  const listHint = (verb: string, leave: string) => `${keys("picker.move")} move · ${keys("picker.choose")} ${verb} · ${keys("picker.leave")} ${leave}`;
  const menuView = card.kind === "menu" || card.kind === "client-sessions" ? viewOf(card.environmentId) : undefined;
  const activity = activityLine(faults, notices);
  const promptLine = question?.text ?? (startingService ? "Starting the environment on this machine: starting…" : undefined);
  // The line under the composer says what has the keys, in the keys of the map in force: an open list or the help
  // overlay first, then the rail or the transcript. Either stays in sight beside a notice; the composer's own
  // hint gives way to one.
  const hint =
    card.kind === "help"
      ? `The card has the keys · ${keys("pager.close")} closes it`
      : card.kind === "environments"
        ? `The card has the keys · ${keys("picker.leave")} closes it`
        : card.kind === "menu" || card.kind === "client-sessions"
          ? `The card has the keys · ${keys("picker.leave")} goes back`
          : card.kind === "picker"
            ? `The card has the keys · ${keys("picker.leave")} ${card.picker.back ? "goes back" : "closes it"}`
          : focused === "sidebar"
            ? // What the keys do at the cursor gives way to a notice, as the composer's own hint does.
              `The rail has the keys · ${keys("rail.leave")} ${rail.filter !== null ? "clears the filter" : `back to the composer · ${keys("app.focus.next")} next`}${rail.hint !== undefined && activity === undefined ? ` · ${rail.hint}` : ""}`
            : focused === "transcript"
              ? `The transcript has the keys · ${keys("row.leave")} back to the composer · ${keys("app.focus.next")} next`
              : undefined;
  const composerHint = `${keys("app.interruptOrQuit")} quits · ${keys("app.help")} keys · /pair · /environment`;
  const own = menuView ? (runtime.connections.list.read().find((r) => r.environmentId === menuView.environmentId)?.clientSessionId ?? null) : null;

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Header current={current} startingService={startingService} workspace={props.flags.workspace} />
      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        {showRail && (
          <RailView lines={rail.lines} cursor={rail.cursor} focused={focused === "sidebar" && !cardHasKeys} filter={rail.filter} height={paneRows} width={RAIL_WIDTH} />
        )}
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {card.kind === "environments" && (
            <EnvironmentsCard views={views} cursor={clampCursor(card.cursor, views.length)} hint={listHint("actions", "close")} />
          )}
          {card.kind === "menu" && menuView && (
            <EnvironmentMenu view={menuView} actions={actionsFor(menuView)} cursor={card.cursor} hint={listHint("choose", "back")} />
          )}
          {card.kind === "client-sessions" && menuView && (
            <ClientSessionsCard
              view={menuView}
              rows={card.rows}
              own={own}
              cursor={clampCursor(card.cursor, card.rows?.length ?? 0)}
              hint={listHint("revoke", "back")}
            />
          )}
          {card.kind === "minted" && <MintedCard lines={card.lines} hint={`${keys("picker.leave")} closes`} />}
          {card.kind === "picker" && (
            <PickerCard
              picker={card.picker}
              height={paneRows}
              onChange={scheduler.request}
              hint={`${keys("picker.move")} move · ${keys("picker.choose")} choose · ${keys("picker.leave")} ${card.picker.back ? "back" : "close"}`}
            />
          )}
          {railInPane && (
            <RailView lines={rail.lines} cursor={rail.cursor} focused filter={rail.filter} height={paneRows} title={{ text: "Sessions", hint: `the rail, drawn here under ${RAIL_MIN_COLUMNS} columns` }} />
          )}
          {card.kind === "help" && (
            <HelpCard
              lines={help}
              top={Math.min(card.top, helpMaxTop)}
              height={helpHeight}
              hint={`${keys("picker.move")} ${keys("pager.halfDown")} ${keys("pager.halfUp")} scroll · ${keys("pager.close")} close`}
            />
          )}
          {card.kind === "none" && !railInPane && started && known.length === 0 && <PairingPrompt />}
          {card.kind === "none" && !railInPane && !started && <Text dimColor> Connecting…</Text>}
          {card.kind === "none" && !railInPane && started && known.length > 0 && <Text dimColor> No session is open.</Text>}
        </Box>
      </Box>
      <Line text={screen.line} />
      <Line text={promptLine} color="yellow" />
      <Composer text={screen.composer} focused={focused === "composer" && !cardHasKeys} />
      <HintLine hint={hint} activity={activity} fallback={composerHint} />
    </Box>
  );
};

const clampCursor = (cursor: number, rows: number): number => (rows <= 0 ? 0 : Math.min(Math.max(cursor, 0), rows - 1));
