import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Box, Text, render as inkRender, useApp, useInput, usePaste, useStdout, type Instance, type RenderOptions } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import {
  attachmentRefusal,
  attachmentRefused,
  browse,
  bulkAsks,
  bulkQuestion,
  checkWords,
  decidable,
  denylistRepeatWords,
  directoryOf,
  followDraft,
  inWorkspace,
  interruptRun,
  isLive,
  lastReply,
  oneOffMessage,
  oneLine,
  outsideWorkspace,
  quietFor,
  readQueueNow,
  runOneOff,
  sendMessage,
  sessionTasks,
  shellLine,
  slashMenuRows,
  stopCall,
  subagentRows,
  transcriptRows,
  ttlWords,
  typedPath,
  undoableFold,
  undoFile,
  userMessagesOf,
  withdrawQueued,
  workspaceLabel,
  type BrowseRow,
  type CapabilityAnswer,
  type ClientCommandRow,
  type Clock,
  type EnvironmentView,
  type GrantReader,
  type InStep,
  type NewSessionFocus,
  type Notice,
  type Observable,
  type PairingInput,
  type PromptEntry,
  type SessionRow,
  type TranscriptEntry,
  type TranscriptRow as Row,
  type VerbAvailability,
} from "@agent-harness/client-runtime";
import {
  ACTION_CONDITIONS,
  PRODUCT_NAME,
  actionById,
  isCommandId,
  type AttachmentInput,
  type CommandsListEntry,
  type KeyActionId,
  type PromptAnswerInput,
  type PromptKind,
  type SkillReadiness,
} from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import { ANSWERED, BUILD_WORDS, type ScreenKey } from "./answered.js";
import { quietChrome, type TerminalChrome } from "./attention/chrome.js";
import { RECAP_FLASH_MS } from "./attention/policy.js";
import { useAttention } from "./attention/use-attention.js";
import { useAnswers } from "./cards/answers.js";
import { askKey, askRows, parkedSessions, promptKey } from "./cards/asks.js";
import { cardFor, chosen, denied, lineClosed, lineEntered, lineOpened, lineTyped, moved, ticked, type CardState, type CardStep } from "./cards/prompt.js";
import {
  applyAction,
  actionsFor,
  listClientSessions,
  lookChange,
  lookPicker,
  lookRefusal,
  removeEnvironment,
  revokeClientSession,
  setLook,
  type ClientSessionRow,
  type LookField,
} from "./commands/environment.js";
import { parseCommand } from "./commands/parse.js";
import { mintPairing, pairingLine, type MintedLines } from "./commands/pair.js";
import { drainAndUpdateQuestionLine, updateCard, updateNow, updateRefusal, updateToClient } from "./commands/updates.js";
import { startLocalEnvironment } from "./commands/service.js";
import { expandHome, readAttachment } from "./composer/attachments.js";
import { copyText, readClipboardImage, readClipboardText, type CopyOutcome } from "./composer/clipboard.js";
import { ROUTINE_FILE, editInExternalEditor, openInExternalEditor, type ExternalEditResult, type OpenedFile, type OpenedResult } from "./composer/external-editor.js";
import { HISTORY_FILE, PromptHistory, type HistoryScope } from "./composer/history.js";
import { Frecency, MENTIONS_FILE } from "./composer/mentions.js";
import { EXAMPLE_SNIPPETS, SNIPPETS_FILE, Snippets, toSnippetName, type SnippetTemplate } from "./composer/snippets.js";
import { composerOf, expandedSnippet, replaced, type CommandRow } from "./composer/state.js";
import { composerNote, highlighted, useComposer, type ComposerClipboard } from "./composer/use-composer.js";
import { nextFocus, stepCursor, type Focus } from "./focus.js";
import { previewLine } from "./files/documents.js";
import { readFile, rowDiff, sessionDiff, systemDiffFilter, type DiffFilter, type Page, type Paged } from "./files/views.js";
import { ListCard } from "./pickers/cards.js";
import type { Panel, PanelRow } from "./pickers/panel.js";
import { setupHeader } from "./pickers/panel.js";
import { usePickers } from "./pickers/use-pickers.js";
import { createFrameScheduler } from "./frames.js";
import { helpLines } from "./help.js";
import {
  FIRST_ANYWHERE,
  conditionOf,
  direction,
  dispatch,
  eventName,
  keysText,
  placeOf,
  pressedBefore,
  type Handler,
  type InkKey,
  type Keymap,
  type LoadedKeymap,
  type Lookup,
  type Press,
} from "./keys.js";
import type { LocalService } from "./platform/services.js";
import { jsonDocuments } from "./platform/json-documents.js";
import { AFTER_EDIT_DOCUMENT } from "./platform/terminal-batch.js";
import { inMemoryPresentation, type Presentation } from "./presentation.js";
import { PickerCard, STAYS, erasedFrom, movedBy, printableText, rowAt, typedInto, type Picker } from "./rail/picker.js";
import { badgesOf } from "./rail/badge.js";
import type { CardOpening } from "./rail/new-session.js";
import { RAIL_WIDTH, RailView } from "./rail/rail.js";
import { sessionBrowserPicker } from "./rail/browser.js";
import { useRail } from "./rail/use-rail.js";
import { isFullPath } from "./rail/workspace-step.js";
import type { RoutinesCard } from "./routines/cards.js";
import { useRoutines } from "./routines/use-routines.js";
import type { RuntimeHost } from "./runtime-host.js";
import { AsksCard } from "./screens/asks-card.js";
import { ClientSessionsCard, EnvironmentMenu, EnvironmentsCard, HelpCard, MintedCard } from "./screens/cards.js";
import { ComposerView } from "./screens/composer.js";
import { trustQuestion } from "./session/trust.js";
import { FilesCard } from "./screens/files-card.js";
import { OUTSIDE_COLUMN, TerminalPaneView, paneRows as terminalPaneRows } from "./screens/terminal-pane.js";
import { Header, HintLine, Line, PairingPrompt, RAIL_MIN_COLUMNS } from "./screens/layout.js";
import { DocumentsCard, PromptPickerCard, SessionsCard, SnippetsCard } from "./screens/lists.js";
import { PromptCard } from "./screens/prompt-card.js";
import { DelegatedStrip, LinesCard, QueuedLine, RewoundStrip, TranscriptView, maxOffset, offsetShowing, type QueueVerb } from "./screens/transcript.js";
import { useForkRewind } from "./session/use-fork-rewind.js";
import { useFollow, useSession, type Opened } from "./session/use-session.js";
import { runInfoLines } from "./status/run-info.js";
import { codeBlocks, exportMarkdown, timelineLine, turnsOf } from "./transcript/export.js";
import { lineText, rowLines, transcriptLines, wrap, type Line as TranscriptLine } from "./transcript/lines.js";
import { StatusLine } from "./status/status-line.js";
import { useStatus } from "./status/use-status.js";
import { editCalls, rowFile } from "./transcript/targets.js";
import { heldApart, keyBytes } from "./terminal/keys.js";
import { createScreen } from "./terminal/screen.js";
import { useRawInput } from "./terminal/raw-input.js";
import { useTerminalPane } from "./terminal/use-terminal.js";
import { SIXTEEN, ThemeColoursContext, type ColourDepth } from "./theme/colours.js";
import { useThemeColours } from "./theme/use-theme-colours.js";
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
  type Question,
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

export type { DiffFilter } from "./files/views.js";
export type { OpenedFile } from "./composer/external-editor.js";

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
  /** This client's version, the harness version it was built as: what it offers an environment running an older one (#827). */
  readonly version: string;
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
  /** A routine's YAML in the editor (`/routines`' edit and new); preset `$VISUAL` or `$EDITOR` on a `.yaml` file, with the terminal lent to it. */
  readonly editRoutine?: (yaml: string) => Promise<ExternalEditResult>;
  /** Mints a routine's id for `/routines new` and an import: a version 4 UUID. */
  readonly newRoutineId?: () => string;
  /** Mints a terminal id for `/terminal` and `!!`: a version 4 UUID. */
  readonly newTerminalId?: () => string;
  /** `o` on a local environment: the file in `$VISUAL` or `$EDITOR`, with the terminal lent to it. */
  readonly openFile?: (file: OpenedFile) => Promise<OpenedResult>;
  /** The user's diff filter for a pager so wide: preset `AGENT_HARNESS_DIFF`, else delta, diff-so-fancy or bat on `PATH`, else none. */
  readonly diffFilter?: (columns: number) => DiffFilter | null;
  /** The terminal's title and bell (the attention seam): preset none, so nothing is written; `runTui` hands in the terminal's. */
  readonly chrome?: TerminalChrome;
  /** The client-local presentation (the rail's folds): the state directory's; preset, held in memory. */
  readonly presentation?: Presentation;
  /** How this terminal draws colour (`colourDepth`): preset the sixteen alone, so the theme is not drawn. */
  readonly depth?: ColourDepth;
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
  /** `/tasks`, `/timeline` or run info: lines about the session, scrolled from `top`. */
  | { readonly kind: "lines"; readonly which: "tasks" | "timeline" | "run-info"; readonly top: number }
  /** `/notices`: every notice, newest first; Enter on one about a session (a routine's firing, a parked prompt) opens it (#533). */
  | { readonly kind: "notices"; readonly cursor: number }
  /** A picker or card of accounts, models, permissions and settings (`pickers/`). */
  | { readonly kind: "panel"; readonly panel: Panel }
  /** `/asks` and `Ctrl+]`: every environment's parked prompts. */
  | { readonly kind: "asks"; readonly cursor: number }
  /**
   * The pager over lines of its own (#148): a file, a diff, the terminal's scrollback, from `top` (null: the end), with a
   * search; `back` is the card it goes back to when it closes (the files or the documents it was read from); `copy`, a
   * file's text as read, which `pager.copy` copies (#427).
   */
  | {
      readonly kind: "page";
      readonly title: string;
      readonly lines: readonly TranscriptLine[];
      readonly copy?: Page["copy"];
      readonly top: number | null;
      readonly query: string;
      readonly typing: boolean;
      readonly back: Card;
    }
  /** `/files`: the workspace's listing, one directory at a time (`dir`, the root ""), filtered by what is typed. */
  | { readonly kind: "files"; readonly dir: string; readonly cursor: number; readonly filter: string }
  /** `/documents`: the session's documents, newest first, from `projections.documents` (#427). */
  | { readonly kind: "documents"; readonly cursor: number }
  /** Esc Esc: the prompt picker of the session it was opened on; the cursor on the newest user message until a key moves it (null). */
  | { readonly kind: "prompt-picker"; readonly environmentId: string; readonly sessionId: string; readonly cursor: number | null }
  /** `/routines` (#533): every environment's routines, a routine's history, the webhook endpoints, an import, a pre-check's test (`routines/`). */
  | { readonly kind: "routines"; readonly routines: RoutinesCard };

/** The cards that page lines with the pager's keys and search. */
const paged = (card: Card): card is Extract<Card, { readonly kind: "pager" | "page" }> => card.kind === "pager" || card.kind === "page";

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

/** Whether a send is heard back: its `message.sent` is in the transcript, by its id once the answer named it, else by its text. */
const heard = (send: Sending, items: readonly TranscriptEntry[]): boolean =>
  items.some(
    (entry) => entry.kind === "user-message" && (entry.messageId === send.messageId || (send.messageId === undefined && entry.text === send.text && !send.before.has(entry.messageId))),
  );

const useObservable = <T,>(observable: Observable<T>): T => useSyncExternalStore(observable.subscribe, observable.read);

/** The transcript's keys the composer lets through. */
const PAGE_KEYS: ReadonlySet<KeyActionId> = new Set<KeyActionId>(["transcript.pageUp", "transcript.pageDown"]);

/** The pane's leave key, looked up once more right after it left the pane: pressed twice, it goes to the shell. */
const LEAVE: ReadonlySet<KeyActionId> = new Set<KeyActionId>(["terminal.leave"]);

/** How soon after leaving the pane the leave key counts as pressed twice, sending it to the shell (a chosen default). */
export const LEAVE_TWICE_MS = 500;

/** What `/terminal` and `!` say when this Ink cannot hand the pane its keys (`useRawInput`). */
const DEAF = "this build of Ink does not hand the pane its keys.";

const NO_FAULTS: Observable<readonly Fault[]> = { read: () => [], subscribe: () => () => undefined };

/**
 * The slash menu's rows: the commands this build answers, from the shared list, then the open session's skills and the
 * provider's own commands (`commands.list`, #503), by the runtime's rule for every renderer.
 */
