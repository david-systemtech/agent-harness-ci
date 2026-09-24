import { Box, Text, render as inkRender, useApp, useInput, useStdout, type Instance, type RenderOptions } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import type { Clock, EnvironmentView, GrantReader, Observable, PairingInput } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { applyAction, actionsFor, listClientSessions, removeEnvironment, revokeClientSession, type ClientSessionRow } from "./commands/environment.js";
import { parseCommand } from "./commands/parse.js";
import { mintPairing, pairingLine, type MintedLines } from "./commands/pair.js";
import { startLocalEnvironment } from "./commands/service.js";
import { createFrameScheduler } from "./frames.js";
import { isAction, moveOf, type InkKey, type Keymap } from "./keys.js";
import type { LocalService } from "./platform/services.js";
import type { RuntimeHost } from "./runtime-host.js";
import { ClientSessionsCard, EnvironmentMenu, EnvironmentsCard, MintedCard } from "./screens/cards.js";
import { Composer, Header, Line, PairingPrompt, RAIL_MIN_COLUMNS, Rail } from "./screens/layout.js";
import { activityLine, currentEnvironment, findEnvironment, localEnvironment, localIsDown, messageOf, offerLine, type Fault } from "./view.js";

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
  readonly keymap: Keymap;
  readonly flags: ScreenFlags;
  /** Lines to show at launch: a keybindings file's problems. */
  readonly notes?: readonly string[];
  /** Faults the runtime could hand no caller, newest last. */
  readonly faults?: Observable<readonly Fault[]>;
  /** A fixed frame size (tests); preset: the terminal's, following resizes. */
  readonly size?: { readonly columns: number; readonly rows: number };
  /** Mints a command id for a direct `admin` command. */
  readonly newCommandId: () => string;
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
  | { readonly kind: "minted"; readonly lines: MintedLines };

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
  const { host, clock, keymap } = props;
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
  const down = started && localIsDown(views, local);

  // `--environment` names the environment the header is about: it becomes the last used once it is known,
  // at launch or when it is paired later; a miss at launch is said once, and the watch goes on.
  const named = useRef<{ readonly found: boolean; readonly missSaid: boolean }>({ found: false, missSaid: false });
  useEffect(() => {
    const wanted = props.flags.environment;
    if (wanted === undefined || named.current.found || !started) return;
    const found = findEnvironment(views, wanted);
    if (found) {
      named.current = { ...named.current, found: true };
      void runtime.connections.setLastUsed(found.environmentId).catch(() => undefined);
    } else if (!named.current.missSaid) {
      named.current = { ...named.current, missSaid: true };
      say(`No environment named ${wanted} is known here; showing ${current?.name ?? "none"}.`);
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
    (screen.grantPresent === true || localView !== undefined || screen.installed);
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
        say(`Creating a pairing code on ${current.name}…`);
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
      case "usage":
        return say(command.line);
      case "unknown":
        return say(`/${command.name} is not a command here yet: /pair and /environment are.`);
      case "text":
        if (command.text !== "") say("There is no session open to send to.");
        return;
    }
  };

  const viewOf = (environmentId: string): EnvironmentView | undefined => views.find((v) => v.environmentId === environmentId);

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
            text: `Remove ${view.name}? Its client session there is revoked and its saved connection forgotten. y/n`,
            yes: () => {
              update({ card: { kind: "environments", cursor: 0 } });
              void removeEnvironment(runtime, view).then(say);
            },
          },
        });
      }
      if (action) void applyAction(runtime, view, action, views).then(say);
      return;
    }
    if (card.kind === "client-sessions") {
      const view = viewOf(card.environmentId);
      const row = card.rows?.[clampCursor(card.cursor, card.rows.length)];
      if (!view || !row) return;
      update({
        question: {
          text: `Revoke ${row.label} on ${view.name}? y/n`,
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
      default:
        return 0;
    }
  };

  useInput((input: string, key: InkKey) => {
    // A key draws what the scheduler holds back, with its own echo.
    scheduler.bypass();
    const is = (action: Parameters<typeof isAction>[1]) => isAction(keymap, action, input, key);
    if (is("app.interruptOrQuit")) {
      if (screen.composer !== "") return update({ composer: "" });
      if (screen.question) return update({ question: undefined });
      if (screen.card.kind !== "none") return update({ card: { kind: "none" } });
      quit.abort();
      return exit();
    }
    if (question && screen.composer === "") {
      if (is("confirm.yes")) {
        update({ question: undefined });
        return question.yes();
      }
      if (is("confirm.no")) {
        update({ question: undefined });
        return question.no?.();
      }
    }
    const card = screen.card;
    if (card.kind === "environments" || card.kind === "menu" || card.kind === "client-sessions") {
      const move = moveOf(keymap, "picker.move", input, key) || moveOf(keymap, "picker.moveVi", input, key);
      if (move !== 0) return update({ card: { ...card, cursor: clampCursor(card.cursor + move, rowsOf(card)) } });
      if (is("picker.choose")) return choose(card);
      if (is("picker.leave")) return update({ card: back(card) });
      return;
    }
    if (card.kind === "minted" && is("picker.leave")) return update({ card: { kind: "none" } });
    if (is("composer.send")) {
      const typed = screen.composer;
      update({ composer: "" });
      return submit(typed);
    }
    if (is("composer.backspace")) return setScreen((s) => ({ ...s, composer: [...s.composer].slice(0, -1).join("") }));
    if (input !== "" && !key.ctrl && !key.meta && !key.escape && !key.tab && !key.return) {
      const text = input.replace(/[\r\n]+/g, " ");
      setScreen((s) => ({ ...s, composer: s.composer + text }));
    }
  });

  const showRail = size.columns >= RAIL_MIN_COLUMNS && views.length > 0;
  const card = screen.card;
  const menuView = card.kind === "menu" || card.kind === "client-sessions" ? viewOf(card.environmentId) : undefined;
  const activity = activityLine(faults, notices);
  const promptLine = question?.text ?? (startingService ? "Starting the environment on this machine: starting…" : undefined);
  const own = menuView ? (runtime.connections.list.read().find((r) => r.environmentId === menuView.environmentId)?.clientSessionId ?? null) : null;

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Header current={current} startingService={startingService} workspace={props.flags.workspace} />
      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        {showRail && <Rail views={views} startingService={startingService} />}
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {card.kind === "environments" && <EnvironmentsCard views={views} cursor={clampCursor(card.cursor, views.length)} />}
          {card.kind === "menu" && menuView && <EnvironmentMenu view={menuView} actions={actionsFor(menuView)} cursor={card.cursor} />}
          {card.kind === "client-sessions" && menuView && (
            <ClientSessionsCard view={menuView} rows={card.rows} own={own} cursor={clampCursor(card.cursor, card.rows?.length ?? 0)} />
          )}
          {card.kind === "minted" && <MintedCard lines={card.lines} />}
          {card.kind === "none" && started && views.length === 0 && <PairingPrompt />}
          {card.kind === "none" && !started && <Text dimColor> Connecting…</Text>}
          {card.kind === "none" && started && views.length > 0 && <Text dimColor> No session is open.</Text>}
        </Box>
      </Box>
      <Line text={screen.line} />
      <Line text={promptLine} color="yellow" />
      <Composer text={screen.composer} />
      <Line text={activity ?? "Ctrl+C quits · /pair · /environment"} dim={activity === undefined} {...(activity !== undefined && { color: "red" })} />
    </Box>
  );
};

const clampCursor = (cursor: number, rows: number): number => (rows <= 0 ? 0 : Math.min(Math.max(cursor, 0), rows - 1));
