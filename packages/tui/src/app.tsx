import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Box, Text, render as inkRender, useApp, useInput, usePaste, useStdout, type Instance, type RenderOptions } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import type { Clock, EnvironmentView, GrantReader, Notice, Observable, PairingInput, SessionRow } from "@agent-harness/client-runtime";
import { PRODUCT_NAME, actionById, isCommandId, type AttachmentInput, type KeyActionId, type PromptAnswerInput, type PromptKind } from "@agent-harness/contracts";
import { ANSWERED, BUILD_WORDS, type ScreenKey } from "./answered.js";
import { quietChrome, type TerminalChrome } from "./attention/chrome.js";
import { RECAP_FLASH_MS } from "./attention/policy.js";
import { useAttention } from "./attention/use-attention.js";
import { useAnswers } from "./cards/answers.js";
import { askKey, askRows, decidable, inBulk, parkedSessions, promptKey, ttlWords } from "./cards/asks.js";
import { cardFor, chosen, denied, lineClosed, lineEntered, lineOpened, lineTyped, moved, ticked, type CardState, type CardStep } from "./cards/prompt.js";
import { applyAction, actionsFor, listClientSessions, removeEnvironment, revokeClientSession, type ClientSessionRow } from "./commands/environment.js";
import { parseCommand } from "./commands/parse.js";
import { mintPairing, pairingLine, type MintedLines } from "./commands/pair.js";
import { startLocalEnvironment } from "./commands/service.js";
import { expandHome, readAttachment } from "./composer/attachments.js";
import { copyText, readClipboardImage, readClipboardText, type CopyOutcome } from "./composer/clipboard.js";
import { editInExternalEditor, type ExternalEditResult } from "./composer/external-editor.js";
import { HISTORY_FILE, PromptHistory, type HistoryScope } from "./composer/history.js";
import { Frecency, MENTIONS_FILE } from "./composer/mentions.js";
import { EXAMPLE_SNIPPETS, SNIPPETS_FILE, Snippets, toSnippetName, type SnippetTemplate } from "./composer/snippets.js";
import { composerOf, expandedSnippet, replaced, type CommandRow } from "./composer/state.js";
import { composerNote, highlighted, useComposer, type ComposerClipboard } from "./composer/use-composer.js";
import { nextFocus, stepCursor, type Focus } from "./focus.js";
import { createFrameScheduler } from "./frames.js";
import { helpLines } from "./help.js";
import { FIRST_ANYWHERE, direction, dispatch, eventName, keysText, type Handler, type InkKey, type Keymap, type LoadedKeymap, type Lookup } from "./keys.js";
import type { LocalService } from "./platform/services.js";
import { inMemoryPresentation, type Presentation } from "./presentation.js";
import { PickerCard, erasedFrom, movedBy, printableText, rowAt, typedInto, type Picker } from "./rail/picker.js";
import { RAIL_WIDTH, RailView } from "./rail/rail.js";
import { useRail } from "./rail/use-rail.js";
import type { RuntimeHost } from "./runtime-host.js";
import { AsksCard } from "./screens/asks-card.js";
import { ClientSessionsCard, EnvironmentMenu, EnvironmentsCard, HelpCard, MintedCard } from "./screens/cards.js";
import { ComposerView } from "./screens/composer.js";
import { Header, HintLine, Line, PairingPrompt, RAIL_MIN_COLUMNS } from "./screens/layout.js";
import { SessionsCard, SnippetsCard } from "./screens/lists.js";
import { PromptCard } from "./screens/prompt-card.js";
import { DelegatedStrip, LinesCard, QueuedLine, TranscriptView, maxOffset, offsetShowing } from "./screens/transcript.js";
import { attachmentRefusal, interruptRun, isLive, sendMessage, stopCall } from "./session/send.js";
import { useFollow, useSession, type Opened } from "./session/use-session.js";
import { codeBlocks, exportMarkdown, timelineLine, turnsOf } from "./transcript/export.js";
import { lineText, rowLines, transcriptLines, type Line as TranscriptLine } from "./transcript/lines.js";
import { quietFor } from "./transcript/quiet.js";
import { lastReply, transcriptRows, type Row } from "./transcript/rows.js";
import {
  activityLine,
  clockTime,
  currentEnvironment,
  findEnvironment,
  isPlaceholder,
  knownEnvironments,
  localEnvironment,
  localIsDown,
  messageOf,
  nameOf,
  noticeLine,
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
  /** `--session <id>`: a session to open, on whichever environment holds it. */
  readonly session?: string | undefined;
  /** `-c`: the newest session on the local environment whose workspace is the current directory (`cwd`). */
  readonly continueLatest?: boolean | undefined;
  /** Where a new session's workspace is: `--cwd`, else the current directory. Shown in the header. */
  readonly workspace: string;
}

/** The clipboard the composer and `/copy` use: the machine's, unless a test hands in another. */
export interface TerminalClipboard extends ComposerClipboard {
  copy(text: string): Promise<CopyOutcome>;
}

const SYSTEM_CLIPBOARD: TerminalClipboard = {
  readImage: () => readClipboardImage(),
  readText: () => readClipboardText(),
  copy: (text) => copyText(text),
};

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
  /** Mints a session id for `/new`: a version 4 UUID. */
  readonly newSessionId?: () => string;
  /** The state directory: the prompt history, the snippets and the `@` pick memory live there. None, and they are not kept. */
  readonly stateDir?: string | undefined;
  /** Where `/attach` and `/export` read a relative path from: preset the process's working directory. */
  readonly cwd?: string;
  /** Preset the machine's clipboard. */
  readonly clipboard?: TerminalClipboard;
  /** Ctrl+G's editor; preset `$VISUAL` or `$EDITOR`, with the terminal lent to it. */
  readonly editText?: (text: string) => Promise<ExternalEditResult>;
  /** The terminal's title and bell (the attention seam): preset none, so nothing is written; `runTui` hands in the terminal's. */
  readonly chrome?: TerminalChrome;
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
  | { readonly kind: "help"; readonly top: number; readonly under: Card }
  /** The pager (Ctrl+O): the whole transcript unfolded, from `top` (null: the end), with a search. */
  | { readonly kind: "pager"; readonly top: number | null; readonly query: string; readonly typing: boolean }
  /** `/resume`: the sessions, filtered by what is typed. */
  | { readonly kind: "sessions"; readonly cursor: number; readonly filter: string }
  /** `/snip`: the saved snippets. */
  | { readonly kind: "snippets"; readonly cursor: number }
  /** `/tasks` or `/timeline`: lines about the session; `/notices`: every notice, newest first; scrolled from `top`. */
  | { readonly kind: "lines"; readonly which: "tasks" | "timeline" | "notices"; readonly top: number }
  /** `/asks` and `Ctrl+]`: every environment's parked prompts. */
  | { readonly kind: "asks"; readonly cursor: number };

interface Question {
  readonly text: string;
  readonly yes: () => void;
  readonly no?: () => void;
}