const commandRows = (listed: readonly CommandsListEntry[], readiness: readonly SkillReadiness[], undo: CapabilityAnswer): readonly CommandRow[] => {
  const own = [...ANSWERED]
    .filter((id) => isCommandId(id))
    .map((id): ClientCommandRow => {
      const action = actionById(id);
      return { name: id.slice("command.".length), usage: action?.usage ?? `/${id.slice(8)}`, description: action?.description ?? "" };
    });
  const taken = new Set(own.map((row) => row.name));
  return slashMenuRows(own, listed, (name) => taken.has(name)).map((row) => {
    const state = row.source === "skill" ? readiness.find((skill) => skill.name === row.name.replace(/^skill:/, "")) : undefined;
    if (row.source === "client" && row.name === "undo") return { ...row, availability: undo };
    return state === undefined ? row : { ...row, readiness: state };
  });
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
  // What has the keys when no card does: Tab walks the composer, rail, delegated strip, terminal and transcript.
  const [focus, setFocus] = useState<Focus>("composer");
  const [delegatedCursor, setDelegatedCursor] = useState<string | null>(null);
  const help = useMemo(() => helpLines(keymap, ANSWERED, BUILD_WORDS), [keymap]);
  const say = (line: string) => update({ line });
  const keys = (action: KeyActionId) => keysText(keymap, action);

  // The client-local stores in the state directory: the prompt history, the snippets, the `@` pick memory.
  const [stores, setStores] = useState<{ readonly history?: PromptHistory; readonly snippets?: Snippets; readonly mentions?: Frecency }>({});
  useEffect(() => {
    const dir = props.stateDir;
    if (dir === undefined) return;
    let gone = false;
    const snippetsFailed = (error: unknown) => gone || say(`The snippets could not be written, so they last only until you quit: ${messageOf(error)}`);
    void Promise.all([PromptHistory.load(join(dir, HISTORY_FILE)), Snippets.load(join(dir, SNIPPETS_FILE), snippetsFailed), Frecency.load(join(dir, MENTIONS_FILE))]).then(
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
  /** `/notices`' rows: the newest first. */
  const newestFirst = useMemo(() => [...notices].reverse(), [notices]);
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
  // The colours the theme gives this terminal: the home environment's under truecolour, else the sixteen alone.
  const colours = useThemeColours(runtime, views, props.depth ?? SIXTEEN, request);
  const badges = useMemo(() => badgesOf(views, colours), [views, colours]);

  // The session on screen.
  const session = useSession(runtime, clock, request);
  const { opened, projection } = session;
  const sessionView = opened ? views.find((v) => v.environmentId === opened.environmentId) : undefined;
  /** The environment the header and the status line are about: the open session's, else the current one. */
  const headerView = sessionView ?? current;
  const headerEnvironment = headerView?.environmentId;
  const headerSetup = useMemo(() => headerEnvironment === undefined ? undefined : runtime.projections.setup(headerEnvironment), [runtime, headerEnvironment]);
  useFollow(headerView?.flags.includes("setup") ? headerSetup : undefined, request);
  const setupSummary = headerSetup && headerView ? setupHeader(headerSetup.read(), nameOf(headerView)) : undefined;
  const setupSummaryRows = setupSummary === undefined ? 0 : wrap([{ text: setupSummary }], size.columns).length;
  const checks = useMemo(() => opened ? runtime.projections.checks(opened.environmentId, opened.sessionId) : undefined, [runtime, opened]);
  useFollow(checks, request);
  const checkView = checks?.read();
  const checkUnavailable = checkView?.availability.status === "absent" ? ` ${checkWords.labelled(checkView.availability.message)}` : undefined;
  const checkOffer = checkView?.offer ? ` Send failure: Enter on an empty composer · ${checkView.offer.result?.timedOut ? "timeout" : "failure"}` : undefined;
  const checkSummaryRows = [checkUnavailable, checkOffer].reduce((rows, text) => rows + (text === undefined ? 0 : wrap([{ text }], size.columns).length), 0);

  // The open session's workspace, when the environment has found it gone (#328): read from its list row, as the rail's.
  const openRow = opened ? list.rows.find((row) => row.environmentId === opened.environmentId && row.summary.id === opened.sessionId) : undefined;
  const gone = openRow?.summary.workspaceMissingSince != null ? openRow.summary.workspace.path : undefined;
  const [view, setView] = useState<View>(FRESH_VIEW);
  const [viewport, setViewport] = useState(0);
  const [sending, setSending] = useState<readonly Sending[]>([]);
  const sends = useRef(0);
  const open = (next: Opened | null) => {
    session.open(next);
    setView(FRESH_VIEW);
    setSending([]);
    setDelegatedCursor(null);
    if (next) setFocus("composer");
  };
  // A send heard back leaves for good, so a message withdrawn since, gone from the transcript, is never drawn as on its way
  // again (#231). Pruned after the render that heard it, which the foot's own check below already hides it in.
  useEffect(() => {
    const items = projection?.items ?? [];
    setSending((all) => (all.some((send) => heard(send, items)) ? all.filter((send) => !heard(send, items)) : all));
  }, [projection, sending]);

  // The terminal pane (#148): the open session's environment-owned terminal, drawn between the transcript and the
  // composer. It is the session's: another session opened takes it away, and its terminal runs on.
  const terminal = useTerminalPane({
    runtime,
    request,
    say,
    newCommandId: props.newCommandId,
    newTerminalId: props.newTerminalId ?? (() => crypto.randomUUID()),
    nameOf: (environmentId) => names.get(environmentId) ?? "its environment",
  });
  // Every key's bytes, heard for the pane (`paneKey`, below); false when this Ink cannot hand them over, and the pane is refused.
  const paneKey = useRef<(bytes: string) => void>(() => undefined);
  const hearsKeys = useRawInput((bytes) => paneKey.current(bytes));
  const paneOpen = terminal.pane !== null && (terminal.pane.sessionId === null
    ? views.some((view) => view.environmentId === terminal.pane?.environmentId)
    : opened !== null && terminal.pane.environmentId === opened.environmentId && terminal.pane.sessionId === opened.sessionId);
  useEffect(() => {
    if (terminal.pane !== null && !paneOpen) terminal.close();
  }, [paneOpen, terminal.pane]);

  const tasks = useMemo(() => (projection ? sessionTasks(projection).live.filter((row) => row.runId === session.liveRunId) : []), [projection, session.liveRunId]);
  const delegatedAt = Math.max(0, tasks.findIndex((row) => row.task.taskId === delegatedCursor));
  const delegatedTask = tasks[delegatedAt];
  // The stops Tab walks that come and go: the rail, the live delegated strip and the terminal pane. Under 100 columns
  // the rail is not drawn beside the pane: with the focus it is drawn in the pane's place, the picker that stands in for
  // it. A stop that goes takes the focus back to the composer.
  const railListed = views.length > 0;
  const railDrawn = size.columns >= RAIL_MIN_COLUMNS && railListed;
  const stops = { sidebar: railListed, delegated: tasks.length > 0, terminal: paneOpen };
  const focused: Focus = (focus === "sidebar" && !railListed) || (focus === "terminal" && !paneOpen) || (focus === "delegated" && tasks.length === 0) ? "composer" : focus;
  // The pane's terminal is as wide as the column beside the rail (the help overlay's taking the width is no resize) and two
  // fifths of the frame tall, within the column.
  const paneSize = { cols: Math.max(20, size.columns - (railDrawn ? RAIL_WIDTH : 0)), rows: terminalPaneRows(size.rows - setupSummaryRows - checkSummaryRows) };
  useEffect(() => terminal.resize(paneSize), [paneSize.cols, paneSize.rows]);
  useEffect(() => {
    if (focus !== focused) setFocus(focused);
  }, [focus, focused]);
  useEffect(() => {
    if (focused === "delegated" && delegatedTask && delegatedCursor !== delegatedTask.task.taskId) setDelegatedCursor(delegatedTask.task.taskId);
  }, [focused, delegatedTask, delegatedCursor]);

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
        if (outcome.status === "paired") {
          const environments = new Set([outcome.environmentId, opened?.environmentId ?? current?.environmentId]);
          for (const environmentId of environments) if (environmentId !== undefined) void runtime.setup.check(environmentId, "your-machines");
        }
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
  // The user messages the prompt picker lists (#232).
  const messages = useMemo(() => (projection ? userMessagesOf(projection.items) : []), [projection]);
  const transcriptFocused = focused === "transcript" && screen.card.kind === "none";
  // The latest rewind standing, which its fold draws the undo on while no run has started since (#232).
  const standing = session.runs?.rewound ?? null;
  const undoVerb = session.runs?.verbs.undoRewind;
  const lineContext = {
    width: mainWidth - (transcriptFocused ? 1 : 0),
    quietMs: (id: string) => quietFor(session.quiet, id, now),
    checkOutput: (id: string) => checkView?.runningOutput.get(id),
    stopKey: keys("row.stop"),
    unfoldKey: keys("row.unfold"),
    openKey: keys("row.open"),
    planDeltas: session.planDeltas,
    ...(session.forkedFrom !== undefined && { forkedFrom: session.forkedFrom }),
    ...(standing !== null && undoVerb !== undefined && { rewound: { sequence: standing.sequence, availability: undoVerb, key: keys("row.rewindUndo") } }),
  };
  const lines: TranscriptLine[] = [
    ...transcriptLines(rows, { ...lineContext, expanded: false }, view.unfolded),
    // A message sent and not yet heard back: dim at the foot, until its `message.sent` arrives.
    ...sending
      .filter((s) => !heard(s, projection?.items ?? []))
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

  const sendingFailure = useRef(false);
  const sendCheckFailure = (): boolean => {
    if (!opened || !checkView?.offer || sendingFailure.current) return false;
    sendingFailure.current = true;
    void runtime.checks.sendFailure(opened.environmentId, opened.sessionId).then((answer) => {
      if (!answer.ok) say(answer.line);
    }).finally(() => { sendingFailure.current = false; });
    return true;
  };
  // The composer.
  const readiness = useMemo(() => (opened ? runtime.requests.cached(opened.environmentId, "skills.readiness", { sessionId: opened.sessionId }) : undefined), [runtime, opened]);
  useFollow(readiness, request);
  const trust = useMemo(() => (opened ? runtime.requests.cached(opened.environmentId, "trust.get", { sessionId: opened.sessionId }) : undefined), [runtime, opened]);
  useFollow(trust, request);
  const trustLine = trustQuestion(trust?.read().result);
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
      commands: commandRows(session.listedCommands, readiness?.read().result?.skills ?? [], opened ? runtime.capability(opened.environmentId, "files.undo") : { status: "absent", reason: "unreachable", message: "No session is open." }),
      paths,
      ...(stores.mentions && { frecency: stores.mentions }),
      snippets: stores.snippets?.list() ?? [],
    },
    history: stores.history,
    scopes,
    clipboard,
    editText: async (text) => {
      const edit =
        props.editText ?? ((initial: string) => lendTerminal<ExternalEditResult>(suspendTerminal, () => editInExternalEditor(initial), { ok: false, reason: "the editor did not run" }));
      const result = await edit(text).catch((error: unknown): ExternalEditResult => ({ ok: false, reason: messageOf(error) }));
      if (result.ok) return result.text;
      say(`Could not edit the text: ${result.reason}`);
      return undefined;
    },
    say,
    submit: (raw, message) => submit(raw, message),
    sendFailure: sendCheckFailure,
    picked: (path) => {
      stores.mentions?.record(path);
      void stores.mentions?.save().catch(() => undefined);
    },
    active: focused === "composer" && !cardOpen,
    suggestion: projection?.suggestion,
    sendSuggestion: (text, onRefused) => sendText({ text, attachments: [] }, { onRefused }),
  });
  // The workspace is listed once the text names a file with `@`, or `/files` is open, and kept for five minutes by the request cache.
  useFollow(composer.text.includes("@") || screen.card.kind === "files" ? files : undefined, request);
  const listing = files?.read().result ?? null;
  const fileRows = (card: { readonly dir: string; readonly filter: string }): readonly BrowseRow[] | null => (listing ? browse(listing.files, card.dir, card.filter) : null);

  // The session's documents (#427), followed while `/documents` is open, so the list moves as the runs write.
  const documents = useMemo(() => (opened ? runtime.projections.documents(opened.environmentId, opened.sessionId) : undefined), [runtime, opened]);
  useFollow(screen.card.kind === "documents" ? documents : undefined, request);
  const documentRows = screen.card.kind === "documents" ? (documents?.read() ?? []) : [];

  // The draft is the session's field (session-state spec), kept in step by the runtime's rule (`followDraft`): what is
  // typed is saved through the runtime, which waits a second after the last key; a session opened takes its draft; a
  // draft another client saved replaces this one's only while nothing has been typed over what this client last held,
  // so a keystroke is never lost to a late echo.
  const synced = useRef<InStep | undefined>(undefined);
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
    const text = composer.current();
    const step = followDraft(synced.current, {
      session: openKey,
      held: projection?.summary ? (projection.draft ?? "") : undefined,
      text,
      // Like the window, keep a single slash word (including incomplete commands) and our commands with arguments out of the draft.
      saves: !/^\/\S*$/.test(text) && !(text.startsWith("/") && parseCommand(text).kind !== "text") && shellLine(text) === null,
    });
    synced.current = step.inStep;
    if (step.take !== undefined) composer.set(composerOf(step.take));
    if (step.save !== undefined) runtime.drafts.set(opened.environmentId, opened.sessionId, step.save.length > 0 ? step.save : null);
  });

  // Fork and rewind (ADR 0022; #232): the prompt picker's two actions, `/rewind`, `/fork` and the row verbs dispatch through it.
  const forkRewind = useForkRewind({
    runtime,
    opened,
    projection,
    runs: session.runs,
    liveRunId: liveRun,
    say,
    ask: (asked) => update({ question: asked }),
    openSession: (next) => open(next),
  });
  /** A row verb's words for a hint: its keys and what it does, with the runtime's reason when it cannot be used now; `stop` when it is offered as a stop first. */
  const verbHint = (id: KeyActionId, words: string, availability: VerbAvailability | undefined, stop = false): string =>
    stop ? `${keys(id)} stop and ${words}` : `${keys(id)} ${words}${availability?.status === "absent" ? ` (${availability.message})` : ""}`;
  // The accounts, models, permissions, settings and Set up commands (#147): their cards are the screen's, their memory of a
  // session's next runs (a model and effort, a containment level, an account handed off onto) is theirs.
  const runInfoEnvironment = screen.card.kind === "lines" && screen.card.which === "run-info" ? opened?.environmentId : undefined;
  const runInfoAccounts = useMemo(() => runInfoEnvironment === undefined ? undefined : runtime.projections.accounts(runInfoEnvironment), [runtime, runInfoEnvironment]);
  useFollow(runInfoAccounts, request);
  const runInfoModels = useMemo(() => runInfoEnvironment === undefined ? undefined : runtime.projections.models(runInfoEnvironment), [runtime, runInfoEnvironment]);
  useFollow(runInfoModels, request);
  const pickers = usePickers({
    runtime,
    clock,
    request,
    views,
    current,
    opened,
    projection,
    panel: screen.card.kind === "panel" ? screen.card.panel : undefined,
    open: (panel) => update({ card: { kind: "panel", panel } }),
    change: (next) => setScreen((s) => (s.card.kind === "panel" ? { ...s, card: { kind: "panel", panel: next(s.card.panel) } } : s)),
    close: (when) => setScreen((s) => (s.card.kind === "panel" && (when?.(s.card.panel) ?? true) ? { ...s, card: { kind: "none" } } : s)),
    say,
    ask: (asked) => update({ question: asked }),
    openSession: (next) => open(next),
    startService: (environmentId) => {
      if (views.find((view) => view.environmentId === environmentId)?.kind !== "local") return say("Start the service on that environment's machine.");
      update({ card: { kind: "none" } });
      startService();
    },
    openTool: (environmentId, run) => {
      update({ card: { kind: "none" } });
      terminal.watchTool(environmentId, run.terminal.id, run.command, paneSize, { cols: run.terminal.cols, rows: run.terminal.rows });
      setFocus("terminal");
    },
    newCommandId: props.newCommandId,
    keys,
  });
  const routines = useRoutines({
    runtime,
    clock,
    request,
    views,
    current,
    card: screen.card.kind === "routines" ? screen.card.routines : undefined,
    open: (next) => update({ card: { kind: "routines", routines: next } }),
    change: (next) => setScreen((s) => (s.card.kind === "routines" ? { ...s, card: { kind: "routines", routines: next(s.card.routines) } } : s)),
    close: () => setScreen((s) => (s.card.kind === "routines" ? { ...s, card: { kind: "none" } } : s)),
    say,
    ask: (asked) => update({ question: asked }),
    openSession: (next) => open(next),
    newCommandId: props.newCommandId,
    newRoutineId: props.newRoutineId ?? (() => crypto.randomUUID()),
    keys,
    editYaml:
      props.editRoutine ??
      ((yaml: string) => lendTerminal<ExternalEditResult>(suspendTerminal, () => editInExternalEditor(yaml, { file: ROUTINE_FILE }), { ok: false, reason: "the editor did not run" })),
    cwd,
  });
  const status = useStatus({
    runtime,
    clock,
    request,
    environment: headerView,
    badge: headerView && badges.get(headerView.environmentId),
    opened,
    projection,
    runState: session.runState,
    liveRunId: liveRun,
    steers: session.provider?.steering === true,
    containment: pickers.containment(opened),
    forkedOnto: pickers.forkedOnto(opened),
    width: size.columns,
    composerKeys: focused === "composer" && !cardOpen,
    keys,
  });

  /** Sends `message` to the open session; `remember` false keeps it out of the prompt history (preset in it). */
  const sendText = (message: { readonly text: string; readonly attachments: readonly AttachmentInput[] }, options: { readonly remember?: boolean; readonly onRefused?: () => void } = {}): boolean => {
    if (!opened) {
      say("There is no session open to send to: /resume opens one, /new starts one.");
      return false;
    }
    if (session.lock.locked) {
      say(`Not sent: ${session.lock.reason}`);
      return false;
    }
    if (gone !== undefined) {
      say(`Not sent: ${gone} is gone; /cwd chooses a workspace for the session.`);
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
    if (options.remember !== false) stores.history?.append({ text: message.text, cwd: projection?.summary?.workspace.path ?? props.flags.workspace, sessionId });
    setView((v) => ({ ...v, offset: 0 }));
    void sendMessage(runtime, environmentId, sessionId, message, live).then((outcome) => {
      if (!outcome.ok) {
        options.onRefused?.();
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

  // What a reply that comes later (`!!`'s output) acts on: this render's session and send, read when it comes.
  const latest = useRef({ opened, sendText });
  latest.current = { opened, sendText };

  const interrupt = (): boolean => {
    if (!opened || liveRun === undefined) return false;
    void interruptRun(runtime, opened.environmentId, liveRun).then((line) => line && say(line));
    return true;
  };

  // The verbs on the queue (ADR 0022; #231): read now and withdraw, as `projections.runs.session` says they stand, each drawn
  // dim with its reason when absent, never hidden. What the environment refuses is said in one line and not kept: nothing on
  // the wire says an adapter cannot withdraw, and the environment asks the adapter only for a message the provider holds.
  const queueVerb = (name: "readNow" | "withdraw"): VerbAvailability => session.runs?.verbs[name] ?? { status: "absent", reason: "no_queue", message: "Nothing is queued." };
  const queue = session.runs?.queue ?? [];
  const sayRefusal = (line: string | undefined) => {
    if (line !== undefined) say(line);
  };
  // The messages this terminal has asked to withdraw and not heard back about: ↑ again meanwhile sends nothing more.
  const withdrawing = useRef(new Set<string>());
  /** `Ctrl+Enter`: the live run interrupted and the next opened with the whole queue, or the run of the queue started. */
  const readNow = (): false | void => {
    if (!opened) return false;
    const verb = queueVerb("readNow");
    if (verb.status === "absent") return say(verb.reason === "no_queue" ? verb.message : `Not read now: ${verb.message}`);
    void readQueueNow(runtime, opened.environmentId, opened.sessionId).then(sayRefusal);
  };
  /**
   * `↑` on an empty composer: the newest queued message a withdraw can reach (the runtime's `withdrawTarget`), taken back into
   * the draft. With none to reach, ↑ is the composer's (history). While its withdraw is on its way, ↑ does nothing: walking
   * the history then would put text in the composer that the draft coming back could not replace.
   */
  const withdrawLast = (): false | void => {
    const target = session.runs?.withdrawTarget ?? null;
    if (!opened || target === null) return false;
    const verb = queueVerb("withdraw");
    if (verb.status === "absent") return say(`Not withdrawn: ${verb.message}`);
    if (withdrawing.current.has(target)) return;
    withdrawing.current.add(target);
    // What this terminal typed and cleared goes first, so a late empty draft never lands over the text coming back.
    runtime.drafts.flush();
    void withdrawQueued(runtime, opened.environmentId, target)
      .then(sayRefusal)
      .finally(() => withdrawing.current.delete(target));
  };
  const withdrawCondition = conditionOf("composer.withdrawLast");
  const queueVerbs: readonly QueueVerb[] = [
    { keys: keys("composer.readNow"), words: "read now", availability: queueVerb("readNow") },
    {
      keys: withdrawCondition === undefined ? keys("composer.withdrawLast") : `${keys("composer.withdrawLast")} (${ACTION_CONDITIONS[withdrawCondition].words})`,
      words: "take the newest back",
      availability: queueVerb("withdraw"),
    },
  ];

  // What the new-session card opens on from the composer (#334): the open session, else the environment `--environment`
  // names, else nothing in focus, ADR 0005's rule presetting the rest; with no session open, the terminal's own directory
  // (`--cwd`) is the workspace chosen on the local environment, as `/new` has always started there.
  const cardOpening = (): CardOpening => {
    if (opened) return { focus: { kind: "session", environmentId: opened.environmentId, sessionId: opened.sessionId } };
    const named = props.flags.environment === undefined ? undefined : findEnvironment(known, props.flags.environment);
    const focus: NewSessionFocus = named ? { kind: "environment", environmentId: named.environmentId } : { kind: "none" };
    if (!rememberedLocal || !localView || !isFullPath(props.flags.workspace)) return { focus };
    return { focus, chips: { workspace: { environmentId: localView.environmentId, request: { kind: "directory", path: props.flags.workspace } } } };
  };

  // `/new`: a session on the open one's environment, in its workspace (a `session` request naming it, so the environment
  // shares its workspace as it has it, #325), on its account and model; with none open, the new-session card (#334). Either
  // opens once the environment has it, so its stream is never asked for before it exists.
  const newSession = () => {
    if (!opened) return rail.newSession({ ...cardOpening(), opens: true });
    const environment = views.find((v) => v.environmentId === opened.environmentId);
    if (!environment || isPlaceholder(environment)) return say("There is no environment to start a session on: /pair one first.");
    const sessionId = props.newSessionId?.() ?? crypto.randomUUID();
    const summary = projection?.summary;
    const where = summary?.workspace.path ?? "the open session's workspace";
    say(`Starting a session on ${nameOf(environment)} in ${where}…`);
    void runtime.commands
      .startSession(environment.environmentId, {
        id: sessionId,
        workspace: { kind: "session", sessionId: opened.sessionId },
        ...(summary?.accountId && { account: summary.accountId }),
        ...(summary?.model && { model: summary.model }),
      })
      .then(({ answer }) => {
        if (!answer.ok) return say(`No session was started: ${answer.error.message}`);
        open({ environmentId: environment.environmentId, sessionId });
        say(`A new session on ${nameOf(environment)} in ${answer.result?.summary.workspace.path ?? where}.`);
      });
  };

  const attach = (path: string) => {
    void readAttachment(path, cwd).then((read) => {
      if (!read.ok) return say(`Not attached: ${read.reason}`);
      // What the session's provider cannot take is refused now, not at the send.
      const refused = attachmentRefused(read.attachment, session.provider);
      if (refused !== undefined) return say(refused);
      composer.attach(read.attachment);
      say(`Attached ${read.attachment.name}; it goes with the next message.`);
    });
  };

  /** Puts `text` on the clipboard and says so, calling it `name`: `/copy`'s and the pager's `y`. */
  const copyOut = (text: string, name: string) =>
    void clipboard.copy(text).then(
      (outcome) => say(outcome === "none" ? "Nothing here can reach a clipboard." : `Copied ${name}.`),
      (error: unknown) => say(`Not copied: ${messageOf(error)}`),
    );

  const copy = (block: number | null) => {
    const reply = projection ? lastReply(projection) : undefined;
    if (!reply) return say("There is no reply to copy yet.");
    const text = block === null ? reply.text : codeBlocks(reply.text)[block - 1];
    if (text === undefined) return say(`The last reply has no code block ${block}.`);
    copyOut(text, block === null ? "the last reply" : `code block ${block}`);
  };

  const exportTo = (file: string | null) => {
    if (!projection || !opened) return say("There is no session open to export.");
    const name = file ?? `${opened.sessionId.slice(0, 8)}.md`;
    const path = resolve(cwd, expandHome(name, homedir()));
    const text = exportMarkdown(projection, {
      environment: names.get(opened.environmentId) ?? "",
      at: clock.now(),
      ...(session.forkedFrom !== undefined && { forked: session.forkedFrom }),
    });
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

  const noSession = () => say("There is no session open: /resume opens one, /new starts one.");

  /** `/terminal`: the open session's terminal in the pane, opened or reopened, with the keys. */
  const openTerminal = () => {
    if (!opened) return noSession();
    if (!hearsKeys) return say(`No terminal: ${DEAF}`);
    if (terminal.open(opened, paneSize)) setFocus("terminal");
  };

  /**
   * A shell line (#148): `!` runs the command in a terminal of its own, shown in the pane, the composer keeping the keys;
   * `!!` runs it in a terminal of its own and sends what it printed to the agent. True when the box empties.
   */
  const runShellLine = (shell: { readonly send: boolean; readonly command: string }): boolean => {
    if (shell.command.length === 0) {
      say(shell.send ? "Usage: !!<command> runs it on the session's environment and sends what it printed to the agent." : "Usage: !<command> runs it in the session's terminal.");
      return false;
    }
    if (!opened) {
      noSession();
      return false;
    }
    const target = opened;
    const record = () =>
      stores.history?.append({ text: `${shell.send ? "!!" : "!"}${shell.command}`, cwd: projection?.summary?.workspace.path ?? props.flags.workspace, sessionId: target.sessionId });
    if (!shell.send) {
      if (!hearsKeys) {
        say(`Not run: ${DEAF}`);
        return false;
      }
      const ran = terminal.run(target, paneSize, shell.command);
      if (ran) record();
      return ran;
    }
    const capability = runtime.capability(target.environmentId, "terminals.open");
    if (capability.status === "absent") {
      say(`Not run: ${capability.message}`);
      return false;
    }
    if (session.lock.locked) {
      say(`Not run: what it printed could not be sent. ${session.lock.reason}`);
      return false;
    }
    record();
    const running = `Running ${shell.command} on ${names.get(target.environmentId) ?? "the environment"}…`;
    say(running);
    void runOneOff({ runtime, clock, newCommandId: props.newCommandId, newTerminalId: terminal.oneOffId, screens: createScreen }, target, shell.command).then((result) => {
      if (quit.signal.aborted) return;
      if (!result.ok) return say(`Not run: ${result.line}`);
      // Up to a minute later: the session open now, and the send that knows it, not this render's.
      const now = latest.current;
      if (now.opened?.environmentId !== target.environmentId || now.opened.sessionId !== target.sessionId) {
        return say(`The output of ${shell.command} was not sent: its session is no longer open.`);
      }
      // The line it said goes, and only it: another said meanwhile stays.
      setScreen((s) => (s.line === running ? { ...s, line: undefined } : s));
      // The prompt history holds the line typed (`record`), not the message it became.
      now.sendText({ text: oneOffMessage(shell.command, result), attachments: [] }, { remember: false });
    });
    return true;
  };

  // A page asked for (a file, a diff): only the last one asked opens or says why not, so a slow answer never covers a later one.
  // It opens only over the very card it was asked from (none, the files): a card the user opened while it was read (the
  // help, a picker, the pager), or one opened and closed again, is never covered, and the page is let go with its line.
  // `directory`: the card to open instead when the path named a directory.
  const pages = useRef(0);
  const showPage = (loading: string, make: () => Promise<Paged>, back: Card, directory?: Card) => {
    const asked = ++pages.current;
    let over: Card | undefined;
    setScreen((s) => {
      over = s.card;
      return { ...s, line: loading };
    });
    const open = (card: Card, line: string | undefined) =>
      setScreen((s) => (s.card === over ? { ...s, line, card } : s.line === loading ? { ...s, line: undefined } : s));
    void make().then(
      (paged) => {
        if (pages.current !== asked || quit.signal.aborted) return;
        if (!paged.ok) return paged.directory === true && directory ? open(directory, undefined) : say(paged.line);
        const { title, lines, copy } = paged.page;
        open({ kind: "page", title, lines, ...(copy !== undefined && { copy }), top: 0, query: "", typing: false, back }, paged.note);
      },
      (error: unknown) => {
        if (pages.current === asked && !quit.signal.aborted) say(messageOf(error));
      },
    );
  };
  const diffFilter = (columns: number) => (props.diffFilter ?? systemDiffFilter)(columns);

  /** `/files [path]`: the workspace's listing as a picker, or the file `path` names read in the pager. */
  const openFiles = (path: string | null) => {
    if (!opened) return noSession();
    const capability = runtime.capability(opened.environmentId, "files.list");
    if (capability.status === "absent") return say(`No files: ${capability.message}`);
    if (path === null) return update({ card: { kind: "files", dir: "", cursor: 0, filter: "" } });
    const wanted = typedPath(path, projection?.summary?.workspace.path ?? "");
    if (wanted === null) return say(outsideWorkspace(path));
    if (wanted === "") return update({ card: { kind: "files", dir: "", cursor: 0, filter: "" } });
    const target = opened;
    showPage(`Reading ${wanted}…`, () => readFile(runtime, target, wanted, mainWidth), { kind: "files", dir: directoryOf(wanted), cursor: 0, filter: "" }, {
      kind: "files",
      dir: wanted,
      cursor: 0,
      filter: "",
    });
  };

  /** `/diff`: what the session changed and the working tree, through the user's diff filter. */
  const showDiff = () => {
    if (!opened) return noSession();
    const capability = runtime.capability(opened.environmentId, "diffs.session");
    if (capability.status === "absent") return say(`No diff: ${capability.message}`);
    const target = opened;
    const filter = diffFilter(mainWidth);
    showPage(filter ? `Reading the diff, through ${filter.label}…` : "Reading the diff…", () => sessionDiff(runtime, target, mainWidth, filter), { kind: "none" });
  };

  /** Ctrl+O in the pane: the terminal's retained scrollback in the pager, at its end. */
  const openScrollback = () => {
    const lines = terminal.history().map((spans, index): TranscriptLine => ({ row: `scrollback:${index}`, spans }));
    const where = terminal.pane ? (names.get(terminal.pane.environmentId) ?? "") : "";
    // A snapshot the scrollback's cap had cut: what came before it is gone from the environment too.
    const dropped = terminal.earlierDropped() ? " · earlier output dropped" : "";
    update({ card: { kind: "page", title: `Terminal scrollback · ${where}${dropped}`, lines, top: null, query: "", typing: false, back: { kind: "none" } } });
  };

  /** The composer's Enter: a command the terminal answers, or a message for the agent. True when the box empties. */
  const submit = (raw: string, message: { readonly text: string; readonly attachments: readonly AttachmentInput[] }): boolean => {
    const command = parseCommand(raw);
    switch (command.kind) {
      case "check": {
        if (!opened) { say("Open a Session to configure its Workspace check."); return true; }
        const { environmentId, sessionId } = opened;
        const available = runtime.capability(environmentId, "checks.get");
        if (available.status === "absent") { say(checkWords.labelled(available.message)); return true; }
        if (command.action === "get") {
          void runtime.checks.get(environmentId, sessionId).then(async (answer) => {
            runtime.requests.refresh(environmentId, "checks.get", { sessionId });
            if (!answer.ok) { say(checkWords.labelled(answer.error.message)); return; }
            let imported: string | undefined;
            if (answer.result.command === null && props.stateDir !== undefined && viewOf(environmentId)?.kind === "local") {
              try {
                const stored = await jsonDocuments(join(props.stateDir, "documents")).get(AFTER_EDIT_DOCUMENT);
                if (typeof stored === "object" && stored !== null && Object.hasOwn(stored, answer.result.workspace)) {
                  const text: unknown = (stored as Record<string, unknown>)[answer.result.workspace];
                  if (typeof text === "string") imported = text;
                }
              } catch { /* An unreadable local import enables nothing. */ }
            }
            say(answer.result.command === null ? `${checkWords.offFor(answer.result.workspace)}${imported === undefined ? "" : ` Imported (inert): ${imported}; save explicitly with /check <command>.`}` : checkWords.command(answer.result.command));
          });
        } else if (command.action === "now") {
          void runtime.checks.run(environmentId, sessionId).then((answer) => {
            const error = !answer.ok ? answer.error : answer.result.receipt.status === "rejected" ? answer.result.receipt.error : undefined;
            say(error === undefined ? checkWords.running : `${error.data?.["reason"] ?? error.code}: ${error.message}`);
          });
        } else {
          void runtime.checks.set(environmentId, sessionId, command.action === "set" ? command.command : null).then((answer) => say(!answer.ok ? answer.error.message : answer.result.receipt.status === "rejected" ? answer.result.receipt.error.message : command.action === "off" ? `${checkWords.off}.` : checkWords.saved));
        }
        return true;
      }
      case "trust": {
        if (!opened) {
          say("Cannot decide repository trust: no session is open.");
          return true;
        }
        const capability = runtime.capability(opened.environmentId, "trust.decide");
        if (capability.status === "absent") {
          say(`Cannot decide repository trust: ${capability.message}`);
          return true;
        }
        void runtime.requests.call(opened.environmentId, "trust.decide", {
          commandId: props.newCommandId(), sessionId: opened.sessionId, decision: command.decision,
        }).then((answer) => {
          const refused = !answer.ok ? answer.error.message : answer.result.receipt.status === "rejected" ? answer.result.receipt.error.message : undefined;
          say(refused === undefined ? `Repository trust set to ${command.decision}.` : `Cannot decide repository trust: ${refused}`);
        });
        return true;
      }
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
      case "environment-look":
        changeLook(headerView, command.field, command.value);
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
      case "browser":
        if (opened === null) noSession();
        else update({ card: { kind: "picker", picker: sessionBrowserPicker(runtime, opened.environmentId, opened.sessionId, say) } });
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
        // "Saved" is said now, before the file is written (#262): the in-memory
        // store is what this run expands from, and a person should not wait on a
        // rename. A write that fails replaces this line with one saying so
        // (`snippetsFailed` where the stores load), so "Saved" is never the last word on a lost snippet.
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
        update({ card: { kind: "notices", cursor: 0 } });
        return true;
      case "export":
        exportTo(command.file);
        return true;
      case "quit":
        quitNow();
        return true;
      case "terminal":
        openTerminal();
        return true;
      case "files":
        openFiles(command.path);
        return true;
      case "file-undo":
        if (!opened) {
          noSession();
          return false;
        }
        void undoFile(runtime, clock, opened.environmentId, opened.sessionId).then((answer) => say(answer.line));
        return false;
      case "diff":
        showDiff();
        return true;
      case "documents":
        if (!opened) noSession();
        else update({ card: { kind: "documents", cursor: 0 } });
        return true;
      case "picker":
        pickers.run(command.command);
        return true;
      case "routines":
        routines.run(command.command);
        return true;
      case "rewind":
        forkRewind.rewindBack(command.back);
        return true;
      case "rewind-undo":
        forkRewind.undo();
        return true;
      case "fork":
        forkRewind.forkBack(command.back);
        return true;
      case "not-here":
      case "usage":
        say(command.line);
        return true;
      case "text": {
        const shell = shellLine(command.text);
        return shell ? runShellLine(shell) : sendText(message);
      }
    }
  };

  const quitNow = () => {
    runtime.drafts.flush();
    quit.abort();
    exit();
  };

  const viewOf = (environmentId: string): EnvironmentView | undefined => views.find((v) => v.environmentId === environmentId);

  // The update of the environment whose card is open (#827): its `updates.status`, followed while the card is open, which
  // the request cache reads again on each update notice.
  const cardEnvironmentId = screen.card.kind === "menu" ? screen.card.environmentId : undefined;
  const cardStatus = useMemo(
    () => (cardEnvironmentId !== undefined ? runtime.requests.cached(cardEnvironmentId, "updates.status", {}) : undefined),
    [runtime, cardEnvironmentId],
  );
  useFollow(cardStatus, request);
  const cardView = cardEnvironmentId !== undefined ? viewOf(cardEnvironmentId) : undefined;
  const cardUpdate = cardView ? updateCard(cardView, cardStatus?.read(), props.version, clock.now()) : undefined;
  const cardActions = cardView && cardUpdate ? actionsFor(cardView, cardUpdate) : [];

  // Drain and update now's question and the update it asks about (#878): it goes, unanswered, once the card no longer
  // shows that update waiting on work (it went, was replaced or withdrawn, or the card closed), and the work coming
  // back does not bring it back.
  const drainAsked = useRef<{ readonly question: Question; readonly updateId: string } | undefined>(undefined);
  const cardDrainableId = cardUpdate?.drainable?.updateId;
  useEffect(() => {
    const asked = drainAsked.current;
    if (asked === undefined || asked.updateId === cardDrainableId) return;
    drainAsked.current = undefined;
    setScreen((s) => (s.question === asked.question ? { ...s, question: undefined } : s));
  }, [cardDrainableId]);

  /** Drain and update now (#878): asked once on the confirm line, unless the connection cannot send it; a yes sends `updates.apply` now. */
  const drainAndUpdate = (environment: EnvironmentView) => {
    const drainable = cardUpdate?.drainable;
    if (!drainable) return;
    const refusal = updateRefusal(runtime, environment);
    if (refusal !== undefined) return say(refusal);
    const question: Question = { text: drainAndUpdateQuestionLine(environment, drainable), yes: () => void updateNow(runtime, environment, props.newCommandId(), "now").then(say) };
    drainAsked.current = { question, updateId: drainable.updateId };
    update({ question });
  };

  const presentation = useMemo(() => props.presentation ?? inMemoryPresentation(), [props.presentation]);
  const rail = useRail({
    runtime,
    views,
    colours,
    keymap,
    presentation,
    startingService,
    opening: cardOpening,
    workspace: props.flags.workspace,
    // The slash forms act on the open session first.
    inHand: opened ?? undefined,
    ...(props.newSessionId && { newId: props.newSessionId }),
    say,
    ask: (asked) => update({ question: asked }),
    asked: screen.question !== undefined,
    open: (picker) => update({ card: { kind: "picker", picker } }),
    // The card is closed only while it still shows that picker, as typed at and moved since: its rows name it.
    close: (picker) => setScreen((s) => (s.card.kind === "picker" && s.card.picker.rows === picker.rows ? { ...s, card: { kind: "none" } } : s)),
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

  /**
   * `/environment rename|icon|colour` and the card's Rename, Icon and Colour
   * (#327): refused with the capability's line when the connection cannot
   * send it (no `admin`), a value typed checked and sent, and bare, its
   * picker opened.
   */
  const changeLook = (environment: EnvironmentView | undefined, field: LookField, typed: string | null) => {
    if (!environment) return say("There is no environment to change: /pair one first.");
    const refusal = lookRefusal(runtime, environment, field);
    if (refusal !== undefined) return say(refusal);
    if (typed === null) return update({ card: { kind: "picker", picker: lookPicker({ runtime, say, newCommandId: props.newCommandId }, environment, field) } });
    const checked = lookChange(field, typed);
    if (!checked.ok) return say(checked.line);
    void setLook(runtime, environment, checked.change, props.newCommandId()).then(say);
  };

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

  /** The prompt picker's cursor: on the newest user message until a key moved it. */
  const pickerCursor = (card: Extract<Card, { kind: "prompt-picker" }>): number => clampCursor(card.cursor ?? messages.length - 1, messages.length);
  const choose = (card: Card) => {
    if (card.kind === "panel") return pickers.choose(card.panel);
    if (card.kind === "routines") return routines.choose(card.routines);
    if (card.kind === "prompt-picker") {
      // Enter rewinds here: the card closes, and the rewind (or the offer to stop the run first) is the line's.
      const message = messages[pickerCursor(card)];
      update({ card: { kind: "none" } });
      if (message) forkRewind.rewind(message);
      return;
    }
    if (card.kind === "picker") {
      const row = rowAt(card.picker);
      if (!row) return;
      if (row.absent !== undefined) return say(`${row.text}: ${row.absent}.`);
      // A step on opens the next picker, which goes back to this one as it stands, the choice highlighted; a row
      // that is done closes the card; one that waits on an answer leaves it as it is.
      const next = row.choose?.();
      if (next === STAYS) return;
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
      const action = cardActions[clampCursor(card.cursor, cardActions.length)];
      if (action === "sessions") return openClientSessions(environment);
      if (action === "name" || action === "icon" || action === "colour") return changeLook(environment, action, null);
      if (action === "update") return void updateNow(runtime, environment, props.newCommandId()).then(say);
      if (action === "drain-and-update") return drainAndUpdate(environment);
      if (action === "update-to-client") return void updateToClient(runtime, environment).then(say);
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
    if (card.kind === "files") {
      const found = fileRows(card) ?? [];
      const row = found[clampCursor(card.cursor, found.length)];
      if (!row || !opened) return;
      if (row.kind !== "file") return update({ card: { ...card, dir: row.path, cursor: 0, filter: "" } });
      const target = opened;
      showPage(`Reading ${row.path}…`, () => readFile(runtime, target, row.path, mainWidth), card);
      return;
    }
    if (card.kind === "documents") {
      const document = documentRows[clampCursor(card.cursor, documentRows.length)];
      if (!document || !opened) return;
      // A page or an SVG is the desktop window's preview's alone: said in one line, never read.
      const preview = previewLine(document, projection?.summary?.workspace.path ?? null);
      if (preview !== null) return say(preview);
      const capability = runtime.capability(opened.environmentId, "files.read");
      if (capability.status === "absent") return say(`Not read: ${capability.message}`);
      const target = opened;
      showPage(`Reading ${document.path}…`, () => readFile(runtime, target, document.path, mainWidth), card);
      return;
    }
    if (card.kind === "notices") {
      const notice = newestFirst[clampCursor(card.cursor, newestFirst.length)];
      if (!notice) return;
      if (!notice.about) return say("That notice is about no session: there is nothing to open.");
      update({ card: { kind: "none" } });
      open({ environmentId: notice.environmentId, sessionId: notice.about.sessionId });
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
      case "page":
        return card.back;
      case "panel": {
        const to = pickers.back(card.panel);
        return to ? { kind: "panel", panel: to } : { kind: "none" };
      }
      case "routines": {
        const to = routines.back(card.routines);
        return to ? { kind: "routines", routines: to } : { kind: "none" };
      }
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
      case "menu":
        return cardActions.length;
      case "client-sessions":
        return card.rows?.length ?? 0;
      case "sessions":
        return sessionRows(card.filter).length;
      case "snippets":
        return snippetRows().length;
      case "files":
        return fileRows(card)?.length ?? 0;
      case "documents":
        return documentRows.length;
      case "notices":
        return notices.length;
      case "prompt-picker":
        return messages.length;
      case "panel":
        return pickers.rows(card.panel);
      case "routines":
        return routines.rows(card.routines);
      case "picker":
        return card.picker.rows(card.picker.query).length;
      default:
        return 0;
    }
  };

  // The help overlay's body, and the pager's: the frame less the header, the three lines, the composer and the status line
  // under the card, and the card's title and foot.
  const helpHeight = Math.max(1, size.rows - 9 - setupSummaryRows - checkSummaryRows);
  const helpMaxTop = Math.max(0, help.length - helpHeight);
  // A taller terminal, or a shorter map after `/reload`, leaves less to scroll: the overlay's place is clamped to it.
  useEffect(() => {
    setScreen((s) => (s.card.kind === "help" && s.card.top > helpMaxTop ? { ...s, card: { ...s.card, top: helpMaxTop } } : s));
  }, [helpMaxTop]);

  // The pager's lines: every row unfolded; `/tasks`, `/timeline` and run info as lines too.
  const card = screen.card;
  const pagerLines = card.kind === "pager" ? transcriptLines(allRows, { ...lineContext, width: mainWidth, expanded: true }) : card.kind === "page" ? card.lines : [];
  const cardLines: TranscriptLine[] =
    card.kind === "lines"
      ? card.which === "run-info"
        ? runInfoLines(projection, runInfoAccounts?.read().value, runInfoModels?.read().value, mainWidth)
        : card.which === "timeline"
          ? (projection ? turnsOf(projection) : []).map((turn) => ({ row: turn.runId, spans: [{ text: timelineLine(turn) }] }))
          : tasksLines(projection)
      : [];
  const runInfoMaxTop = Math.max(0, cardLines.length - helpHeight);
  useEffect(() => {
    setScreen((s) => s.card.kind === "lines" && s.card.which === "run-info" && s.card.top > runInfoMaxTop
      ? { ...s, card: { ...s.card, top: runInfoMaxTop } }
      : s);
  }, [runInfoMaxTop]);
  // The asks card's rows: what `/asks` gathered, less what was answered from here.
  const askList = card.kind === "asks" ? askRows(asks, views, opened, colours) : [];
  const askAt = card.kind === "asks" ? askList[clampCursor(card.cursor, askList.length)] : undefined;
  const bulk = bulkAsks(askList.map((row) => row.ask));
  /** `y` or `n` on the row under the cursor: a permission or denylist prompt answered in place; any other is opened to answer. */
  const decideInPlace = (decision: "allow" | "deny"): false | void => {
    if (!askAt) return false;
    if (!decidable(askAt.ask.kind)) return say(`This one is answered on its own card: ${keys("asks.open")} opens it.`);
    answers.answer(askAt.ask, { decision });
  };
  /** `a` or `N`: every permission row answered at once, once confirmed, and only when there are two or more. */
  const decideAll = (decision: "allow" | "deny"): false | void => {
    if (card.kind !== "asks" || bulk.length === 0) return false;
    update({
      question: {
        text: `${bulkQuestion(decision, bulk.length)} y/n`,
        yes: () => bulk.forEach((target) => answers.answer(target, { decision })),
      },
    });
  };
  const pagerMaxTop = Math.max(0, pagerLines.length - helpHeight);
  const pagerTop = paged(card) ? Math.min(card.top ?? pagerMaxTop, pagerMaxTop) : 0;
  const pagerMatches = paged(card) && card.query.length > 0 ? pagerLines.flatMap((line, index) => (lineText(line).toLowerCase().includes(card.query.toLowerCase()) ? [index] : [])) : [];
  const pagerTurns = card.kind === "pager" ? pagerLines.flatMap((line, index) => (line.row.startsWith("message:") && pagerLines[index - 1]?.row !== line.row ? [index] : [])) : [];

  // The press before this one, where and when it was heard: keys pressed in turn (`Esc Esc`, `\ Enter`) start with it (`pressedBefore`).
  const lastPress = useRef<Press | undefined>(undefined);
  // The second of two Escs heard in one read, held for the render after the first's: heard there, in the place the first left.
  const pairedEscHeld = useRef<InkKey | undefined>(undefined);
  const [, drawForPairedEsc] = useState(0);

  // The pane has the keys while it has the focus and no card is open (#148). Every key is heard as the bytes the terminal
  // sent (`paneKey`), and while the pane has the keys the screen's own handler below is not active: the pane takes each key
  // but for its two actions. `terminal.leave` goes on to the next stop, where Tab would have gone had the shell not had
  // it, and `terminal.scrollback` opens the scrollback.
  const paneHasKeys = focused === "terminal" && paneOpen && !cardOpen;
  const paneKeys = useRef(false);
  paneKeys.current = paneHasKeys;
  // When the pane was left with `terminal.leave`: the leave key again within `LEAVE_TWICE_MS` goes to the shell and the
  // pane has the keys back. Left in the read being heard, the screen's handler below is not listening until the next
  // frame, so the leave key again in that read (Ink's next key, or the same text) is heard here.
  const leftAt = useRef<number | null>(null);
  const leftInRead = useRef(false);
  useEffect(() => {
    leftInRead.current = false;
    terminal.focus(paneHasKeys);
  }, [paneHasKeys]);
  // Somebody is here, whether the key went to the screen or the shell: both bells wait again. Past three minutes of
  // stillness the key is a return, answered with what happened meanwhile.
  const present = () => {
    const recap = attention.touch();
    if (recap !== undefined) flash(recap, RECAP_FLASH_MS);
  };
  const heldBytes = (action: "terminal.leave" | "terminal.scrollback") => keymap.keys[action].flatMap((name) => keyBytes(name) ?? []);
  const heldBy = (action: "terminal.leave" | "terminal.scrollback", bytes: string) => heldBytes(action).includes(bytes);
  const paneTakes = (bytes: string) => {
    if (!paneKeys.current) {
      if (!leftInRead.current || !heldBy("terminal.leave", bytes)) return;
      leftInRead.current = false;
      leftAt.current = null;
      paneKeys.current = true;
      setFocus("terminal");
      present();
      terminal.key(bytes);
      return;
    }
    scheduler.bypass();
    present();
    if (heldBy("terminal.leave", bytes)) {
      // The keys go at once: what comes before the next frame is not the pane's, but the leave key again.
      paneKeys.current = false;
      leftInRead.current = true;
      leftAt.current = clock.now().getTime();
      setFocus(nextFocus("terminal", stops));
      return;
    }
    if (heldBy("terminal.scrollback", bytes)) return openScrollback();
    terminal.key(bytes);
  };
  paneKey.current = (bytes) => {
    if (!paneKeys.current && !leftInRead.current) return;
    for (const piece of heldApart(bytes, [...heldBytes("terminal.leave"), ...heldBytes("terminal.scrollback")])) paneTakes(piece);
  };
  usePaste(
    (text) => {
      scheduler.bypass();
      present();
      terminal.paste(text);
    },
    { isActive: paneHasKeys },
  );

  usePaste(
    (text) => {
      scheduler.bypass();
      attention.touch();
      composer.paste(text);
    },
    { isActive: focused === "composer" && !cardOpen },
  );
  // The routines card taking a line (a path, an endpoint's name, URL or secret) takes a paste into it, as a panel does.
  const routinesTyping = card.kind === "routines" && routines.takesText(card.routines) && !screen.question;
  usePaste(
    (text) => {
      scheduler.bypass();
      setScreen((s) => (s.card.kind === "routines" ? { ...s, card: { kind: "routines", routines: routines.typed(s.card.routines, text) } } : s));
    },
    { isActive: routinesTyping },
  );
  // A card taking a line (a label, a sign-in's code, a setting's value) takes a paste into it, unless a question has the keys.
  const panelTyping = card.kind === "panel" && pickers.takesText(card.panel) && !screen.question;
  usePaste(
    (text) => {
      scheduler.bypass();
      setScreen((s) => (s.card.kind === "panel" ? { ...s, card: { kind: "panel", panel: pickers.typed(s.card.panel, text) } } : s));
    },
    { isActive: panelTyping },
  );

  // Each key Ink hears; `pairedEsc` for the second of two Escs heard in one read, which is `Esc Esc` in the same place.
  const hear = (input: string, key: InkKey, pairedEsc = false) => {
    // The pane took the keys back earlier in this read (the leave key pressed again): the rest of the read is the shell's,
    // heard by `paneKey` first, and this handler, not yet inactive until the frame, leaves it alone.
    if (paneKeys.current) return;
    // Two Escs in one read (a fast double tap, SSH, or tmux, whose escape-time sends them together): Ink 7 reads `\x1b\x1b`
    // as one Esc with Meta, its input the second byte. They are heard in turn: the single Esc's meaning now, then the second
    // once that is drawn (this render's state is from before the first), as `Esc Esc` only, never a single Esc again, so
    // nothing is denied or interrupted twice.
    if (key.escape && key.meta && (input === "" || input === "\u001B") && !pairedEsc) {
      const single: InkKey = { ...key, meta: false };
      hear("", single);
      pairedEscHeld.current = single;
      drawForPairedEsc((n) => n + 1);
      return;
    }
    const justLeft = leftAt.current !== null && clock.now().getTime() - leftAt.current <= LEAVE_TWICE_MS;
    leftAt.current = null;
    // A key draws what the scheduler holds back, with its own echo.
    scheduler.bypass();
    // First, so a key with a line of its own has the last word.
    present();
    const name = eventName(input, key);
    // Where the keys are: the same key pressed again elsewhere (an Esc that closed a card, answered a question, left the
    // transcript or a search) starts nothing with this one.
    const place = placeOf(card.kind, promptShown && "prompt", question !== undefined && "question", focused, composer.searching && "search");
    const heardAt = clock.now().getTime();
    const previous = pressedBefore(lastPress.current, name, heardAt, place);
    // Text arriving in one read (a fast typist, a terminal that batches) ends on its last character: `one\` then Enter is `\ Enter`.
    const last = name ?? (input.length > 0 && !key.ctrl && !key.meta ? [...input].at(-1) : undefined);
    lastPress.current = last === undefined ? undefined : { name: last, at: heardAt, place };
    // The second of two Escs in one read after a first that closed a card, answered a question, left the transcript or closed
    // the search: dropped, as the same-place rule makes it no `Esc Esc` and it is never a single Esc.
    if (pairedEsc && previous === undefined) return;
    const linesPanel = card.kind === "panel" && pickers.isLines(card.panel);
    const listCard =
      card.kind === "environments" ||
      card.kind === "menu" ||
      card.kind === "client-sessions" ||
      card.kind === "sessions" ||
      card.kind === "snippets" ||
      card.kind === "files" ||
      card.kind === "documents" ||
      card.kind === "notices" ||
      card.kind === "picker" ||
      card.kind === "prompt-picker" ||
      card.kind === "routines" ||
      (card.kind === "panel" && !linesPanel);
    // A list, the help overlay, the pager (the transcript's or a page's) and the lines cards have the keys whatever has the focus; the focus has them back when it closes.
    const cardHasKeys = listCard || linesPanel || card.kind === "help" || paged(card) || card.kind === "lines" || card.kind === "asks" || promptShown;
    const composerHasKeys = focused === "composer" && !cardHasKeys;
    const composerText = composer.state.editor.text;
    const scrollCard = (to: (top: number) => number, max: number): false | void => {
      if (card.kind === "help") return update({ card: { ...card, top: Math.min(Math.max(to(Math.min(card.top, helpMaxTop)), 0), helpMaxTop) } });
      if (paged(card)) return update({ card: { ...card, top: Math.min(Math.max(to(pagerTop), 0), max) } });
      if (card.kind === "lines") return update({ card: { ...card, top: Math.min(Math.max(to(card.top), 0), Math.max(0, cardLines.length - helpHeight)) } });
      if (card.kind === "panel" && linesPanel) return update({ card: { kind: "panel", panel: pickers.scroll(card.panel, to) } });
      return false;
    };
    const scroll = (to: (top: number) => number): false | void => scrollCard(to, pagerMaxTop);
    const move = (action: "picker.move" | "picker.moveVi") => (pressed: string) => {
      const step = direction(keymap, action, pressed);
      if (card.kind === "help" || card.kind === "lines" || linesPanel) return scroll((top) => top + step);
      if (!listCard) return false;
      if (card.kind === "panel") return update({ card: { kind: "panel", panel: pickers.move(card.panel, step) } });
      if (card.kind === "routines") return update({ card: { kind: "routines", routines: routines.move(card.routines, step) } });
      // A list typed at takes letters into its filter or query: k and j are letters there. A typed picker's letters
      // never reach here (its intake runs before any lookup, below), so the decline states the rule as the sessions one does.
      if (action === "picker.moveVi" && (card.kind === "sessions" || card.kind === "files" || (card.kind === "picker" && card.picker.typed))) return false;
      if (card.kind === "picker") return update({ card: { kind: "picker", picker: movedBy(card.picker, step) } });
      if (card.kind === "prompt-picker") return update({ card: { ...card, cursor: clampCursor(pickerCursor(card) + step, messages.length) } });
      update({ card: { ...card, cursor: clampCursor(card.cursor + step, rowsOf(card)) } });
    };
    const onRow = (): Row | undefined => (transcriptFocused ? cursorRow : undefined);
    // Every key the screen answers, by action: the key is looked up in the keymap in force, never matched here.
    const handlers: Record<ScreenKey, Handler> & typeof composer.handlers = {
      ...composer.handlers,
      "app.runInfo.toggle": () => {
        if (card.kind === "lines" && card.which === "run-info") return update({ card: { kind: "none" } });
        if (!projection) return say("No session is open.");
        update({ card: { kind: "lines", which: "run-info", top: 0 } });
      },
      "app.mode.step": () => pickers.stepMode(),
      "app.handoff": () => pickers.run({ name: "handoff", argument: "" }),
      ...rail.handlers,
      ...routines.handlers,
      "picker.preview": () => {
        if (card.kind !== "panel" || card.panel.kind !== "setup") return false;
        return update({ card: { kind: "panel", panel: pickers.nextSetupAction(card.panel, 1) } });
      },
      "app.focus.next": () => (card.kind === "none" ? setFocus(nextFocus(focused, stops)) : false),
      "delegated.enter": () => (tasks.length > 0 ? setFocus("delegated") : false),
      "delegated.move": (pressed) => {
        const row = tasks[Math.min(Math.max(delegatedAt + direction(keymap, "delegated.move", pressed), 0), tasks.length - 1)];
        if (row) setDelegatedCursor(row.task.taskId);
      },
      "delegated.leave": () => setFocus("composer"),
      "delegated.stop": () => {
        if (!opened || !delegatedTask) return false;
        const target = opened;
        void stopCall(runtime, target.environmentId, delegatedTask.runId, delegatedTask.task.taskId).then((line) => {
          if (quit.signal.aborted || latest.current.opened?.environmentId !== target.environmentId || latest.current.opened.sessionId !== target.sessionId) return;
          if (line) say(oneLine(line, 300));
        });
      },
      "delegated.open": () => {
        if (!opened || !delegatedTask) return false;
        if (delegatedTask.agentId === null) return say("That task is not an agent: it has no transcript to read.");
        const target = opened;
        const reading: Extract<Card, { readonly kind: "page" }> = {
          kind: "page",
          title: `${delegatedTask.task.subagentType ?? delegatedTask.task.kind}: ${oneLine(delegatedTask.task.description, 120)}`,
          lines: [{ row: "reading", spans: [{ text: "Reading…", dim: true }] }],
          top: 0,
          query: "",
          typing: false,
          back: { kind: "none" },
        };
        update({ card: reading, line: undefined });
        void runtime.requests.call(target.environmentId, "sessions.subagentTranscript", { sessionId: target.sessionId, agentId: delegatedTask.agentId }).then((answer) => {
          if (quit.signal.aborted || latest.current.opened?.environmentId !== target.environmentId || latest.current.opened.sessionId !== target.sessionId) return;
          const rows = answer.ok ? subagentRows(answer.result.messages) : [];
          const lines = transcriptLines(rows, { width: mainWidth, quietMs: () => 0, stopKey: keys("row.stop"), unfoldKey: keys("row.unfold"), expanded: true });
          // Paging or searching preserves the loading lines; closing the page replaces them, declining a late answer.
          setScreen((s) => {
            if (s.card.kind !== "page" || s.card.lines !== reading.lines) return s;
            if (!answer.ok) return { ...s, card: reading.back, line: `Not read: ${oneLine(answer.error.message, 300)}` };
            return {
              ...s,
              card: { ...s.card, lines: lines.length > 0 ? lines : [{ row: "empty", spans: [{ text: "Nothing is stored for this agent yet.", dim: true }] }] },
            };
          });
        });
      },
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
        // Ctrl+O closes the page it opened (the pane's scrollback) as it closes the pager.
        if (card.kind === "page") return update({ card: card.back });
        if (!projection) return false;
        if (card.kind === "pager") return update({ card: { kind: "none" } });
        update({ card: { kind: "pager", top: null, query: "", typing: false } });
      },
      "app.help": () => {
        if (card.kind === "help") return update({ card: card.under });
        // The help map: from an empty composer; with text there it is a character like any other. With the
        // focus in the rail or the transcript nothing is being typed, so it is the map.
        if (composerText !== "" && composerHasKeys) return false;
        // A list typed at takes `?` into its filter.
        if ((paged(card) && card.typing) || card.kind === "sessions" || card.kind === "files") return false;
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
        if ((card.kind === "sessions" || card.kind === "files") && card.filter.length > 0) return update({ card: { ...card, filter: "", cursor: 0 } });
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
      "row.checkFailure.send": () => {
        const row = onRow();
        if (row?.kind !== "check" || row.entry.terminalId !== checkView?.offer?.terminalId) return false;
        return sendCheckFailure() ? undefined : false;
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
      "row.open": () => {
        const row = onRow();
        if (!row || !opened) return false;
        // A fork's first row opens the session it was forked from (#390).
        if (row.kind === "forked") return open({ environmentId: opened.environmentId, sessionId: row.entry.fromSessionId });
        const file = rowFile(row);
        if (!file) return say("That row names no file.");
        const workspace = projection?.summary?.workspace.path ?? "";
        // On this machine the file is the user's own, in their editor; elsewhere it is read in the pager.
        if (viewOf(opened.environmentId)?.kind === "local") {
          const path = isAbsolute(file.path) ? file.path : join(workspace, file.path);
          const openFile =
            props.openFile ?? ((f: OpenedFile) => lendTerminal<OpenedResult>(suspendTerminal, () => openInExternalEditor(f), { ok: false, reason: "the editor did not run" }));
          void openFile({ path, ...(file.line !== undefined && { line: file.line }) }).then((result) => result.ok || say(`Could not open ${path}: ${result.reason}`));
          return;
        }
        const relative = inWorkspace(file.path, workspace);
        if (relative === null) return say(`${file.path} is outside the session's workspace, which the environment reads files from.`);
        const target = opened;
        showPage(`Reading ${relative}…`, () => readFile(runtime, target, relative, mainWidth), { kind: "none" });
      },
      "row.diff": () => {
        const row = onRow();
        if (!row || !opened) return false;
        const calls = editCalls(row);
        if (calls.length === 0) return say("That row changed no file.");
        const target = opened;
        const filter = diffFilter(mainWidth);
        showPage(filter ? `Reading the diff, through ${filter.label}…` : "Reading the diff…", () => rowDiff(runtime, target, calls, mainWidth, filter), { kind: "none" });
      },
      // Pressed again right after it left the pane: the key goes to the shell, and the pane has the keys back, at once, so
      // what Ink hears after it in the same read is the shell's too (as `paneTakes` does), not this handler's until the frame.
      "terminal.leave": (pressed) => {
        const bytes = keyBytes(pressed);
        if (!justLeft || !paneOpen || bytes === undefined) return false;
        paneKeys.current = true;
        setFocus("terminal");
        terminal.key(bytes);
      },
      // The pane's own key, heard above while the pane has the keys.
      "terminal.scrollback": () => false,
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
      "pager.bottom": () => scroll(() => (card.kind === "help" ? helpMaxTop : card.kind === "lines" ? cardLines.length : linesPanel ? Number.MAX_SAFE_INTEGER : pagerMaxTop)),
      "pager.turn.next": () => {
        const next = pagerTurns.find((at) => at > pagerTop);
        return next === undefined ? false : scroll(() => next);
      },
      "pager.turn.prev": () => {
        const before = pagerTurns.findLast((at) => at < pagerTop);
        return before === undefined ? scroll(() => 0) : scroll(() => before);
      },
      "pager.search": () => (paged(card) ? update({ card: { ...card, query: "", typing: true } }) : false),
      "pager.match": (pressed) => {
        if (!paged(card) || pagerMatches.length === 0) return false;
        const backward = keymap.keys["pager.match"].indexOf(pressed) === 1;
        const next = backward ? (pagerMatches.findLast((at) => at < pagerTop) ?? pagerMatches.at(-1)) : (pagerMatches.find((at) => at > pagerTop) ?? pagerMatches[0]);
        return next === undefined ? false : scroll(() => next);
      },
      "pager.copy": () => {
        if (!paged(card)) return false;
        if (card.kind !== "page" || card.copy === undefined) return say(`Nothing here to copy: ${keys("pager.copy")} copies a file or a document read in the pager.`);
        copyOut(card.copy.text, card.copy.name);
      },
      "pager.close": () => {
        if (card.kind === "help") return update({ card: card.under });
        if (card.kind === "page") return update({ card: card.back });
        if (card.kind === "pager" || card.kind === "lines" || linesPanel) return update({ card: { kind: "none" } });
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
      "composer.readNow": () => readNow(),
      "composer.withdrawLast": () => withdrawLast(),
      // Esc Esc: the prompt picker, over the open session with nothing else open; the second Esc is a single one otherwise.
      "app.prompt.back": () => {
        if (!opened || card.kind !== "none" || promptShown) return false;
        if (messages.length === 0) return say("Nothing to go back to: no prompt has been sent in this session yet.");
        update({ card: { kind: "prompt-picker", environmentId: opened.environmentId, sessionId: opened.sessionId, cursor: null } });
      },
      "picker.branch": () => {
        if (card.kind !== "prompt-picker") return false;
        const message = messages[pickerCursor(card)];
        update({ card: { kind: "none" } });
        if (message) forkRewind.fork(message);
      },
      // Ctrl+D on the workspace step: the known directory under the cursor, off the list on this terminal (#334).
      "picker.hide": () => {
        if (card.kind !== "picker") return false;
        const row = rowAt(card.picker);
        if (row?.hide === undefined) return say("Only a directory the environment's sessions use can be hidden from this list.");
        row.hide();
      },
      "row.rewind": () => {
        const row = onRow();
        if (!row) return false;
        if (row.kind !== "user") return say(`${keys("row.rewind")} rewinds to one of your prompts: put the cursor on one.`);
        forkRewind.rewind(row.entry);
      },
      "row.fork": () => {
        const row = onRow();
        if (!row) return false;
        if (row.kind !== "user") return say(`${keys("row.fork")} forks from one of your prompts: put the cursor on one.`);
        forkRewind.fork(row.entry);
      },
      "row.rewindUndo": () => {
        const row = onRow();
        if (!row) return false;
        if (row.kind !== "rewound") return say(`${keys("row.rewindUndo")} undoes a rewind, on the fold of what it cut.`);
        // Only the latest rewind can be undone, and on its fold the runtime's verb says whether it can be now. An earlier fold
        // on screen has had a run started after it: a rewind with none between would have folded it inside the latest.
        if (standing?.sequence !== row.entry.sequence) return say("Not undone: a run has started since this rewind, so it can no longer be undone.");
        forkRewind.undo();
      },
    };
    // The quit and the jump to what needs you, which nothing may take, are looked up first: before a line or a list typed at
    // takes the text, so neither is typed in when remapped to a printable key. Only the pane's leave key pressed again right
    // after it left the pane comes before them, as it goes to the shell.
    const first: Lookup[] = [...(justLeft ? [{ context: "terminal" as const, only: LEAVE }] : []), { context: "anywhere", only: FIRST_ANYWHERE }];
    if (dispatch(keymap, first, handlers, input, key, { previous, pairOnly: pairedEsc })) return;
    // A card taking a line has the text typed at it: Enter is its choice, Esc its way back, Backspace rubs one out; any
    // other key (Ctrl+C) is looked up as ever.
    if (card.kind === "panel" && pickers.takesText(card.panel) && !screen.question && !pairedEsc) {
      if (key.return) return pickers.choose(card.panel);
      if (key.escape) return update({ card: back(card) });
      if (key.backspace || key.delete) return update({ card: { kind: "panel", panel: pickers.erased(card.panel) } });
      if (input !== "" && !key.ctrl && !key.meta && !key.tab) return update({ card: { kind: "panel", panel: pickers.typed(card.panel, input) } });
    }
    // The routines card taking a line (a path, an endpoint's name, URL or secret) takes it as the panels do.
    if (card.kind === "routines" && routines.takesText(card.routines) && !screen.question && !pairedEsc) {
      if (key.return) return routines.choose(card.routines);
      if (key.escape) return update({ card: back(card) });
      if (key.backspace || key.delete) return update({ card: { kind: "routines", routines: routines.erased(card.routines) } });
      if (input !== "" && !key.ctrl && !key.meta && !key.tab) return update({ card: { kind: "routines", routines: routines.typed(card.routines, input) } });
    }
    // The note's line on the permission card takes what is typed; the move keys wait while it is open, and a key it does not
    // take (Ctrl+C, Ctrl+]) is looked up as any other.
    if (promptShown && promptState.line !== null && !pairedEsc) {
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
    if (paged(card) && card.typing && !pairedEsc) {
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
    // letters are being typed into the composer, unless a key action asked it (`whileTyping`). So a card's Esc or `n`
    // is the card's, never the offer's answer, and never an interrupt.
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
    // A question a key action asked (`whileTyping`) takes its answer whatever the composer holds.
    if (screen.question && (!typing || screen.question.whileTyping === true)) lookups.push("confirm");
    if (card.kind === "asks") lookups.push("asks");
    // The routines card's verbs, then the picker's moves, Enter and Esc.
    else if (card.kind === "routines") lookups.push("routines", "picker");
    else if (card.kind === "help" || paged(card) || card.kind === "lines" || linesPanel) lookups.push("pager", "picker");
    else if (card.kind !== "none") lookups.push("picker");
    if (promptShown) lookups.push("permission");
    if (!cardHasKeys) {
      lookups.push(focused);
      // The page keys are never the composer's: with it focused they still move the transcript half a screen.
      if (focused === "composer" && opened) lookups.push({ context: "transcript", only: PAGE_KEYS });
      if (!screen.question && question && !typing) lookups.push("confirm");
    }
    lookups.push({ context: "anywhere", except: FIRST_ANYWHERE });
    // The one condition the list declares (`composer.withdrawLast`'s): the composer is empty, nothing typed, nothing attached
    // and no search of the history open. It holds only while the composer has the keys: a typed picker, a list, the rail
    // (its filter included) or a card taking a line (a label, a code, a value) having them, `↑` is theirs, never a withdraw.
    const composerEmpty = composerHasKeys && composerText === "" && composer.state.attached.length === 0 && composer.state.search === null;
    if (dispatch(keymap, lookups, handlers, input, key, { previous, pairOnly: pairedEsc, holds: (condition) => condition === "composer.empty" && composerEmpty })) return;
    if (pairedEsc) return;
    // `/files`' list is typed at as well; Backspace with nothing typed goes up a directory.
    if (card.kind === "files") {
      if (key.backspace || key.delete) {
        return update({ card: card.filter.length > 0 ? { ...card, filter: [...card.filter].slice(0, -1).join(""), cursor: 0 } : { ...card, dir: directoryOf(card.dir), cursor: 0 } });
      }
      if (input !== "" && !key.ctrl && !key.meta && !key.escape && !key.tab && !key.return) return update({ card: { ...card, filter: card.filter + input, cursor: 0 } });
      return;
    }
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
  };
  useInput((input: string, key: InkKey) => hear(input, key), { isActive: !paneHasKeys });
  // The second of two Escs in one read, heard with the state the first left.
  useEffect(() => {
    const held = pairedEscHeld.current;
    if (held === undefined) return;
    pairedEscHeld.current = undefined;
    hear("", held, true);
  });

  // A card that is a list of the session's needs the session: gone, it closes. The asks card closes with its last row.
  const sessionCard = card.kind === "pager" || card.kind === "files" || card.kind === "documents" || card.kind === "lines";
  useEffect(() => {
    if (!projection && sessionCard) update({ card: { kind: "none" } });
  }, [projection, sessionCard]);
  // The prompt picker is the session's it was opened on: another session opened, it closes.
  const pickerGone = card.kind === "prompt-picker" && (opened?.environmentId !== card.environmentId || opened.sessionId !== card.sessionId);
  useEffect(() => {
    if (pickerGone) setScreen((s) => (s.card.kind === "prompt-picker" ? { ...s, card: { kind: "none" } } : s));
  }, [pickerGone]);
  const asksDrained = card.kind === "asks" && askList.length === 0;
  useEffect(() => {
    if (asksDrained) setScreen((s) => (s.card.kind === "asks" ? { ...s, card: { kind: "none" } } : s));
  }, [asksDrained]);

  // The help overlay takes the width.
  const showRail = railDrawn && card.kind !== "help";
  const cardHasKeys = (card.kind !== "none" && card.kind !== "minted") || promptShown;
  // Under 100 columns the rail, with the focus, is drawn in the pane's place (the transcript gives way to it): the picker
  // that stands in for it.
  const railInPane = !railDrawn && railListed && focused === "sidebar" && card.kind === "none" && !promptShown;
  // The rows the rail and a picker have: the frame less the header and the six lines under the pane (the two lines, the
  // composer, the status line's two and the activity line).
  const paneRows = Math.max(1, size.rows - OUTSIDE_COLUMN - setupSummaryRows - checkSummaryRows);
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
  // The line under the status line says what has the keys, in the keys of the map in force: an open card first, then the
  // rail or the transcript. Either stays in sight beside a notice. The composer's own keys are on the status line (#147).
  // What the row under the cursor offers besides (#232): a prompt rewinds and forks, a rewind's fold undoes, each with its reason when it cannot now.
  const rowVerbs =
    cursorRow?.kind === "user"
      ? ` · ${verbHint("row.rewind", "rewind", forkRewind.verbs?.rewind, forkRewind.offersStop)} · ${verbHint("row.fork", "fork", forkRewind.verbs?.fork)}`
      : undoableFold(cursorRow, standing)
        ? ` · ${verbHint("row.rewindUndo", "undo", forkRewind.verbs?.undoRewind)}`
        : "";
  // The file verbs (#148) are said on a row that has them, as the fork and rewind verbs are, so the hint stays one line.
  const fileVerbs =
    cursorRow === undefined
      ? ""
      : `${cursorRow.kind === "check" && cursorRow.entry.terminalId === checkView?.offer?.terminalId ? ` · ${keys("row.checkFailure.send")} Send failure` : ""}${rowFile(cursorRow) || cursorRow.kind === "forked" ? ` · ${keys("row.open")} open` : ""}${editCalls(cursorRow).length > 0 ? ` · ${keys("row.diff")} diff` : ""}`;
  const hint =
    card.kind === "panel" || card.kind === "routines"
      ? `The card has the keys · ${card.kind === "panel" ? pickers.hint(card.panel) : `${keys("picker.leave")} ${routines.back(card.routines) ? "goes back" : "closes it"}`}`
      : card.kind === "help" || card.kind === "pager" || card.kind === "lines" || card.kind === "page"
        ? `The card has the keys · ${keys("pager.close")} closes it`
        : card.kind === "environments" ||
            card.kind === "sessions" ||
            card.kind === "snippets" ||
            card.kind === "files" ||
            card.kind === "documents" ||
            card.kind === "notices" ||
            card.kind === "prompt-picker"
          ? `The card has the keys · ${keys("picker.leave")} closes it`
          : card.kind === "menu" || card.kind === "client-sessions"
            ? `The card has the keys · ${keys("picker.leave")} goes back`
            : card.kind === "picker"
              ? `The card has the keys · ${keys("picker.leave")} ${card.picker.back ? "goes back" : "closes it"}`
              : paneHasKeys
                ? `The terminal has the keys · ${keys("terminal.leave")} leaves · ${keys("terminal.scrollback")} scrollback`
                : focused === "sidebar"
                  ? // What the keys do at the cursor gives way to a notice, as the composer's own hint does.
                    `The rail has the keys · ${keys("rail.leave")} ${rail.filter !== null ? "clears the filter" : `back to the composer · ${keys("app.focus.next")} next`}${rail.hint !== undefined && activity === undefined ? ` · ${rail.hint}` : ""}`
                  : focused === "delegated"
                    ? `The delegated strip has the keys · ${keys("delegated.move")} move · ${keys("delegated.open")} open · ${keys("delegated.stop")} stop · ${keys("delegated.leave")} back to the composer`
                    : focused === "transcript"
                      ? `The transcript has the keys · ${keys("transcript.cursor")} rows · ${keys("row.unfold")} unfold${fileVerbs} · ${keys("row.recall")} recall · ${keys("row.stop")} stop${rowVerbs} · ${keys("row.leave")} back to the composer`
                      : undefined;
  const own = menuView ? (runtime.connections.list.read().find((r) => r.environmentId === menuView.environmentId)?.clientSessionId ?? null) : null;
  const freshness = projection?.freshness;
  const marker =
    opened && freshness !== "live"
      ? freshness === "cached"
        ? { text: `◌ cached: what this terminal last saw of it; ${names.get(opened.environmentId) ?? "its environment"} is not answering`, color: TERMINAL_ROLES.warning }
        : { text: "⟳ catching up…", color: TERMINAL_ROLES.machine }
      : undefined;
  const placeholder = !opened
    ? "no session open: /resume opens one, /new starts one"
    : session.lock.locked
      ? "nothing can be sent now"
      : live
        ? "steer or queue a message"
        : "message the agent";
  const steers = session.provider?.steering === true;
  // The open session's environment badge and workspace, read-only in the header (#334): the summary as the list has it
  // until its stream has it.
  const openSummary = projection?.summary ?? openRow?.summary;
  const openBadge = opened ? badges.get(opened.environmentId) : undefined;
  // The header draws its environment's name in its colour.
  const headerColour = headerView ? badges.get(headerView.environmentId)?.colour : undefined;
  const popup = composer.popup;
  const searchScope = composer.state.search ? (scopes[composer.state.search.scope]?.name ?? "everywhere") : undefined;

  const drawn = (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Header
        current={headerView}
        {...(openBadge && { badge: openBadge })}
        {...(headerColour !== undefined && { colour: headerColour })}
        startingService={startingService}
        workspace={openSummary ? `${openSummary.title} · ${workspaceLabel(openSummary.workspace)}` : props.flags.workspace}
      />
      {setupSummary !== undefined && <Line text={setupSummary} color={TERMINAL_ROLES.warning} />}
      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        {showRail && (
          <RailView lines={rail.lines} cursor={rail.cursor} focused={focused === "sidebar" && !cardHasKeys} filter={rail.filter} height={paneRows} width={RAIL_WIDTH} />
        )}
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {card.kind === "environments" && <EnvironmentsCard views={views} cursor={clampCursor(card.cursor, views.length)} hint={listHint("actions", "close")} />}
          {card.kind === "menu" && cardView && cardUpdate && (
            <EnvironmentMenu view={cardView} update={cardUpdate} actions={cardActions} cursor={clampCursor(card.cursor, cardActions.length)} hint={listHint("choose", "back")} />
          )}
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
          {card.kind === "page" && (
            <LinesCard
              title={card.title}
              hint={`${keys("pager.line")} ${keys("pager.halfDown")} ${keys("pager.halfUp")} scroll · ${keys("pager.search")} search · ${keys("pager.close")} close`}
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
          {card.kind === "files" && (
            <FilesCard
              workspace={projection?.summary?.workspace.path ?? "the workspace"}
              dir={card.dir}
              rows={fileRows(card)}
              truncated={listing?.truncated ?? false}
              cursor={clampCursor(card.cursor, fileRows(card)?.length ?? 0)}
              filter={card.filter}
              height={Math.max(1, helpHeight - 1)}
              hint={`type to filter · ${listHint("open", "close")}`}
            />
          )}
          {card.kind === "documents" && (
            <DocumentsCard
              documents={documentRows}
              now={clock.now()}
              cursor={clampCursor(card.cursor, documentRows.length)}
              width={mainWidth}
              height={Math.max(1, helpHeight - 1)}
              hint={listHint("open", "close")}
            />
          )}
          {card.kind === "notices" && (
            <ListCard
              width={mainWidth}
              title="Notices"
              hint={listHint("opens its session", "close")}
              rows={noticeRows(newestFirst, names)}
              cursor={clampCursor(card.cursor, newestFirst.length)}
              height={helpHeight}
              empty="No notices."
            />
          )}
          {card.kind === "lines" && (
            <LinesCard
              title={card.which === "run-info" ? "The latest run" : card.which === "timeline" ? "Timeline" : "Tasks"}
              hint={`${keys("pager.close")} close`}
              lines={cardLines.length > 0 ? cardLines : [{ row: "none", spans: [{ text: LINES_EMPTY[card.which], dim: true }] }]}
              top={card.top}
              height={helpHeight}
            />
          )}
          {card.kind === "panel" && pickers.render(card.panel, { width: mainWidth, height: helpHeight })}
          {card.kind === "routines" && routines.render(card.routines, { width: mainWidth, height: helpHeight })}
          {card.kind === "prompt-picker" && (
            <PromptPickerCard
              messages={messages}
              cursor={pickerCursor(card)}
              width={mainWidth}
              height={helpHeight}
              keys={{ move: keys("picker.move"), choose: keys("picker.choose"), branch: keys("picker.branch"), leave: keys("picker.leave") }}
              rewind={forkRewind.verbs?.rewind}
              fork={forkRewind.verbs?.fork}
              offersStop={forkRewind.offersStop}
            />
          )}
          {card.kind === "asks" && (
            <AsksCard
              rows={askList}
              cursor={clampCursor(card.cursor, askList.length)}
              height={Math.max(1, helpHeight - 3)}
              hint={{
                decidable: `${keys("asks.move")} move · ${keys("asks.open")} open · ${keys("asks.allow")} allow once · ${keys("asks.deny")} deny${
                  bulk.length > 0 ? ` · ${keys("asks.allowAll")} allow all · ${keys("asks.denyAll")} deny all` : ""
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
          {card.kind === "none" && opened && !railInPane && <DelegatedStrip tasks={tasks.map((row) => row.task)} cursor={focused === "delegated" ? delegatedTask?.task.taskId : undefined} />}
          {card.kind === "none" && opened && !railInPane && <QueuedLine queue={queue} steers={steers} verbs={queueVerbs} />}
          {card.kind === "none" && paneOpen && !railInPane && terminal.pane && (
            <TerminalPaneView
              command={terminal.pane.command}
              environment={names.get(terminal.pane.environmentId) ?? ""}
              status={terminal.status()}
              ended={terminal.pane.ended}
              focused={paneHasKeys}
              rows={terminal.rows(paneHasKeys)}
              height={paneSize.rows}
              hint={`${keys("app.focus.next")} reaches it`}
            />
          )}
          {card.kind === "none" && opened && !railInPane && standing?.undoable === true && undoVerb !== undefined && (
            <RewoundStrip text={standing.text} undo="/rewind undo" availability={undoVerb} />
          )}
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
              repeat={
                shownPrompt.prompt.kind === "denylist" && projection
                  ? denylistRepeatWords(shownPrompt.prompt, projection.items.filter((item): item is PromptEntry => item.kind === "prompt"))
                  : undefined
              }
            />
          )}
          {card.kind === "none" && !opened && !railInPane && started && known.length === 0 && <PairingPrompt />}
          {card.kind === "none" && !opened && !railInPane && !started && <Text dimColor> Connecting…</Text>}
          {card.kind === "none" && !opened && !railInPane && started && known.length > 0 && <Text dimColor> No session is open.</Text>}
        </Box>
      </Box>
      <Line text={screen.line} />
      <Line text={promptLine} color={TERMINAL_ROLES.warning} />
      {trustLine !== undefined && <Line text={trustLine} color={TERMINAL_ROLES.warning} />}
      {checkUnavailable !== undefined && <Text dimColor>{checkUnavailable}</Text>}
      {checkOffer !== undefined && <Text color={TERMINAL_ROLES.warning}>{checkOffer}</Text>}
      <ComposerView
        editor={composer.state.editor}
        focused={focused === "composer" && !cardHasKeys}
        locked={opened && session.lock.locked ? session.lock.reason : undefined}
        gone={gone}
        placeholder={placeholder}
        popup={popup}
        highlight={popup ? highlighted(composer.state, popup) : -1}
        search={composer.state.search && searchScope !== undefined ? { query: composer.state.search.query, scope: searchScope, found: composer.state.editor !== composer.state.search.saved } : undefined}
        note={composerNote(composer.state, keys("composer.complete"))}
        suggestion={projection?.suggestion?.suggestion}
        suggestionKey={keymap.keys["composer.suggestion.take"].includes("1–4") ? "1" : keymap.keys["composer.suggestion.take"][0]}
      />
      <StatusLine one={status.one} two={status.two} />
      <HintLine hint={promptsHint ?? hint} activity={activity} fallback=" " />
    </Box>
  );
  // What draws deep in the tree takes the theme's colours from here: a diff's bands.
  return <ThemeColoursContext.Provider value={colours}>{drawn}</ThemeColoursContext.Provider>;
};

const clampCursor = (cursor: number, rows: number): number => (rows <= 0 ? 0 : Math.min(Math.max(cursor, 0), rows - 1));

/** Why an action the shared list keeps absent does nothing: its reason, as the help overlay draws it. */
const absentReason = (id: KeyActionId): string => {
  const action = actionById(id);
  return action?.status === "absent" ? action.reason : `${id} does nothing here.`;
};

/** What a lines card says with nothing to list. */
const LINES_EMPTY: Readonly<Record<"tasks" | "timeline" | "run-info", string>> = {
  tasks: "No delegated work in this session.",
  timeline: "No turn yet.",
  "run-info": "No run yet.",
};

/** `/notices`: the notices, newest first as given, each with when, where from and what it offers. */
const noticeRows = (notices: readonly Notice[], names: ReadonlyMap<string, string>): PanelRow[] =>
  notices.map((notice) => ({
    key: notice.id,
    cells: [
      { text: `${clockTime(notice.at)}  `, dim: true },
      { text: `${names.get(notice.environmentId) ?? "an environment"}  `, bold: true },
      { text: noticeLine(notice), ...(NOTICE_COLOURS[notice.kind] !== undefined && { color: NOTICE_COLOURS[notice.kind] }) },
    ],
    dim: false,
  }));

/** The notices worth a colour in `/notices`: what blocks a connection or a command in red, a prompt waiting in yellow. */
const NOTICE_COLOURS: Readonly<Partial<Record<Notice["kind"], string>>> = {
  revoked: TERMINAL_ROLES.danger,
  expired: TERMINAL_ROLES.danger,
  "command-rejected": TERMINAL_ROLES.danger,
  "command-dropped": TERMINAL_ROLES.danger,
  "prompt-parked": TERMINAL_ROLES.warning,
};

/**
 * `work` with the terminal lent to it (Ctrl+G's `$EDITOR`, `o`'s `$VISUAL` or `$EDITOR`): Ink leaves the alternate screen
 * and raw mode while it runs (`suspendTerminal`); `unrun` is the answer when it never ran.
 */
const lendTerminal = async <T,>(suspend: (callback: () => Promise<void>) => Promise<void>, work: () => Promise<T>, unrun: T): Promise<T> => {
  let result = unrun;
  await suspend(async () => {
    result = await work();
  });
  return result;
};

/** What `r` puts back in the composer: the shell line a command call ran, behind `!`, or a slash command the run ran; null for any other row. */
const recall = (row: Row): string | null => {
  if (row.kind === "command") return `/${row.entry.name}${row.entry.args.length > 0 ? ` ${row.entry.args}` : ""}`;
  if (row.kind !== "calls") return null;
  for (const call of [...row.calls].reverse()) {
    const command = call.input["command"] ?? call.input["cmd"];
    // Behind `!`: Enter runs it again in the session's terminal. A command that itself starts with `!`
    // (a negated one) is behind `! `, so it is never read as `!!` and runs as it was.
    if (typeof command === "string" && command.trim().length > 0) return `!${command.startsWith("!") ? " " : ""}${command}`;
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
        { text: ` · ${task.status}${task.error ? `: ${task.error}` : ""}`, dim: true, ...(task.status === "failed" && { color: TERMINAL_ROLES.danger }) },
      ],
    })),
  );
};