interface Screen {
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

/** The transcript's place: lines scrolled back from the end, the row under its cursor, the rows unfolded with Enter. */
interface View {
  readonly offset: number;
  readonly cursor: string | null;
  readonly unfolded: ReadonlySet<string>;
}

const FRESH_VIEW: View = { offset: 0, cursor: null, unfolded: new Set() };

/** A message sent and not yet in the transcript: drawn dim at its foot until its `message.sent` arrives or the send fails. */
interface Sending {
  readonly id: number;
  readonly text: string;
  readonly messageId: string | undefined;
  /** The messages the session held when it was sent: one of the same text not among them is this one, heard back. */
  readonly before: ReadonlySet<string>;
}

const useObservable = <T,>(observable: Observable<T>): T => useSyncExternalStore(observable.subscribe, observable.read);

/** The transcript's keys the composer lets through. */
const PAGE_KEYS: ReadonlySet<KeyActionId> = new Set<KeyActionId>(["transcript.pageUp", "transcript.pageDown"]);

const NO_FAULTS: Observable<readonly Fault[]> = { read: () => [], subscribe: () => () => undefined };

/** The slash menu's rows: the commands this build answers, from the shared list, then the provider's own. */
const commandRows = (provider: readonly { readonly name: string; readonly description: string }[]): readonly CommandRow[] => {
  const own = [...ANSWERED]
    .filter((id) => isCommandId(id))
    .map((id): CommandRow => {
      const action = actionById(id);
      return { name: id.slice("command.".length), usage: action?.usage ?? `/${id.slice(8)}`, description: action?.description ?? "", provider: false };
    });
  const taken = new Set(own.map((row) => row.name));
  return [...own, ...provider.filter((c) => !taken.has(c.name)).map((c): CommandRow => ({ name: c.name, usage: `/${c.name}`, description: c.description, provider: true }))];
};

export const App = (props: AppProps) => {
  const { host, clock } = props;
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const runtime = useObservable(host.current);
  const scheduler = useMemo(() => createFrameScheduler(clock), [clock]);
  useEffect(() => () => scheduler.dispose(), [scheduler]);
  useSyncExternalStore(scheduler.subscribe, scheduler.frame);
  const request = useCallback(() => scheduler.request(), [scheduler]);
  // Aborted when the terminal UI quits or is unmounted: work it started (the service wait) stops with it.
  const quit = useMemo(() => new AbortController(), []);
  useEffect(() => () => quit.abort(), [quit]);
  const clipboard = props.clipboard ?? SYSTEM_CLIPBOARD;
  const cwd = props.cwd ?? process.cwd();

  // What the runtime changes reaches the screen through the scheduler, never at once.
  useEffect(() => {
    const stops = [
      runtime.projections.environments.subscribe(request),
      runtime.projections.notices.subscribe(request),
      runtime.projections.sessionList.subscribe(request),
      runtime.local.subscribe(request),
      runtime.preferences.subscribe(request),
      host.started.subscribe(request),
      (props.faults ?? NO_FAULTS).subscribe(request),
    ];
    return () => stops.forEach((stop) => stop());
  }, [runtime, host, request, props.faults]);

  const [terminalSize, setTerminalSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  useEffect(() => {
    if (props.size) return;
    const resized = () => setTerminalSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resized);
    return () => void stdout.off("resize", resized);
  }, [stdout, props.size]);
  const size = props.size ?? terminalSize;

  const [screen, setScreen] = useState<Screen>({
    card: { kind: "none" },
    question: undefined,
    line: [...(props.notes ?? [])].join(" ") || undefined,
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
  const keys = (action: KeyActionId) => keysText(keymap, action);

  // The client-local stores in the state directory: the prompt history, the snippets, the `@` pick memory.
  const [stores, setStores] = useState<{ readonly history?: PromptHistory; readonly snippets?: Snippets; readonly mentions?: Frecency }>({});
  useEffect(() => {
    const dir = props.stateDir;
    if (dir === undefined) return;
    let gone = false;
    void Promise.all([PromptHistory.load(join(dir, HISTORY_FILE)), Snippets.load(join(dir, SNIPPETS_FILE)), Frecency.load(join(dir, MENTIONS_FILE))]).then(
      ([history, snippets, mentions]) => gone || setStores({ history, snippets, mentions }),
      (error: unknown) => gone || say(`The history and snippets could not be read: ${messageOf(error)}`),
    );
    return () => {
      gone = true;
    };
  }, [props.stateDir]);

  // Read at render: a frame the scheduler drew, or a key's, shows the runtime as it is now.
  const views = runtime.projections.environments.read();
  const notices = runtime.projections.notices.read();
  const local = runtime.local.read();
  const preferences = runtime.preferences.read();
  const started = host.started.read();
  const faults = (props.faults ?? NO_FAULTS).read();
  const list = runtime.projections.sessionList.read();
  const current = currentEnvironment(views, preferences, props.flags.environment);
  const localView = localEnvironment(views);
  // The placeholder stands for a local environment never seen: it is no reason to offer a start on its own.
  const rememberedLocal = localView !== undefined && !isPlaceholder(localView);
  const known = knownEnvironments(views);
  const down = started && localIsDown(views, local);
  const names = new Map(views.map((view) => [view.environmentId, nameOf(view)]));

  // The session on screen.
  const session = useSession(runtime, clock, request);
  const { opened, projection } = session;
  const [view, setView] = useState<View>(FRESH_VIEW);
  const [viewport, setViewport] = useState(0);
  const [sending, setSending] = useState<readonly Sending[]>([]);
  const sends = useRef(0);
  const open = (next: Opened | null) => {
    session.open(next);
    setView(FRESH_VIEW);
    setSending([]);
    if (next) setFocus("composer");
  };

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

  // `--session <id>` and `-c` open a session once the lists that could hold it are live; a miss is said once.
  const launched = useRef<"waiting" | "done">(props.flags.session !== undefined || props.flags.continueLatest ? "waiting" : "done");
  useEffect(() => {
    if (launched.current === "done" || !started) return;
    const settled = list.environments.length > 0 && list.environments.every((e) => e.freshness === "live" || e.fault !== null);
    const wanted = props.flags.session?.toLowerCase();
    const found =
      wanted !== undefined
        ? list.rows.find((row) => row.summary.id === wanted)
        : list.rows
            .filter((row) => row.environmentId === localView?.environmentId && row.summary.workspace.path === cwd)
            .sort((a, b) => (b.summary.lastActivityAt ?? b.summary.createdAt).localeCompare(a.summary.lastActivityAt ?? a.summary.createdAt))[0];
    if (found) {
      launched.current = "done";
      open({ environmentId: found.environmentId, sessionId: found.summary.id });
    } else if (settled) {
      launched.current = "done";
      say(wanted !== undefined ? `No session ${props.flags.session} is on any environment here.` : `No session on this machine has ${cwd} as its workspace.`);
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

  // The transcript as rows and lines at the width it has.
  const railWidth = railDrawn && screen.card.kind !== "help" ? RAIL_WIDTH : 0;
  const mainWidth = Math.max(20, size.columns - railWidth);
  const now = clock.now().getTime();
  // A parked prompt is the card under the transcript until it is answered, then a row where it was asked (permissions spec,
  // "Placement"); the pager, the whole transcript unfolded, draws it in place.
  const allRows = useMemo(() => (projection ? transcriptRows(projection) : []), [projection]);
  const rows = useMemo(() => allRows.filter((row) => !(row.kind === "prompt" && row.entry.state === "parked")), [allRows]);
  const transcriptFocused = focused === "transcript" && screen.card.kind === "none";
  const lineContext = {
    width: mainWidth - (transcriptFocused ? 1 : 0),
    quietMs: (id: string) => quietFor(session.quiet, id, now),
    stopKey: keys("row.stop"),
    planDeltas: session.planDeltas,
  };
  const lines: TranscriptLine[] = [
    ...transcriptLines(rows, { ...lineContext, expanded: false }, view.unfolded),
    // A message sent and not yet heard back: dim at the foot, until its `message.sent` arrives.
    ...sending
      .filter(
        (s) =>
          !projection?.items.some(
            (entry) => entry.kind === "user-message" && (entry.messageId === s.messageId || (s.messageId === undefined && entry.text === s.text && !s.before.has(entry.messageId))),
          ),
      )
      .flatMap((s): TranscriptLine[] => [
        { row: `sending:${s.id}`, spans: [] },
        { row: `sending:${s.id}`, spans: [{ text: "▌ ", dim: true }, { text: s.text.split("\n")[0] ?? "", dim: true }, { text: " · sending", dim: true }] },
      ]),
  ];
  const rowIds = rows.map((row) => row.id);
  const cursorRow = rows.find((row) => row.id === view.cursor);
  const height = Math.max(1, viewport - (view.offset > 0 ? 1 : 0));
  const half = Math.max(1, Math.floor(height / 2));
  const scrollTo = (offset: number) => setView((v) => ({ ...v, offset: Math.min(Math.max(0, offset), maxOffset(lines, height)) }));

  const liveRun = session.liveRunId;
  const live = isLive(session.runState) || liveRun !== undefined;
  const tasks = useMemo(() => {
    if (!projection || liveRun === undefined) return [];
    const ledger = projection.items.findLast((entry) => entry.kind === "tasks" && entry.runId === liveRun);
    return ledger?.kind === "tasks" ? ledger.tasks.filter((task) => task.status === "running" || task.status === "pending" || task.status === "paused") : [];
  }, [projection, liveRun]);

  // The parked prompts (docs/specs/tui.md, "Cards"): every environment's, from `projections.runs` (the asks card), and the open
  // session's own, whose oldest is its card. One this terminal has answered leaves both at once (`useAnswers`).
  const runsView = runtime.projections.runs.read();
  const heldPrompts = projection?.parkedPrompts;
  const parkedKeys = useMemo(
    () =>
      new Set([
        ...runsView.parkedAsks.map(askKey),
        ...(opened && heldPrompts ? heldPrompts.map((parked) => promptKey(opened.environmentId, opened.sessionId, parked.promptId)) : []),
      ]),
    [runsView.parkedAsks, opened, heldPrompts],
  );
  const answers = useAnswers(runtime, parkedKeys, say);
  const asks = runsView.parkedAsks.filter((ask) => !answers.sent.has(askKey(ask)));
  const waitingHere = opened && projection ? projection.parkedPrompts.filter((parked) => !answers.sent.has(promptKey(opened.environmentId, opened.sessionId, parked.promptId))) : [];
  const shownPrompt = waitingHere[0];
  const [promptCard, setPromptCard] = useState<CardState | undefined>(undefined);
  // The card's own state belongs to the prompt it was made for: another prompt starts afresh, the cursor on Deny.
  const promptState = shownPrompt === undefined ? undefined : promptCard?.promptId === shownPrompt.promptId ? promptCard : cardFor(shownPrompt.promptId);
  const promptShown = screen.card.kind === "none" && shownPrompt !== undefined && promptState !== undefined;
  const answerShown = (answer: PromptAnswerInput) => {
    if (!opened || !shownPrompt) return;
    answers.answer({ environmentId: opened.environmentId, sessionId: opened.sessionId, promptId: shownPrompt.promptId }, answer);
  };
  const step = (next: CardStep) => {
    if (next.kind === "state") return setPromptCard(next.state);
    if (next.kind === "say") return say(next.line);
    answerShown(next.answer);
  };

  // Attention: the title, the bell and the away summary, from the runtime's attention events.
  const chrome = useMemo(() => props.chrome ?? quietChrome(), [props.chrome]);
  const attention = useAttention({
    runtime,
    clock,
    chrome,
    request,
    opened,
    title: projection?.summary?.title,
    folder: projection?.summary?.workspace.path ?? props.flags.workspace,
    live,
  });
  /** A line that goes by itself after `ms`, unless another has replaced it. */
  const flash = (line: string, ms: number) => {
    say(line);
    clock.setTimeout(() => setScreen((s) => (s.line === line ? { ...s, line: undefined } : s)), ms);
  };

  // `Ctrl+]`: the asks card when more than one session is parked; else the next session that needs you, parked first.
  const attentionNext = () => {
    if (parkedSessions(asks).length > 1) return update({ card: { kind: "asks", cursor: 0 }, question: undefined });
    const queue = attention.needing();
    if (queue.length === 0) return say("Nothing needs you.");
    const here = opened ? queue.findIndex((s) => s.environmentId === opened.environmentId && s.sessionId.toLowerCase() === opened.sessionId.toLowerCase()) : -1;
    const next = queue[(here + 1) % queue.length];
    if (next === undefined || (here !== -1 && queue.length === 1)) return say("Nothing else needs you.");
    update({ card: { kind: "none" }, question: undefined });
    open(next);
  };

  // The composer.
  const files = useMemo(() => (opened ? runtime.requests.cached(opened.environmentId, "files.list", { sessionId: opened.sessionId }) : undefined), [runtime, opened]);
  const paths = files?.read().result?.files ?? null;
  const scopes = useMemo((): readonly { readonly name: string; readonly scope: HistoryScope }[] => {
    const all = { name: "everywhere", scope: { kind: "all" } as const };
    if (!opened) return [all];
    const workspace = projection?.summary?.workspace.path;
    return [
      { name: "this session", scope: { kind: "session", sessionId: opened.sessionId } },
      ...(workspace !== undefined ? [{ name: "this workspace", scope: { kind: "folder", cwd: workspace } as const }] : []),
      all,
    ];
  }, [opened, projection?.summary?.workspace.path]);
  // The permission card has the keys as any card does: the composer waits under it.
  const cardOpen = screen.card.kind !== "none" || promptShown;
  const composer = useComposer({
    keymap,
    sources: {
      commands: commandRows(session.providerCommands),
      paths,
      ...(stores.mentions && { frecency: stores.mentions }),
      snippets: stores.snippets?.list() ?? [],
    },
    history: stores.history,
    scopes,
    clipboard,
    editText: async (text) => {
      const edit = props.editText ?? ((initial: string) => runEditor(suspendTerminal, initial));
      const result = await edit(text).catch((error: unknown): ExternalEditResult => ({ ok: false, reason: messageOf(error) }));
      if (result.ok) return result.text;
      say(`Could not edit the text: ${result.reason}`);
      return undefined;
    },
    say,
    submit: (raw, message) => submit(raw, message),
    picked: (path) => {
      stores.mentions?.record(path);
      void stores.mentions?.save().catch(() => undefined);
    },
    active: focused === "composer" && !cardOpen,
  });
  // The workspace is listed once the text names a file with `@`, and kept for five minutes by the request cache.
  useFollow(composer.text.includes("@") ? files : undefined, request);

  // The draft is the session's field (session-state spec): what is typed is saved through the runtime, which waits a
  // second after the last key; a session opened takes its draft; a draft another client saved replaces this one's only
  // while nothing has been typed over what this client last held, so a keystroke is never lost to a late echo.
  const synced = useRef<{ readonly key: string; readonly text: string } | undefined>(undefined);
  const openKey = opened ? `${opened.environmentId} ${opened.sessionId}` : undefined;
  // Switching sessions starts the next one's text from nothing (its own comes when it is known); what the last one held is already on its way.
  const shownKey = useRef(openKey);
  useEffect(() => {
    if (shownKey.current === openKey) return;
    shownKey.current = openKey;
    composer.set(composerOf(""));
  });
  useEffect(() => {
    if (!opened || openKey === undefined) {
      synced.current = undefined;
      return;
    }
    const held = projection?.summary ? (projection.draft ?? "") : undefined;
    const text = composer.current();
    if (synced.current?.key !== openKey) {
      // A session just opened: what it holds, once it is known; what was typed before that is kept, and saved over it.
      if (held === undefined) return;
      synced.current = { key: openKey, text: held };
      if (text.length === 0 && held.length > 0) composer.set(composerOf(held));
      return;
    }
    if (held !== undefined && held !== synced.current.text && text === synced.current.text) {
      synced.current = { key: openKey, text: held };
      composer.set(composerOf(held));
      return;
    }
    // A command for the terminal being typed is not the session's draft: it is sent nowhere, and saving it would only be undone.
    if (text !== synced.current.text && !(text.startsWith("/") && parseCommand(text).kind !== "text")) {
      synced.current = { key: openKey, text };
      runtime.drafts.set(opened.environmentId, opened.sessionId, text.length > 0 ? text : null);
    }
  });

  const sendText = (message: { readonly text: string; readonly attachments: readonly AttachmentInput[] }): boolean => {
    if (!opened) {
      say("There is no session open to send to: /resume opens one, /new starts one.");
      return false;
    }
    if (session.lock.locked) {
      say(`Not sent: ${session.lock.reason}`);
      return false;
    }
    const refused = attachmentRefusal(message, session.provider);
    if (refused !== undefined) {
      say(refused);
      return false;
    }
    const id = ++sends.current;
    const { environmentId, sessionId } = opened;
    const before = new Set(projection?.items.flatMap((entry) => (entry.kind === "user-message" ? [entry.messageId] : [])) ?? []);
    setSending((s) => [...s, { id, text: message.text, messageId: undefined, before }]);
    stores.history?.append({ text: message.text, cwd: projection?.summary?.workspace.path ?? props.flags.workspace, sessionId });
    setView((v) => ({ ...v, offset: 0 }));
    void sendMessage(runtime, environmentId, sessionId, message, live).then((outcome) => {
      if (!outcome.ok) {
        setSending((s) => s.filter((one) => one.id !== id));
        say(outcome.line);
        // What was not sent comes back into an empty box, so it is not lost.
        if (composer.current().length === 0) composer.set(composerOf(message.text));
        return;
      }
      setSending((s) => s.map((one) => (one.id === id ? { ...one, messageId: outcome.messageId } : one)));
      clock.setTimeout(() => setSending((s) => s.filter((one) => one.id !== id)), 5000);
    });
    return true;
  };

  const interrupt = (): boolean => {
    if (!opened || liveRun === undefined) return false;
    void interruptRun(runtime, opened.environmentId, liveRun).then((line) => line && say(line));
    return true;
  };

  // `/new`: a session on the open one's environment, in its workspace, on its account and model (Artemis's "on the same
  // account"); with none open, on the header's environment in the `--cwd` directory. It opens once the environment has it,
  // so its stream is never asked for before it exists.
  const newSession = () => {
    const environment = opened ? views.find((v) => v.environmentId === opened.environmentId) : current;
    if (!environment || isPlaceholder(environment)) return say("There is no environment to start a session on: /pair one first.");
    const sessionId = props.newSessionId?.() ?? crypto.randomUUID();
    const summary = projection?.summary;
    const workspace = summary?.workspace ?? { kind: "directory" as const, path: props.flags.workspace };
    say(`Starting a session on ${nameOf(environment)} in ${workspace.path}…`);
    void runtime.commands
      .dispatch(environment.environmentId, "sessions.create", {
        id: sessionId,
        workspace,
        ...(summary?.accountId && { account: summary.accountId }),
        ...(summary?.model && { model: summary.model }),
      })
      .then((answer) => {
        if (!answer.ok) return say(`No session was started: ${answer.error.message}`);
        open({ environmentId: environment.environmentId, sessionId });
        say(`A new session on ${nameOf(environment)} in ${workspace.path}.`);
      });
  };

  const attach = (path: string) => {
    void readAttachment(path, cwd).then((read) => {
      if (!read.ok) return say(`Not attached: ${read.reason}`);
      // What the session's provider cannot take is refused now, not at the send.
      const refused = attachmentRefusal({ text: "", attachments: [read.attachment] }, session.provider);
      if (refused !== undefined) return say(refused.replace("nothing was sent", `${read.attachment.name} was not attached`));
      composer.attach(read.attachment);
      say(`Attached ${read.attachment.name}; it goes with the next message.`);
    });
  };

  const copy = (block: number | null) => {
    const reply = projection ? lastReply(projection) : undefined;
    if (!reply) return say("There is no reply to copy yet.");
    const text = block === null ? reply.text : codeBlocks(reply.text)[block - 1];
    if (text === undefined) return say(`The last reply has no code block ${block}.`);
    void clipboard.copy(text).then(
      (outcome) => say(outcome === "none" ? "Nothing here can reach a clipboard." : `Copied ${block === null ? "the last reply" : `code block ${block}`}.`),
      (error: unknown) => say(`Not copied: ${messageOf(error)}`),
    );
  };

  const exportTo = (file: string | null) => {
    if (!projection || !opened) return say("There is no session open to export.");
    const name = file ?? `${opened.sessionId.slice(0, 8)}.md`;
    const path = resolve(cwd, expandHome(name, homedir()));
    const text = exportMarkdown(projection, { environment: names.get(opened.environmentId) ?? "", at: clock.now() });
    void writeFile(path, text, "utf8").then(
      () => say(`Wrote the conversation to ${path}.`),
      (error: unknown) => say(`Not written: ${messageOf(error)}`),
    );
  };

  const snippet = (name: string, words: readonly string[]): boolean => {
    const found = stores.snippets?.get(name);
    if (!found) {
      say(`No snippet called ${name}. /snip lists them; /snip save ${name} <text> writes one.`);
      return false;
    }
    composer.set(expandedSnippet(composer.state, found.body, words));
    return false;
  };

  /** The composer's Enter: a command the terminal answers, or a message for the agent. True when the box empties. */
  const submit = (raw: string, message: { readonly text: string; readonly attachments: readonly AttachmentInput[] }): boolean => {
    const command = parseCommand(raw);
    switch (command.kind) {
      case "pair":
        pair(command.input);
        return true;
      case "pair-create": {
        if (!current) {
          say("There is no environment to create a pairing code on: /pair one first.");
          return true;
        }
        say(`Creating a pairing code on ${nameOf(current)}…`);
        // A card opened while the code was minted stays: the code then comes on the line, never lost.
        const cardAsked = screen.card;
        void mintPairing(runtime, current, props.newCommandId()).then((outcome) =>
          outcome.ok
            ? setScreen((s) => (s.card === cardAsked ? { ...s, line: undefined, card: { kind: "minted", lines: outcome.lines } } : { ...s, line: outcome.lines.line }))
            : say(outcome.line),
        );
        return true;
      }
      case "environment":
        update({ card: { kind: "environments", cursor: 0 } });
        return true;
      case "help":
        update({ card: { kind: "help", top: 0, under: screen.card.kind === "help" ? screen.card.under : screen.card } });
        return true;
      case "reload": {
        if (!props.keybindings) {
          say("There is no keybindings file to read here.");
          return true;
        }
        const loaded = props.keybindings.reload(keymap);
        setKeymap(loaded.keymap);
        const count = loaded.keymap.remapped.size;
        if (loaded.missing === true) say(`There is no keybindings file at ${props.keybindings.path}; the default keys stand.`);
        else
          say(
            loaded.problems.length > 0
              ? loaded.problems.join(" ")
              : `Keybindings read again from ${props.keybindings.path}: ${count} ${count === 1 ? "action" : "actions"} remapped.`,
          );
        return true;
      }
      case "rail":
        rail.run(command.command);
        return true;
      case "resume":
        update({ card: { kind: "sessions", cursor: 0, filter: "" } });
        return true;
      case "new":
        newSession();
        return true;
      case "attach":
        attach(command.path);
        return true;
      case "snip-list":
        if ((stores.snippets?.list().length ?? 0) === 0) say("No snippets yet: /snip save <name> <text>, or /snip --examples.");
        else update({ card: { kind: "snippets", cursor: 0 } });
        return true;
      case "snip":
        return snippet(command.name, command.words);
      case "snip-save": {
        const name = toSnippetName(command.name);
        if (name === null || !stores.snippets) {
          say(name === null ? `"${command.name}" leaves nothing that can be a snippet name; letters, digits and dashes survive.` : "Snippets are not kept here.");
          return true;
        }
        const existed = stores.snippets.get(name) !== undefined;
        stores.snippets.set(name, command.body);
        say(`${existed ? "Replaced" : "Saved"} ;;${name}.`);
        return true;
      }
      case "snip-remove": {
        const name = toSnippetName(command.name);
        say(name !== null && stores.snippets?.remove(name) ? `Removed ;;${name}.` : `No snippet called ${command.name}.`);
        return true;
      }
      case "snip-examples":
        for (const example of EXAMPLE_SNIPPETS) stores.snippets?.set(example.name, example.body);
        say(stores.snippets ? `${EXAMPLE_SNIPPETS.length} examples saved: /snip lists them.` : "Snippets are not kept here.");
        return true;
      case "tasks":
        if (!projection) say("There is no session open.");
        else update({ card: { kind: "lines", which: "tasks", top: 0 } });
        return true;
      case "timeline":
        if (!projection) say("There is no session open.");
        else update({ card: { kind: "lines", which: "timeline", top: 0 } });
        return true;
      case "copy":
        copy(command.block);
        return true;
      case "asks":
        if (asks.length === 0) say("Nothing needs you.");
        else update({ card: { kind: "asks", cursor: 0 } });
        return true;
      case "notices":
        update({ card: { kind: "lines", which: "notices", top: 0 } });
        return true;
      case "export":
        exportTo(command.file);
        return true;
      case "quit":
        quitNow();
        return true;
      case "not-here":
      case "usage":
        say(command.line);
        return true;
      case "text":
        if (command.text.startsWith("!")) {
          say("`!` runs a command in a terminal on the environment, which this build of the terminal UI does not do yet.");
          return false;
        }
        return sendText(message);
    }
  };

  const quitNow = () => {
    runtime.drafts.flush();
    quit.abort();
    exit();
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
    // The slash forms act on the open session first.
    inHand: opened ?? undefined,
    ...(props.newSessionId && { newId: props.newSessionId }),
    say,
    ask: (asked) => update({ question: asked }),
    asked: screen.question !== undefined,
    open: (picker) => update({ card: { kind: "picker", picker } }),
    openSession: (target) => open(target),
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
  const openClientSessions = (environment: EnvironmentView) => {
    const listing = ++listings.current;
    update({ card: { kind: "client-sessions", environmentId: environment.environmentId, cursor: 0, rows: undefined, listing } });
    void listClientSessions(runtime, environment).then((outcome) =>
      setScreen((s) =>
        s.card.kind === "client-sessions" && s.card.listing === listing
          ? outcome.ok
            ? { ...s, card: { ...s.card, rows: outcome.rows } }
            : { ...s, card: { kind: "menu", environmentId: environment.environmentId, cursor: 0 }, line: outcome.line }
          : s,
      ),
    );
  };

  // `/resume`'s rows: every session on a visible shelf, in the sidebar's order, filtered by title.
  const sessionRows = (filter: string): readonly SessionRow[] => {
    const all = [...list.pinned, ...list.active, ...list.snoozed, ...list.settled];
    const needle = filter.trim().toLowerCase();
    return needle.length === 0 ? all : all.filter((row) => row.summary.title.toLowerCase().includes(needle));
  };
  const snippetRows = (): readonly SnippetTemplate[] => stores.snippets?.list() ?? [];

  const choose = (card: Card) => {
    if (card.kind === "picker") {
      const row = rowAt(card.picker);
      if (!row) return;
      if (row.absent !== undefined) return say(`${row.text}: ${row.absent}.`);
      // A step on opens the next picker, which goes back to this one as it stands, the choice highlighted; a row
      // that is done closes the card.
      const next = row.choose?.();
      const stepped = next && next.back !== undefined ? { ...next, back: card.picker } : next;
      return setScreen((s) => (s.card === card ? { ...s, card: stepped ? { kind: "picker", picker: stepped } : { kind: "none" } } : s));
    }
    if (card.kind === "environments") {
      const chosen = views[clampCursor(card.cursor, views.length)];
      if (chosen) update({ card: { kind: "menu", environmentId: chosen.environmentId, cursor: 0 } });
      return;
    }
    if (card.kind === "menu") {
      const environment = viewOf(card.environmentId);
      if (!environment) return update({ card: { kind: "environments", cursor: 0 } });
      const actions = actionsFor(environment);
      const action = actions[clampCursor(card.cursor, actions.length)];
      if (action === "sessions") return openClientSessions(environment);
      if (action === "remove") {
        return update({
          question: {
            text: `Remove ${nameOf(environment)}? Its client session there is revoked and its saved connection forgotten. y/n`,
            yes: () => {
              update({ card: { kind: "environments", cursor: 0 } });
              void removeEnvironment(runtime, environment).then(say);
            },
          },
        });
      }
      if (action) void applyAction(runtime, environment, action).then(say);
      return;
    }
    if (card.kind === "client-sessions") {
      const environment = viewOf(card.environmentId);
      const row = card.rows?.[clampCursor(card.cursor, card.rows.length)];
      if (!environment || !row) return;
      update({
        question: {
          text: `Revoke ${row.label} on ${nameOf(environment)}? y/n`,
          yes: () =>
            void revokeClientSession(runtime, environment, row, props.newCommandId()).then((line) => {
              say(line);
              openClientSessions(environment);
            }),
        },
      });
      return;
    }
    if (card.kind === "sessions") {
      const found = sessionRows(card.filter);
      const row = found[clampCursor(card.cursor, found.length)];
      if (!row) return;
      update({ card: { kind: "none" } });
      open({ environmentId: row.environmentId, sessionId: row.summary.id });
      return;
    }
    if (card.kind === "snippets") {
      const row = snippetRows()[clampCursor(card.cursor, snippetRows().length)];
      if (!row) return;
      update({ card: { kind: "none" } });
      composer.set(expandedSnippet(composer.state, row.body, []));
      setFocus("composer");
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
        const environment = viewOf(card.environmentId);
        return environment ? actionsFor(environment).length : 0;
      }
      case "client-sessions":
        return card.rows?.length ?? 0;
      case "sessions":
        return sessionRows(card.filter).length;
      case "snippets":
        return snippetRows().length;
      case "picker":
        return card.picker.rows(card.picker.query).length;
      default:
        return 0;
    }
  };

  // The help overlay's body, and the pager's: the frame less the header, the three lines and the composer under the card,
  // and the card's title and foot.
  const helpHeight = Math.max(1, size.rows - 7);
  const helpMaxTop = Math.max(0, help.length - helpHeight);
  // A taller terminal, or a shorter map after `/reload`, leaves less to scroll: the overlay's place is clamped to it.
  useEffect(() => {
    setScreen((s) => (s.card.kind === "help" && s.card.top > helpMaxTop ? { ...s, card: { ...s.card, top: helpMaxTop } } : s));
  }, [helpMaxTop]);

  // The pager's lines: every row unfolded; `/tasks` and `/timeline` as lines too.
  const card = screen.card;
  const pagerLines = card.kind === "pager" ? transcriptLines(allRows, { ...lineContext, width: mainWidth, expanded: true }) : [];
  const cardLines: TranscriptLine[] =
    card.kind === "lines"
      ? card.which === "timeline"
        ? (projection ? turnsOf(projection) : []).map((turn) => ({ row: turn.runId, spans: [{ text: timelineLine(turn) }] }))
        : card.which === "notices"
          ? noticesLines(notices, names)
          : tasksLines(projection)
      : [];
  // The asks card's rows: what `/asks` gathered, less what was answered from here.
  const askList = card.kind === "asks" ? askRows(asks, views, opened) : [];
  const askAt = card.kind === "asks" ? askList[clampCursor(card.cursor, askList.length)] : undefined;
  const bulk = askList.filter((row) => inBulk(row.ask.kind));
  /** `y` or `n` on the row under the cursor: a permission or denylist prompt answered in place; any other is opened to answer. */
  const decideInPlace = (decision: "allow" | "deny"): false | void => {
    if (!askAt) return false;
    if (!decidable(askAt.ask.kind)) return say(`This one is answered on its own card: ${keys("asks.open")} opens it.`);
    answers.answer(askAt.ask, { decision });
  };
  /** `a` or `N`: every permission row answered at once, once confirmed, and only when there are two or more. */
  const decideAll = (decision: "allow" | "deny"): false | void => {
    if (card.kind !== "asks" || bulk.length < 2) return false;
    const targets = bulk.map((row) => row.ask);
    update({
      question: {
        text: decision === "allow" ? `Allow all ${targets.length} permissions once? y/n` : `Deny all ${targets.length} permissions? y/n`,
        yes: () => targets.forEach((target) => answers.answer(target, { decision })),
      },
    });
  };
  const pagerMaxTop = Math.max(0, pagerLines.length - helpHeight);
  const pagerTop = card.kind === "pager" ? Math.min(card.top ?? pagerMaxTop, pagerMaxTop) : 0;
  const pagerMatches = card.kind === "pager" && card.query.length > 0 ? pagerLines.flatMap((line, index) => (lineText(line).toLowerCase().includes(card.query.toLowerCase()) ? [index] : [])) : [];
  const pagerTurns = card.kind === "pager" ? pagerLines.flatMap((line, index) => (line.row.startsWith("message:") && pagerLines[index - 1]?.row !== line.row ? [index] : [])) : [];

  const lastPress = useRef<string | undefined>(undefined);

  usePaste(
    (text) => {
      scheduler.bypass();
      attention.touch();
      composer.paste(text);
    },
    { isActive: focused === "composer" && !cardOpen },
  );

  useInput((input: string, key: InkKey) => {
    // A key draws what the scheduler holds back, with its own echo.
    scheduler.bypass();
    // Somebody is here: both bells wait again. Past three minutes of stillness the key is a return, answered with what happened
    // meanwhile; first, so a key with a line of its own has the last word.
    const recap = attention.touch();
    if (recap !== undefined) flash(recap, RECAP_FLASH_MS);
    const name = eventName(input, key);
    const previous = lastPress.current;
    // Text arriving in one read (a fast typist, a terminal that batches) ends on its last character: `one\` then Enter is `\ Enter`.
    lastPress.current = name ?? (input.length > 0 && !key.ctrl && !key.meta ? [...input].at(-1) : undefined);
    const listCard = card.kind === "environments" || card.kind === "menu" || card.kind === "client-sessions" || card.kind === "sessions" || card.kind === "snippets" || card.kind === "picker";
    // A list, the help overlay, the pager and the lines cards have the keys whatever has the focus; the focus has them back when it closes.
    const cardHasKeys = listCard || card.kind === "help" || card.kind === "pager" || card.kind === "lines" || card.kind === "asks" || promptShown;
    const composerHasKeys = focused === "composer" && !cardHasKeys;
    const composerText = composer.state.editor.text;
    const scrollCard = (to: (top: number) => number, max: number): false | void => {
      if (card.kind === "help") return update({ card: { ...card, top: Math.min(Math.max(to(Math.min(card.top, helpMaxTop)), 0), helpMaxTop) } });
      if (card.kind === "pager") return update({ card: { ...card, top: Math.min(Math.max(to(pagerTop), 0), max) } });
      if (card.kind === "lines") return update({ card: { ...card, top: Math.min(Math.max(to(card.top), 0), Math.max(0, cardLines.length - helpHeight)) } });
      return false;
    };
    const scroll = (to: (top: number) => number): false | void => scrollCard(to, pagerMaxTop);
    const move = (action: "picker.move" | "picker.moveVi") => (pressed: string) => {
      const step = direction(keymap, action, pressed);
      if (card.kind === "help" || card.kind === "lines") return scroll((top) => top + step);
      if (!listCard) return false;
      if (card.kind === "picker") return update({ card: { kind: "picker", picker: movedBy(card.picker, step) } });
      // A list typed at takes letters into its filter: k and j are letters there.
      if (action === "picker.moveVi" && card.kind === "sessions") return false;
      update({ card: { ...card, cursor: clampCursor(card.cursor + step, rowsOf(card)) } });
    };
    const onRow = (): Row | undefined => (transcriptFocused ? cursorRow : undefined);
    // Every key the screen answers, by action: the key is looked up in the keymap in force, never matched here.
    const handlers: Record<ScreenKey, Handler> & typeof composer.handlers = {
      ...composer.handlers,
      ...rail.handlers,
      "app.focus.next": () => (card.kind === "none" ? setFocus(nextFocus(focused, stops)) : false),
      "row.leave": () => {
        setView((v) => ({ ...v, cursor: null }));
        setFocus("composer");
      },
      "app.interrupt": () => {
        if (composer.searching) return composer.cancelSearch();
        if (interrupt()) return;
        if (view.offset > 0) return scrollTo(0);
        return false;
      },
      "app.interruptOrQuit": () => {
        // The text is cleared only where it is being typed: with the rail or the transcript focused it is kept.
        if (composerText !== "" && composerHasKeys) return composer.set(composerOf(""));
        if (promptShown && promptState.line !== null) return setPromptCard(lineClosed(promptState));
        if (screen.question) return update({ question: undefined });
        if (card.kind !== "none") return update({ card: card.kind === "help" ? card.under : { kind: "none" } });
        if (interrupt()) return;
        quitNow();
      },
      "app.pager.open": () => {
        if (!projection) return false;
        if (card.kind === "pager") return update({ card: { kind: "none" } });
        update({ card: { kind: "pager", top: null, query: "", typing: false } });
      },
      "app.help": () => {
        if (card.kind === "help") return update({ card: card.under });
        // Artemis's map: from an empty composer; with text there it is a character like any other. With the
        // focus in the rail or the transcript nothing is being typed, so it is the map (Artemis's rail rule).
        if (composerText !== "" && composerHasKeys) return false;
        // A list typed at takes `?` into its filter.
        if ((card.kind === "pager" && card.typing) || card.kind === "sessions") return false;
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
      "picker.leave": () => {
        if (card.kind === "none") return false;
        if (card.kind === "sessions" && card.filter.length > 0) return update({ card: { ...card, filter: "", cursor: 0 } });
        update({ card: back(card) });
      },
      "transcript.pageUp": () => (transcriptFocused || composerHasKeys ? scrollTo(view.offset + half) : false),
      "transcript.pageDown": () => (transcriptFocused || composerHasKeys ? scrollTo(view.offset - half) : false),
      "transcript.cursor": (pressed) => {
        const step = direction(keymap, "transcript.cursor", pressed);
        if (step === 0) return false;
        const next = stepCursor(rowIds, view.cursor, step);
        if (next === null) return;
        setView((v) => ({ ...v, cursor: next, offset: offsetShowing(lines, next, v.offset, height) }));
      },
      "transcript.follow": () => scrollTo(0),
      "row.recall": () => {
        const row = onRow();
        const recalled = row ? recall(row) : null;
        if (recalled === null) return false;
        composer.set(replaced(composer.state, recalled));
        setView((v) => ({ ...v, cursor: null }));
        setFocus("composer");
      },
      "row.copy": () => {
        const row = onRow();
        if (!row) return false;
        const text = rowLines(row, { ...lineContext, width: 10_000, expanded: true })
          .map(lineText)
          .join("\n")
          .trim();
        void clipboard.copy(text).then((outcome) => say(outcome === "none" ? "Nothing here can reach a clipboard." : "Copied the row."));
      },
      "row.unfold": () => {
        const row = onRow();
        if (!row) return false;
        setView((v) => {
          const unfolded = new Set(v.unfolded);
          if (unfolded.has(row.id)) unfolded.delete(row.id);
          else unfolded.add(row.id);
          return { ...v, unfolded };
        });
      },
      "row.stop": () => {
        const row = onRow();
        if (!row || !opened) return false;
        const target = stoppable(row, projection?.items ?? []);
        if (target === null) return say("Nothing on that row is running.");
        void stopCall(runtime, opened.environmentId, target.runId, target.taskId).then((line) => line && say(line));
      },
      "pager.line": (pressed) => {
        // j and ↓ go down, k and ↑ up, as the list writes them: j, k, ↑, ↓.
        const at = keymap.keys["pager.line"].indexOf(pressed);
        return scroll((top) => top + (at === 1 || at === 2 ? -1 : 1));
      },
      "pager.screenDown": () => scroll((top) => top + helpHeight),
      "pager.screenUp": () => scroll((top) => top - helpHeight),
      "pager.halfDown": () => scroll((top) => top + Math.max(1, Math.floor(helpHeight / 2))),
      "pager.halfUp": () => scroll((top) => top - Math.max(1, Math.floor(helpHeight / 2))),
      "pager.top": () => scroll(() => 0),
      "pager.bottom": () => scroll(() => (card.kind === "help" ? helpMaxTop : card.kind === "lines" ? cardLines.length : pagerMaxTop)),
      "pager.turn.next": () => {
        const next = pagerTurns.find((at) => at > pagerTop);
        return next === undefined ? false : scroll(() => next);
      },
      "pager.turn.prev": () => {
        const before = pagerTurns.findLast((at) => at < pagerTop);
        return before === undefined ? scroll(() => 0) : scroll(() => before);
      },
      "pager.search": () => (card.kind === "pager" ? update({ card: { ...card, query: "", typing: true } }) : false),
      "pager.match": (pressed) => {
        if (card.kind !== "pager" || pagerMatches.length === 0) return false;
        const backward = keymap.keys["pager.match"].indexOf(pressed) === 1;
        const next = backward ? (pagerMatches.findLast((at) => at < pagerTop) ?? pagerMatches.at(-1)) : (pagerMatches.find((at) => at > pagerTop) ?? pagerMatches[0]);
        return next === undefined ? false : scroll(() => next);
      },
      "pager.close": () => {
        if (card.kind === "help") return update({ card: card.under });
        if (card.kind === "pager" || card.kind === "lines") return update({ card: { kind: "none" } });
        return false;
      },
      "app.attention.next": () => attentionNext(),
      // The permission card (`cards/prompt.ts`): its move keys are up, down pairs, as the list writes them (↑, ↓, k, j).
      "permission.move": (pressed) => (promptShown ? setPromptCard(moved(shownPrompt.prompt, promptState, keymap.keys["permission.move"].indexOf(pressed) % 2 === 0 ? -1 : 1)) : false),
      "permission.choose": () => (promptShown ? step(chosen(shownPrompt.prompt, promptState)) : false),
      "permission.deny": () => (promptShown ? answerShown(denied(shownPrompt.prompt, promptState)) : false),
      "permission.note": () => (promptShown ? setPromptCard(lineOpened(promptState)) : false),
      "permission.tick": () => {
        const next = promptShown ? ticked(shownPrompt.prompt, promptState) : undefined;
        return next ? setPromptCard(next) : false;
      },
      "permission.rule.edit": () => (promptShown ? say(absentReason("permission.rule.edit")) : false),
      "permission.scope.walk": () => (promptShown ? say(absentReason("permission.scope.walk")) : false),
      // The asks card: a yes or a no answers a permission in place, Enter opens the session, Esc closes deciding nothing.
      "asks.move": (pressed) => (card.kind === "asks" ? update({ card: { ...card, cursor: clampCursor(card.cursor + direction(keymap, "asks.move", pressed), askList.length) } }) : false),
      "asks.open": () => {
        if (!askAt) return false;
        update({ card: { kind: "none" } });
        // The session on screen is behind the card already: closing it uncovers its own card.
        if (!askAt.here) open({ environmentId: askAt.ask.environmentId, sessionId: askAt.ask.sessionId });
      },
      "asks.allow": () => decideInPlace("allow"),
      "asks.deny": () => decideInPlace("deny"),
      "asks.allowAll": () => decideAll("allow"),
      "asks.denyAll": () => decideAll("deny"),
      "asks.close": () => (card.kind === "asks" ? update({ card: { kind: "none" } }) : false),
    };
    // The quit and the jump to what needs you, which nothing may take, are looked up first: before a line or a list typed at
    // takes the text, so neither is typed in when remapped to a printable key.
    if (dispatch(keymap, [{ context: "anywhere", only: FIRST_ANYWHERE }], handlers, input, key, previous)) return;
    // The note's line on the permission card takes what is typed; the move keys wait while it is open, and a key it does not
    // take (Ctrl+C, Ctrl+]) is looked up as any other.
    if (promptShown && promptState.line !== null) {
      const typed = (next: CardState | undefined) => void (next && setPromptCard(next));
      if (key.return) return step(lineEntered(shownPrompt.prompt, promptState));
      if (key.tab || key.escape) return setPromptCard(lineClosed(promptState));
      if (key.backspace || key.delete) return typed(lineTyped(promptState, { rub: "character" }));
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (key.ctrl && input === "u") return typed(lineTyped(promptState, { rub: "all" }));
      if (key.ctrl && input === "w") return typed(lineTyped(promptState, { rub: "word" }));
      if (input !== "" && !key.ctrl && !key.meta) return typed(lineTyped(promptState, { text: input }));
    }
    // A search being typed at the pager takes every key but Enter (done) and Esc (dropped).
    if (card.kind === "pager" && card.typing) {
      if (key.return) {
        const first = pagerMatches.find((at) => at >= pagerTop) ?? pagerMatches[0];
        return update({ card: { ...card, typing: false, top: first ?? card.top } });
      }
      if (key.escape) return update({ card: { ...card, typing: false, query: "" } });
      if (key.backspace || key.delete) return update({ card: { ...card, query: [...card.query].slice(0, -1).join("") } });
      if (input !== "" && !key.ctrl && !key.meta) return update({ card: { ...card, query: card.query + input } });
      return;
    }
    // Where a key is looked up, in order: the quit and the jump to what needs you, which nothing may take (above); a
    // question just asked (a removal or a revoke the card asks to confirm, a re-pair), which has the keys until it
    // is answered; the open card; unless a card has the keys, what has the focus and then the standing
    // service-down offer; the rest of what is answered anywhere. Neither question is looked up while its
    // letters are being typed into the composer. So a card's Esc or `n` is the card's, never the offer's answer,
    // and never an interrupt.
    const typing = composerHasKeys && composerText !== "";
    // A list typed at (a typed picker, the rail's filter) takes text before any other key is looked up: its letters are
    // `picker.filter` and the filter's, never a letter-keyed action or a question's answer, while no question was just asked.
    const text = printableText(input, key);
    if (!screen.question) {
      if (card.kind === "picker" && card.picker.typed && (text !== undefined || key.backspace || key.delete)) {
        return setScreen((s) =>
          s.card.kind === "picker" ? { ...s, card: { kind: "picker", picker: text !== undefined ? typedInto(s.card.picker, text) : erasedFrom(s.card.picker) } } : s,
        );
      }
      if (!cardHasKeys && focused === "sidebar" && text !== undefined && rail.type(text)) return;
    }
    const lookups: Lookup[] = [];
    if (screen.question && !typing) lookups.push("confirm");
    if (card.kind === "asks") lookups.push("asks");
    else if (card.kind === "help" || card.kind === "pager" || card.kind === "lines") lookups.push("pager", "picker");
    else if (card.kind !== "none") lookups.push("picker");
    if (promptShown) lookups.push("permission");
    if (!cardHasKeys) {
      lookups.push(focused);
      // The page keys are never the composer's: with it focused they still move the transcript half a screen (Artemis's rule).
      if (focused === "composer" && opened) lookups.push({ context: "transcript", only: PAGE_KEYS });
      if (!screen.question && question && !typing) lookups.push("confirm");
    }
    lookups.push({ context: "anywhere", except: FIRST_ANYWHERE });
    if (dispatch(keymap, lookups, handlers, input, key, previous)) return;
    // `/resume`'s list is typed at: letters filter it, Backspace rubs one out.
    if (card.kind === "sessions") {
      if (key.backspace || key.delete) return update({ card: { ...card, filter: [...card.filter].slice(0, -1).join(""), cursor: 0 } });
      if (input !== "" && !key.ctrl && !key.meta && !key.escape && !key.tab && !key.return) return update({ card: { ...card, filter: card.filter + input, cursor: 0 } });
      return;
    }
    // A key nothing answered is dropped unless the composer has the keys: the rail and the transcript take
    // every key, answered or not, so a letter pressed there is never typed into a text out of sight.
    if (cardHasKeys || focused !== "composer") return;
    if (key.leftArrow) return void composer.edit("left");
    if (key.rightArrow) return void composer.edit("right");
    if (key.delete) return void composer.edit("delete");
    // What is typed is text, not a key: a sigil (`/`) included, whatever the keymap says.
    if (input !== "" && !key.ctrl && !key.meta && !key.escape && !key.tab && !key.return) composer.type(input);
  });

  // A card that is a list of the session's needs the session: gone, it closes. The asks card closes with its last row.
  const sessionCard = card.kind === "pager" || (card.kind === "lines" && card.which !== "notices");
  useEffect(() => {
    if (!projection && sessionCard) update({ card: { kind: "none" } });
  }, [projection, sessionCard]);
  const asksDrained = card.kind === "asks" && askList.length === 0;
  useEffect(() => {
    if (asksDrained) setScreen((s) => (s.card.kind === "asks" ? { ...s, card: { kind: "none" } } : s));
  }, [asksDrained]);

  // The help overlay takes the width, as Artemis's did.
  const showRail = railDrawn && card.kind !== "help";
  const cardHasKeys = (card.kind !== "none" && card.kind !== "minted") || promptShown;
  // Under 100 columns the rail, with the focus, is drawn in the pane's place (the transcript gives way to it): the picker
  // that stands in for it.
  const railInPane = !railDrawn && railListed && focused === "sidebar" && card.kind === "none" && !promptShown;
  // The rows the rail and a picker have: the frame less the header and the four lines under the pane.
  const paneRows = Math.max(1, size.rows - 5);
  const listHint = (verb: string, leave: string) => `${keys("picker.move")} move · ${keys("picker.choose")} ${verb} · ${keys("picker.leave")} ${leave}`;
  /** The permission card's legend: the keys the card answers, in the map in force; the note's line takes Enter, Tab and Esc as they are. */
  const cardHint = (kind: PromptKind, lineOpen: boolean): string => {
    const move = keymap.keys["permission.move"].slice(0, 2).join("");
    if (kind === "question") {
      return lineOpen
        ? "Enter answers with this · Tab keeps it · Esc closes the line and does not skip"
        : `${move} move · ${keys("permission.tick")} tick · ${keys("permission.choose")} confirm · ${keys("permission.note")} your own words · ${keys("permission.deny")} skips`;
    }
    if (lineOpen) return "Enter or Tab keeps the note · Esc closes the line and decides nothing";
    return `${move} move · ${keys("permission.choose")} choose · ${keys("permission.note")} note · ${keys("permission.deny")} ${kind === "plan" ? "keeps planning" : "denies"}`;
  };
  // The permission card and the asks card have the keys as a card does; the asks card closes deciding nothing.
  const promptsHint = promptShown ? "The card has the keys" : card.kind === "asks" ? `The card has the keys · ${keys("asks.close")} closes it, deciding nothing` : undefined;
  const menuView = card.kind === "menu" || card.kind === "client-sessions" ? viewOf(card.environmentId) : undefined;
  const activity = activityLine(faults, notices);
  const promptLine = question?.text ?? (startingService ? "Starting the environment on this machine: starting…" : undefined);
  // The line under the composer says what has the keys, in the keys of the map in force: an open list or the help
  // overlay first, then the rail or the transcript. Either stays in sight beside a notice; the composer's own
  // hint gives way to one.
  const hint =
    card.kind === "help" || card.kind === "pager" || card.kind === "lines"
      ? `The card has the keys · ${keys("pager.close")} closes it`
      : card.kind === "environments" || card.kind === "sessions" || card.kind === "snippets"
        ? `The card has the keys · ${keys("picker.leave")} closes it`
        : card.kind === "menu" || card.kind === "client-sessions"
          ? `The card has the keys · ${keys("picker.leave")} goes back`
          : card.kind === "picker"
            ? `The card has the keys · ${keys("picker.leave")} ${card.picker.back ? "goes back" : "closes it"}`
          : focused === "sidebar"
            ? // What the keys do at the cursor gives way to a notice, as the composer's own hint does.
              `The rail has the keys · ${keys("rail.leave")} ${rail.filter !== null ? "clears the filter" : `back to the composer · ${keys("app.focus.next")} next`}${rail.hint !== undefined && activity === undefined ? ` · ${rail.hint}` : ""}`
            : focused === "transcript"
              ? `The transcript has the keys · ${keys("transcript.cursor")} rows · ${keys("row.unfold")} unfold · ${keys("row.recall")} recall · ${keys("row.stop")} stop · ${keys("row.leave")} back to the composer`
              : undefined;
  const composerHint = opened
    ? `${keys("composer.send")} sends · ${live ? `${keys("app.interrupt")} interrupts · ` : ""}${keys("app.pager.open")} pager · ${keys("app.help")} keys`
    : `${keys("app.interruptOrQuit")} quits · ${keys("app.help")} keys · /pair · /environment · /resume · /new`;
  const own = menuView ? (runtime.connections.list.read().find((r) => r.environmentId === menuView.environmentId)?.clientSessionId ?? null) : null;
  const freshness = projection?.freshness;
  const marker =
    opened && freshness !== "live"
      ? freshness === "cached"
        ? { text: `◌ cached: what this terminal last saw of it; ${names.get(opened.environmentId) ?? "its environment"} is not answering`, color: "yellow" }
        : { text: "⟳ catching up…", color: "cyan" }
      : undefined;
  const placeholder = !opened
    ? "no session open: /resume opens one, /new starts one"
    : session.lock.locked
      ? "nothing can be sent now"
      : live
        ? "steer or queue a message"
        : "message the agent";
  const steers = session.provider?.steering === true;
  const popup = composer.popup;
  const searchScope = composer.state.search ? (scopes[composer.state.search.scope]?.name ?? "everywhere") : undefined;

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Header
        current={(opened && viewOf(opened.environmentId)) || current}
        startingService={startingService}
        workspace={projection?.summary ? `${projection.summary.title} · ${projection.summary.workspace.path}` : props.flags.workspace}
      />
      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        {showRail && (
          <RailView lines={rail.lines} cursor={rail.cursor} focused={focused === "sidebar" && !cardHasKeys} filter={rail.filter} height={paneRows} width={RAIL_WIDTH} />
        )}
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {card.kind === "environments" && <EnvironmentsCard views={views} cursor={clampCursor(card.cursor, views.length)} hint={listHint("actions", "close")} />}
          {card.kind === "menu" && menuView && <EnvironmentMenu view={menuView} actions={actionsFor(menuView)} cursor={card.cursor} hint={listHint("choose", "back")} />}
          {card.kind === "client-sessions" && menuView && (
            <ClientSessionsCard view={menuView} rows={card.rows} own={own} cursor={clampCursor(card.cursor, card.rows?.length ?? 0)} hint={listHint("revoke", "back")} />
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
          {card.kind === "sessions" && (
            <SessionsCard
              rows={sessionRows(card.filter)}
              names={names}
              cursor={clampCursor(card.cursor, sessionRows(card.filter).length)}
              filter={card.filter}
              height={Math.max(1, helpHeight - 1)}
              hint={`type to filter · ${listHint("open", "close")}`}
            />
          )}
          {card.kind === "snippets" && <SnippetsCard rows={snippetRows()} cursor={clampCursor(card.cursor, snippetRows().length)} hint={listHint("expand", "close")} />}
          {card.kind === "pager" && (
            <LinesCard
              title={projection?.summary?.title ?? "The transcript"}
              hint={`${keys("pager.line")} ${keys("pager.halfDown")} ${keys("pager.halfUp")} scroll · ${keys("pager.turn.prev")} ${keys("pager.turn.next")} turns · ${keys("pager.search")} search · ${keys("pager.close")} close`}
              lines={pagerLines}
              top={pagerTop}
              height={helpHeight}
              footer={
                card.typing
                  ? `/${card.query}`
                  : card.query.length > 0
                    ? `${pagerMatches.length} match${pagerMatches.length === 1 ? "" : "es"} for ${card.query} · ${keys("pager.match")} next, before`
                    : undefined
              }
            />
          )}
          {card.kind === "lines" && (
            <LinesCard
              title={card.which === "timeline" ? "Timeline" : card.which === "notices" ? "Notices" : "Tasks"}
              hint={`${keys("pager.close")} close`}
              lines={cardLines.length > 0 ? cardLines : [{ row: "none", spans: [{ text: LINES_EMPTY[card.which], dim: true }] }]}
              top={card.top}
              height={helpHeight}
            />
          )}
          {card.kind === "asks" && (
            <AsksCard
              rows={askList}
              cursor={clampCursor(card.cursor, askList.length)}
              height={Math.max(1, helpHeight - 3)}
              hint={{
                decidable: `${keys("asks.move")} move · ${keys("asks.open")} open · ${keys("asks.allow")} allow once · ${keys("asks.deny")} deny${
                  bulk.length > 1 ? ` · ${keys("asks.allowAll")} allow all · ${keys("asks.denyAll")} deny all` : ""
                } · ${keys("asks.close")} closes, deciding nothing`,
                other: `${keys("asks.move")} move · ${keys("asks.open")} open · this one is answered on its own card · ${keys("asks.close")} closes, deciding nothing`,
              }}
            />
          )}
          {card.kind === "none" && opened && !railInPane && (
            <TranscriptView
              lines={lines}
              offset={Math.min(view.offset, maxOffset(lines, height))}
              cursor={transcriptFocused ? view.cursor : undefined}
              marker={marker}
              empty={projection?.deleted ? "This session was deleted." : freshness === "live" ? "Nothing said yet." : " "}
              onHeight={setViewport}
              follow={`${keys("transcript.follow")} follows`}
            />
          )}
          {card.kind === "none" && opened && !railInPane && <DelegatedStrip tasks={tasks} />}
          {card.kind === "none" && opened && !railInPane && projection && <QueuedLine queued={projection.queued} steers={steers} />}
          {promptShown && (
            <PromptCard
              prompt={shownPrompt.prompt}
              state={promptState}
              place={waitingHere.length > 1 ? `1 of ${waitingHere.length} waiting` : undefined}
              ttl={
                opened && shownPrompt.prompt.ttlExpiresAt !== null
                  ? ttlWords(Date.parse(shownPrompt.prompt.ttlExpiresAt) - runtime.environmentNow(opened.environmentId).getTime())
                  : undefined
              }
              hint={cardHint(shownPrompt.prompt.kind, promptState.line !== null)}
              absent={shownPrompt.prompt.kind === "permission" || shownPrompt.prompt.kind === "denylist" ? `${keys("permission.rule.edit")} ${keys("permission.scope.walk")}: rules are per session on the harness` : undefined}
            />
          )}
          {card.kind === "none" && !opened && !railInPane && started && known.length === 0 && <PairingPrompt />}
          {card.kind === "none" && !opened && !railInPane && !started && <Text dimColor> Connecting…</Text>}
          {card.kind === "none" && !opened && !railInPane && started && known.length > 0 && <Text dimColor> No session is open.</Text>}
        </Box>
      </Box>
      <Line text={screen.line} />
      <Line text={promptLine} color="yellow" />
      <ComposerView
        editor={composer.state.editor}
        focused={focused === "composer" && !cardHasKeys}
        locked={opened && session.lock.locked ? session.lock.reason : undefined}
        placeholder={placeholder}
        popup={popup}
        highlight={popup ? highlighted(composer.state, popup) : -1}
        search={composer.state.search && searchScope !== undefined ? { query: composer.state.search.query, scope: searchScope, found: composer.state.editor !== composer.state.search.saved } : undefined}
        note={composerNote(composer.state, keys("composer.complete"))}
      />
      <HintLine hint={promptsHint ?? hint} activity={activity} fallback={composerHint} />
    </Box>
  );
};

const clampCursor = (cursor: number, rows: number): number => (rows <= 0 ? 0 : Math.min(Math.max(cursor, 0), rows - 1));

/** Why an action the shared list keeps absent does nothing: its reason, as the help overlay draws it. */
const absentReason = (id: KeyActionId): string => {
  const action = actionById(id);
  return action?.status === "absent" ? action.reason : `${id} does nothing here.`;
};

/** What a lines card says with nothing to list. */
const LINES_EMPTY: Readonly<Record<"tasks" | "timeline" | "notices", string>> = {
  tasks: "No delegated work in this session.",
  timeline: "No turn yet.",
  notices: "No notices.",
};

/** `/notices`: every notice the runtime holds, newest first, with when, where from and what it offers. */
const noticesLines = (notices: readonly Notice[], names: ReadonlyMap<string, string>): TranscriptLine[] =>
  [...notices].reverse().map((notice) => ({
    row: notice.id,
    spans: [
      { text: `${clockTime(notice.at)}  `, dim: true },
      { text: `${names.get(notice.environmentId) ?? "an environment"}  `, bold: true },
      { text: noticeLine(notice), ...(NOTICE_COLOURS[notice.kind] !== undefined && { color: NOTICE_COLOURS[notice.kind] }) },
    ],
  }));

/** The notices worth a colour in `/notices`: what blocks a connection or a command in red, a prompt waiting in yellow. */
const NOTICE_COLOURS: Readonly<Partial<Record<Notice["kind"], string>>> = {
  revoked: "red",
  expired: "red",
  "command-rejected": "red",
  "command-dropped": "red",
  "prompt-parked": "yellow",
};

/** Ctrl+G with the terminal lent to `$EDITOR`: Ink leaves the alternate screen and raw mode while it runs (`suspendTerminal`). */
const runEditor = async (suspend: (callback: () => Promise<void>) => Promise<void>, text: string): Promise<ExternalEditResult> => {
  let result: ExternalEditResult = { ok: false, reason: "the editor did not run" };
  await suspend(async () => {
    result = await editInExternalEditor(text);
  });
  return result;
};

/** What `r` puts back in the composer: the shell line a command call ran, or a slash command the run ran; null for any other row. */
const recall = (row: Row): string | null => {
  if (row.kind === "command") return `/${row.entry.name}${row.entry.args.length > 0 ? ` ${row.entry.args}` : ""}`;
  if (row.kind !== "calls") return null;
  for (const call of [...row.calls].reverse()) {
    const command = call.input["command"] ?? call.input["cmd"];
    if (typeof command === "string" && command.trim().length > 0) return command;
  }
  return null;
};

/** What `x` stops on a row: its running call's run and, when the run's ledger names delegated work for the call, that task. */
const stoppable = (
  row: Row,
  items: readonly { readonly kind: string }[],
): { readonly runId: string; readonly taskId: string | undefined } | null => {
  const calls = row.kind === "calls" ? row.calls : row.kind === "subagent" ? row.entry.calls : [];
  const running = calls.find((call) => call.status === "running");
  if (row.kind === "subagent" && row.entry.running && row.entry.task) return { runId: row.runId, taskId: row.entry.task.taskId };
  if (!running) return null;
  const ledger = items.findLast((entry) => entry.kind === "tasks" && (entry as { runId?: string }).runId === running.runId) as
    | { readonly tasks: readonly { readonly taskId: string; readonly toolCallId: string | null; readonly endedAt: string | null }[] }
    | undefined;
  const task = ledger?.tasks.find((t) => t.toolCallId === running.toolCallId && t.endedAt === null);
  return { runId: running.runId, taskId: task?.taskId };
};

/** `/tasks`: every piece of delegated work the session's runs held, newest run first, with its status. */
const tasksLines = (projection: { readonly items: readonly { readonly kind: string }[] } | undefined): TranscriptLine[] => {
  if (!projection) return [];
  const ledgers = projection.items.filter((entry) => entry.kind === "tasks") as unknown as readonly {
    readonly runId: string;
    readonly tasks: readonly { readonly taskId: string; readonly kind: string; readonly subagentType: string | null; readonly description: string; readonly status: string; readonly startedAt: string; readonly error: string | null }[];
  }[];
  return [...ledgers].reverse().flatMap((ledger) =>
    ledger.tasks.map((task): TranscriptLine => ({
      row: task.taskId,
      spans: [
        { text: `${clockTime(task.startedAt)}  ` , dim: true },
        { text: `${task.subagentType ?? task.kind}: `, bold: true },
        { text: task.description },
        { text: ` · ${task.status}${task.error ? `: ${task.error}` : ""}`, dim: true, ...(task.status === "failed" && { color: "red" }) },
      ],
    })),
  );
};
