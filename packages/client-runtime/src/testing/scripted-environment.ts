import {
  AdapterCapabilities,
  DISCOVERY_PATH,
  LIST_PATCH_KEY,
  MODES,
  PAIR_PATH,
  PROTOCOL_VERSION,
  ENVIRONMENT_STREAM_KIND,
  SESSION_STREAM_KIND,
  WIRE_PATH,
  eventTypeEntry,
  isListEvent,
  AccountCatalogue,
  AccountRecord,
  AmbientProbe,
  BYPASS_SENTENCE,
  CONTAINMENT_LEVELS,
  ContainmentReport,
  HandoffRecommendation,
  PERMISSION_SETTINGS_KEYS,
  SIGN_IN_ENDED_STATES,
  UPDATE_SETTINGS_KEYS,
  type ReviewRun,
  SignIn,
  compareModes,
  lowerMode,
  normaliseEnvironmentName,
  presetSettings,
  type AccountChange,
  type AccountUsage,
  type Actor,
  type ContainmentLevel,
  type EnvironmentColour,
  type EnvironmentIcon,
  type Mode,
  type SettingsValues,
  type SignInState,
  UpdatesStatus,
  type AttachmentInput,
  type ByeReason,
  type CapabilityFlags,
  type CommandsListEntry,
  type DiscoveryDocument,
  type EnvironmentStatus,
  type EventEnvelope,
  type Frame,
  Group,
  type HelloFrame,
  type InterruptCause,
  type JsonObject,
  MAX_DRAFT_LENGTH,
  invalidParams,
  type ModelUsage,
  type QueueHolder,
  type ResultOf,
  type RunEndReason,
  type Scope,
  SessionSummary,
  TranscriptItem,
  TERMINAL_EXITED_TYPE,
  TERMINAL_OUTPUT_TYPE,
  TERMINAL_STREAM_KIND,
  TOOL_TERMINAL_KEPT_MS,
  type SessionDiffFile,
  type SummaryPatch,
  type TerminalExitCause,
  type TerminalInfo,
  type WorkspaceProblem,
} from "@agent-harness/contracts";
import { reduceSession } from "../projections/session.js";
import { uuidv4 } from "../ids.js";
import type { GrantReader, HttpFetch, WebSocketFactory } from "../platform.js";
import { FAKE_HARNESS_VERSION, fakeWire, type FakeAnswer, type FakeResponder, type FakeServer, type FakeWire } from "./fake-wire.js";
import type { ManualClock } from "./in-memory-platform.js";
import { ACCESS_COMMANDS, scriptedAccess, type ClientSessionRow, type ScriptedAccessEvent, type ScriptedAccessHandle } from "./scripted-access.js";
import { scriptedFolders, type ScriptedFolder } from "./scripted-folders.js";
import { FORGE_COMMANDS, scriptedForges, type ScriptedForges, type ScriptedForgesHandle } from "./scripted-forges.js";
import { KEY_MANAGER_COMMANDS, scriptedKeyManagers, type ScriptedKeyManagers, type ScriptedKeyManagersHandle } from "./scripted-key-managers.js";
import { scriptedTools, type ScriptedManagedTools, type ScriptedToolsHandle, type ToolTerminalHooks } from "./scripted-tools.js";
import { LIST_COMMANDS, SCRIPTED_HOME, scriptedList, type ScriptedList } from "./scripted-list.js";
import { PERMISSION_COMMANDS, scriptedPermissions, type ScriptedPermissionsHandle } from "./scripted-permissions.js";
import { scriptedPrompts, type ScriptedPrompts } from "./scripted-prompts.js";
import { scriptedSetup, type ScriptedSetup, type ScriptedSetupHandle } from "./scripted-setup.js";

/**
 * The scripted fake environment every renderer's tests drive
 * (docs/specs/tui.md and docs/specs/gui.md, "Testing Decisions"): the #126
 * fake wire extended with a script, one or two environments, each with its
 * sessions and groups, its client sessions, the receipts its commands
 * answer, how its pairing exchange refuses a code, and what its discovery
 * answers. A test drives it further through its handle: runs streaming
 * events, `bye` reasons, a dropped socket, discovery answering `starting` or
 * nothing, a notice on the environment's stream, and prompts parked and
 * answered (`scripted-prompts.ts`). It imports no Node built-in and no
 * renderer, so it runs wherever the runtime does: under Node for the
 * terminal UI's tests, in jsdom for the GUI's.
 */

/** How a command is answered: accepted, or rejected with a reason (an error code), a message and the error's data. */
export type ScriptedReceipt = "accepted" | { readonly rejected: string; readonly message?: string; readonly data?: Readonly<Record<string, unknown>> };

/** What discovery answers: ready, starting, or nothing at all (nothing listens). */
export type ScriptedDiscovery = "ready" | "starting" | "nothing";

/** Why the pairing exchange refuses every code, as the environment answers it. */
export type ScriptedPairingRefusal = "expired-code" | "used-code" | "invalid-code";

export interface ScriptedEnvironment {
  readonly name: string;
  /** How this terminal reaches it: `local` through the grant file, `paired` before the first frame, `unpaired` only by `/pair`. */
  readonly reach: "local" | "paired" | "unpaired";
  /** Preset: a fresh UUID. Name one to start again on the same environment. */
  readonly environmentId?: string;
  readonly protocolVersion?: number;
  readonly capabilities?: CapabilityFlags;
  /** The icon discovery and `hello` say at first: preset none, as an environment from before icons says (#323). */
  readonly icon?: EnvironmentIcon;
  /** The colour discovery and `hello` say at first: preset none, as an environment from before colours says (#323). */
  readonly colour?: EnvironmentColour;
  /** The scopes `hello` gives this terminal's client session: preset every scope. */
  readonly scopes?: readonly Scope[];
  /** What discovery answers at first: preset `ready`. */
  readonly discovery?: ScriptedDiscovery;
  readonly sessions?: readonly Partial<SessionSummary>[];
  readonly groups?: readonly Partial<Group>[];
  /** What `access.sessions.list` lists besides this terminal's own client session. */
  readonly clientSessions?: readonly Partial<ClientSessionRow>[];
  /** What the access log holds before anything is done, oldest first (`access.log.list`): preset nothing. */
  readonly accessLog?: readonly ScriptedAccessEvent[];
  /** What `environment.status` says: preset ready and idle, its updates its own; a drain says draining. */
  readonly status?: Partial<EnvironmentStatus>;
  /**
   * How each method named is answered: preset accepted. A command's
   * rejection is its receipt; a query's (`access.sessions.list`) is an
   * error response with the reason as its code.
   */
  readonly receipts?: Readonly<Record<string, ScriptedReceipt>>;
  /** How the pairing exchange answers: preset it accepts any code. */
  readonly pairing?: ScriptedPairingRefusal;
  /** What `hello` says differently from discovery: another environment id, other scopes. */
  readonly hello?: Partial<HelloFrame>;
  /** Whether a socket is answered with `hello` as soon as its `auth` arrives: preset true. */
  readonly autoAccept?: boolean;
  /** What `files.list` lists for any session: preset none. */
  readonly files?: readonly string[];
  /** What `commands.list` answers for any session it holds (#503): the session's skill entries and the provider's own commands; preset none. */
  readonly commands?: readonly CommandsListEntry[];
  /** The one provider `providers.list` describes, over a Claude-shaped descriptor that neither queues nor steers. */
  readonly provider?: Partial<AdapterCapabilities>;
  /** Several providers instead, each over the same descriptor; `provider` is then ignored. */
  readonly providers?: readonly Partial<AdapterCapabilities>[];
  /** What `accounts.list` lists, over an adopted, signed-in account on the first provider: preset none. */
  readonly accounts?: readonly Partial<AccountRecord>[];
  /** Why `accounts.list` fails, as an `internal` error response: preset it lists `accounts`. */
  readonly accountsError?: string;
  /** Who holds a message sent during a live run: preset the environment (ADR 0022). */
  readonly queue?: QueueHolder;
  /**
   * An interrupt accepted with the run still going (`ended: false`), as the
   * environment answers one before the provider has stopped: the run ends
   * when the test ends it. Preset: an interrupt ends the run at once.
   */
  readonly interruptHolds?: boolean;
  /** Holds each session's catch-up after `subscribed`, until `releaseSessions`: the stream stays catching up. Preset false. */
  readonly holdSessions?: boolean;
  /** What `models.list` answers: each account's catalogue. Preset none. */
  readonly models?: readonly Partial<AccountCatalogue>[];
  /** What `permissions.settings.get` reports of containment: each level's availability, over every level available. */
  readonly containment?: Partial<ContainmentReport>;
  /** The settings' values `settings.get` and `permissions.settings.get` answer, over the presets. */
  readonly settings?: Partial<SettingsValues>;
  /** The browser origins `web.origins.get` answers at first: preset none of either. */
  readonly webOrigins?: { readonly clientOrigins?: readonly string[]; readonly connectOrigins?: readonly string[] };
  /**
   * The ids of the denylist's presets it has lost, which `permissions.denylist.restorePresets` puts back, of the sections it
   * names: preset none. The denylist is otherwise the presets, which `permissions.denylist.set` changes (`scripted-permissions.ts`).
   */
  readonly lostPresets?: readonly string[];
  /** What `permissions.review.list` lists until `permissions.review.seen` marks it seen: preset nothing. */
  readonly review?: readonly Partial<ReviewRun>[];
  /** What `accounts.handoff.recommend` answers, over no recommendation. */
  readonly recommendation?: Partial<HandoffRecommendation>;
  /**
   * What `accounts.add` says of the sign-in it starts: preset it starts one, unless a sign-in that has not ended holds
   * the environment, which `accounts.signin.start` is refused for too (`signin_running`), as the director runs one at a time.
   */
  readonly addSignIn?: { readonly started: boolean; readonly message: string | null };
  /**
   * What `accounts.probe` reads of the machine's own Claude directory, `/home/milo/.claude`, which `accounts.adopt`
   * adopts while it is there and signed in: preset not there.
   */
  readonly ambient?: Partial<AmbientProbe>;
  /** The directories a new session is refused in, by the path as recorded (`~` read as the scripted home), each with its problem (`workspace_unusable`): preset none. */
  readonly directories?: Readonly<Record<string, WorkspaceProblem>>;
  /**
   * The directories `workspaces.browse` lists and `workspaces.inspect`
   * describes, by absolute path, each one's parents and the home being
   * directories too; the repositories among them are what a `worktree`
   * request is made from (`scripted-folders.ts`). Preset: the home and its
   * parents, holding nothing.
   */
  readonly folders?: Readonly<Record<string, ScriptedFolder>>;
  /** Whether `files.list` says the workspace holds more than it listed: preset false. */
  readonly filesTruncated?: boolean;
  /** What `files.read` answers, by path: its text, or a file too large or binary; any other path is `not_found`, and a directory of `files` is `not_a_file`. */
  readonly fileContents?: Readonly<Record<string, ScriptedFile>>;
  /**
   * Each subagent's stored transcript, by the agent id `sessions.subagentTranscript` is asked with: read while the provider
   * declares `subagentTranscripts`, else refused as the environment refuses it. An agent not named has none (`[]`).
   */
  readonly subagentTranscripts?: Readonly<Record<string, readonly JsonObject[]>>;
  /** What `diffs.session` answers for any session: preset no files. */
  readonly sessionDiff?: { readonly files: readonly SessionDiffFile[]; readonly truncated?: boolean };
  /** What `diffs.workingTree` answers, or its refusal (a `conflict` with its reason): preset an empty diff in a repository. */
  readonly workingTree?: { readonly diff: string; readonly truncated?: boolean; readonly repository?: boolean } | { readonly refused: string; readonly message: string };
  /** Terminals open on the environment before the first frame, each for the session the script lists at `session` (preset 0). */
  readonly terminals?: readonly ScriptedTerminal[];
  /**
   * What a one-off command (`!`'s or `!!`'s) prints and how it exits, when terminals.run starts it: preset nothing, and 0. With no
   * exit code it runs on until `exitTerminal`.
   */
  readonly oneOff?: (command: string) => { readonly output: string; readonly exitCode?: number };
  /** A newly opened login shell's startup output, retained before its first subscription. */
  readonly terminalStartup?: string;
  /** What the update methods answer (#354): preset a current environment of discovery's version under a launcher, before any check, with no desktop build published. */
  readonly updates?: ScriptedUpdates;
  /**
   * What `setup.check` answers for each step (`scripted-setup.ts`): preset each step this build registers done. With the
   * `setup` flag, `environment.subscribe`'s snapshot carries the results last checked and a check that changed one is noticed.
   */
  readonly setup?: ScriptedSetup;
  /**
   * The key-manager connections, the key manager behind them, the items Move lists and the managed tools' rows
   * (`scripted-key-managers.ts`): preset none held, over a key manager that takes every credential. The `keyManagers` and
   * `managedTools` flags are the script's `capabilities`.
   */
  readonly keyManagers?: ScriptedKeyManagers;
  /**
   * The forge accounts and the forges behind them (`scripted-forges.ts`): preset none held, over forges that take every
   * token. The `forge` flag is the script's `capabilities`.
   */
  readonly forges?: ScriptedForges;
  /**
   * What the Managed tools' verify commands and claude's doctor say, and how each tool run goes in its tool terminal
   * (`scripted-tools.ts`); the rows are `keyManagers.tools`. Preset: every verification passes and every run exits 0.
   */
  readonly managedTools?: ScriptedManagedTools;
}

/**
 * The update methods' answers: `updates.status` and `updates.check` answer
 * `status` over a current environment's; `updates.desktop.stage` the build
 * `desktopBuild` names, whatever platform and format it is asked for, or
 * its refusal, an error with the reason as its code; `updates.apply` is
 * accepted, the update going to the version asked for (else the channel's
 * newest) under `updateId`, unless `receipts` rejects it.
 */
export interface ScriptedUpdates {
  readonly status?: Partial<UpdatesStatus>;
  /** The id of the update `updates.apply` takes; preset: a fresh one per call. */
  readonly updateId?: string;
  /** Preset: refused `not_found`, as a release with no build for the platform and format is. */
  readonly desktopBuild?: ResultOf<"updates.desktop.stage"> | { readonly refused: string; readonly message?: string; readonly data?: Readonly<Record<string, unknown>> };
}

/** A file as `files.read` answers it. */
export type ScriptedFile = string | { readonly binary: true; readonly size: number } | { readonly text: string; readonly truncated: true; readonly size: number };

/** A terminal the environment holds from the start. */
export interface ScriptedTerminal {
  readonly id: string;
  readonly session?: number;
  /** Its output so far, one chunk. */
  readonly output?: string;
  readonly cols?: number;
  readonly rows?: number;
  /** Its exit code when its shell has exited; preset it runs. */
  readonly exitCode?: number;
}

/** A terminal as the scripted environment holds it: what was written to it and how it was sized, by the commands that did. */
export interface TerminalRecord {
  readonly id: string;
  /** A session's, or the Managed tools registry's (a tool terminal, #426), whose session is null. */
  readonly owner: TerminalInfo["owner"];
  readonly sessionId: string | null;
  readonly cols: number;
  readonly rows: number;
  /** The variables `terminals.open` gave its shell. */
  readonly env: Readonly<Record<string, string>>;
  /** What `terminals.write` wrote to it, one entry a command. */
  readonly writes: readonly string[];
  /** Every `terminals.resize`, in order. */
  readonly resizes: readonly { readonly cols: number; readonly rows: number }[];
  readonly closed: boolean;
}

export interface Script {
  readonly environments: readonly ScriptedEnvironment[];
}

/** What the look commands change: the name, as typed, the icon or the colour. */
export interface LookChanges {
  readonly name?: string;
  readonly icon?: EnvironmentIcon;
  readonly colour?: EnvironmentColour;
}

export interface EnvironmentHandle
  extends ScriptedPrompts, ScriptedSetupHandle, ScriptedKeyManagersHandle, ScriptedToolsHandle, ScriptedForgesHandle, ScriptedPermissionsHandle, ScriptedAccessHandle {
  readonly name: string;
  readonly environmentId: string;
  readonly wire: FakeWire;
  /** The environment's side of the socket the client opened last. */
  readonly server: FakeServer;
  /** What discovery answers from now on. */
  discovery(answer: ScriptedDiscovery | Partial<DiscoveryDocument>): void;
  /** What discovery answers now, as the local service's readiness reads it. */
  readiness(): ScriptedDiscovery;
  /** Says `bye` on the latest socket and closes it. */
  bye(reason: ByeReason, fields?: { readonly protocolVersion?: number; readonly message?: string }): void;
  /** Answers `hello` on the latest socket, for an environment that does not accept on its own. */
  accept(overrides?: Partial<HelloFrame>): Promise<void>;
  /** Stops or restarts answering `auth` on its own. */
  autoAccept(on: boolean): void;
  /** The requests the client sent on its latest socket, by method. */
  requests(method?: string): readonly Extract<Frame, { readonly type: "request" }>[];
  /** Its session list: what it holds now, a method's answers held, a change of its own accord. */
  readonly list: ScriptedList;
  /** The id of the session the script lists `index`th (from 0). */
  sessionId(index?: number): string;
  /** A session's summary as the environment holds it now. */
  summary(sessionId: string): SessionSummary;
  /**
   * Appends an event to the session's stream at the next sequence and sends
   * it to the client's subscriptions: the session's, and the list's when the
   * type is list-flagged or it changes the summary (`fields`, or a whole
   * `patch`). The payload is held to its type's schema when the contracts
   * know the type; an unknown type goes as it is.
   */
  emit(sessionId: string, type: string, payload: Record<string, unknown>, change?: { readonly fields?: Partial<SessionSummary>; readonly patch?: SummaryPatch; readonly actor?: Actor }): EventEnvelope;
  /** Starts a run as `runs.start` does: `message.sent` (a prompt) then `run.started`, the session running. */
  startRun(
    sessionId: string,
    text: string,
    attachments?: readonly AttachmentInput[],
    choice?: { readonly model?: string; readonly effort?: string },
  ): { readonly runId: string; readonly messageId: string };
  /**
   * Ends a run as the environment does (ADR 0022): at an end other than
   * `completed`, what the provider holds of the run comes back to the
   * environment's queue (`message.requeued`) before `run.ended` (reason preset
   * completed; an interrupt's cause preset `user`), the session idle; after
   * any end but an interrupt, the run of the queue starts with what the
   * environment holds, as the environment's `startFromQueue` does, on the
   * model and effort of the run before it.
   */
  endRun(
    sessionId: string,
    runId: string,
    end?: { readonly reason?: RunEndReason; readonly cause?: InterruptCause; readonly usage?: readonly ModelUsage[] | null; readonly durationMs?: number },
  ): void;
  /** The session's queue as the environment holds it now, in the order sent: what `message.sent` queued and nothing has read, steered, requeued away or withdrawn. */
  queued(sessionId: string): readonly { readonly messageId: string; readonly runId: string; readonly text: string; readonly heldBy: QueueHolder }[];
  /** The run live on the session, as the environment knows it; undefined when none is. */
  liveRun(sessionId: string): string | undefined;
  /** The id of the message sent to the session with `text`, the latest of that text; throws when none was. */
  messageId(sessionId: string, text: string): string;
  /**
   * The session's run `runId` writes `text` whole to `path` (relative to the workspace), as Claude's `Write` does: its
   * `tool.started`, naming the file by its absolute path, and a `tool.ended` ok. `files.read` answers the text from then
   * on, and `files.list` lists the path. Answers the call's id.
   */
  writeFile(sessionId: string, runId: string, path: string, text: string): string;
  /**
   * The session's run `runId` edits `path`, as Claude's `Edit` does: the first `oldText` in what `files.read` answers
   * becomes `newText`, then its `tool.started` and a `tool.ended` ok. Throws for a file with no text to edit. Answers the
   * call's id.
   */
  editFile(sessionId: string, runId: string, path: string, oldText: string, newText: string): string;
  /** The session's log as the environment holds it: every event appended since its snapshot, in order. */
  events(sessionId: string): readonly EventEnvelope[];
  /** The accounts the environment holds now, as `accounts.list` answers them. */
  accounts(): readonly AccountRecord[];
  /**
   * Changes an account as another client or the environment's own status read would: the fields given replace its
   * own, or `null` removes it; an `account.updated` notice says what changed.
   */
  changeAccount(accountId: string, changes: Partial<AccountRecord> | null): void;
  /** What `accounts.usage` answers from now on, said with a `usage.updated` notice for each reading, as the environment says it. */
  setUsage(readings: readonly AccountUsage[]): void;
  /** Sends the catch-up of every session subscription `holdSessions` held. */
  releaseSessions(): void;
  /** Holds every answer to `sessions.rewind` until the release is called, each then answered as the environment stands at the release. */
  holdRewinds(): () => void;
  /** Moves the environment's sign-in to `state`, as its director does, and says so with `signin.updated`. */
  signIn(state: SignInState, fields?: { readonly url?: string | null; readonly error?: string | null }): void;
  /** The environment's latest sign-in; null before any. */
  currentSignIn(): SignIn | null;
  /** Changes what `accounts.handoff.recommend` answers, said with a `usage.updated` notice as the environment says a reading changed. */
  recommend(recommendation: Partial<HandoffRecommendation>): void;
  /** The settings' values the environment holds now. */
  settings(): SettingsValues;
  /** Changes settings as another client would: the values change, and a `settings.changed` notice names the keys that did (#391). */
  setSettings(values: Partial<SettingsValues>): void;
  /** Says a notice on the environment's own stream (`environment.subscribe`), as the environment does. */
  notice(type: string, payload: Record<string, unknown>): void;
  /**
   * Changes the environment's name, icon or colour as another client's
   * `environment.rename`, `setIcon` or `setColour` would: what discovery and
   * `hello` say from now on, and the notice of each field that changed.
   */
  setLook(changes: LookChanges): void;
  /** The terminals the environment has held, oldest first, closed ones included. */
  terminals(): readonly TerminalRecord[];
  /** A terminal it holds or held; fails for one it never did. */
  terminal(id: string): TerminalRecord;
  /** Holds every `terminals.open` unanswered and unacted on until the function it returns is called. */
  holdTerminalOpens(): () => void;
  /** The terminal's shell writes `data`: a `terminal.output` chunk to its subscriptions. */
  terminalOutput(id: string, data: string): void;
  /** The terminal's shell exits with `exitCode`, killed by `signal` when one is given: `terminal.exited`, then its subscriptions end. */
  exitTerminal(id: string, exitCode: number, signal?: number | null): void;
  /** The environment closes the terminal itself, as it does a tool terminal at its stop: out of the list at once, then `terminal.exited` closed to its subscriptions. */
  closeTerminal(id: string): void;
  /** The terminal's scrollback loses its oldest `chunks`, as the cap drops them: a cursor before what is kept gets a truncated snapshot. */
  dropScrollback(id: string, chunks: number): void;
  /** Changes what the update methods answer from now on, over what they answer now: a release published since, a build staged. */
  setUpdates(changes: ScriptedUpdates): void;
}

export interface ScriptedWorld {
  readonly environments: readonly EnvironmentHandle[];
  /** Routes to each environment by its origin; nothing else answers. */
  readonly fetch: HttpFetch;
  readonly webSocket: WebSocketFactory;
  /** The local environment's grant reader; undefined when the script has none. */
  readonly grant: GrantReader | undefined;
  environment(name: string): EnvironmentHandle;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "env";

/** A fixture checked against the contracts' schema, so a script never feeds the runtime what no environment would send. */
const checked = <T,>(schema: { parse(value: unknown): T }, value: T): T => schema.parse(value);

const summaryOf = (clock: ManualClock, partial: Partial<SessionSummary>, index: number): SessionSummary => {
  const at = clock.now().toISOString();
  return checked(SessionSummary, {
    id: `0199aa00-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: at,
    updatedAt: at,
    lastActivityAt: null,
    title: "New session",
    titleSource: "default",
    archivedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    tags: [],
    groupId: null,
    settledAt: null,
    settledOverride: null,
    settledBy: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    workspace: { kind: "directory", path: "/home/milo/code" },
    repositoryIdentity: null,
    workspaceMissingSince: null,
    activity: { state: "idle", since: at },
    parkedPromptCount: 0,
    accountId: null,
    model: null,
    runChoice: null,
    mode: null,
    browser: null,
    pullRequests: [],
    draft: null,
    ...partial,
  });
};

const groupOf = (clock: ManualClock, partial: Partial<Group>, index: number): Group => {
  const at = clock.now().toISOString();
  return checked(Group, {
    id: `0199bb00-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Group ${index + 1}`,
    orderKey: null,
    createdAt: at,
    updatedAt: at,
    ...partial,
  });
};

/** A title as the environment generates one from text (`sessions/titles.ts`): its first line with words in it, collapsed, and past 80 characters cut at a space to 79 or fewer and ended with an ellipsis. */
const generatedTitle = (text: string): string | null => {
  const line = text.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== "");
  if (line === undefined) return null;
  const characters = Array.from(line.replace(/\s+/g, " ").trim());
  if (characters.length <= 80) return characters.join("");
  const boundary = characters.lastIndexOf(" ", 79);
  return `${characters.slice(0, boundary > 0 ? boundary : 79).join("")}…`;
};

/** The descriptor `providers.list` answers: Claude-shaped, with `changes` over it. */
const providerOf = (changes: Partial<AdapterCapabilities> = {}): AdapterCapabilities =>
  checked(AdapterCapabilities, {
    provider: "claude",
    displayName: "Claude",
    interactivePrompts: true,
    partialMessages: true,
    providerQueue: false,
    withdraw: true,
    steering: false,
    resume: true,
    fork: true,
    rewind: true,
    sessionListing: false,
    subagents: true,
    subagentTranscripts: false,
    titleRead: false,
    titleWrite: false,
    transcriptDelete: false,
    planUsage: true,
    liveModels: false,
    commands: true,
    imageInput: true,
    fileInput: false,
    modeChange: true,
    containment: false,
    instructionChannel: { kind: "system-prompt-append", maxCharacters: null },
    nativeProjectInstructions: true,
    nativeSkillRoots: [".claude/skills", ".claude/commands"],
    modes: MODES.map((mode) => ({ mode, available: true as const, reason: null })),
    ...changes,
  });

const PAIRING_REFUSALS: Readonly<Record<ScriptedPairingRefusal, { readonly status: number; readonly code: string }>> = {
  "expired-code": { status: 410, code: "pairing_expired" },
  "used-code": { status: 410, code: "pairing_used" },
  "invalid-code": { status: 401, code: "pairing_invalid" },
};

const later = (step: () => void) => void Promise.resolve().then(step);

/** A text's size in UTF-8 bytes, as `files.read` reports a file's; `TextEncoder` is a global wherever the runtime runs. */
const utf8Size = (text: string): number => new (globalThis as unknown as { TextEncoder: new () => { encode(text: string): Uint8Array } }).TextEncoder().encode(text).length;

const scripted = (clock: ManualClock, spec: ScriptedEnvironment, index: number) => {
  const host = `${slug(spec.name)}.test`;
  const wire = fakeWire({
    clock,
    name: spec.name,
    address: { host, port: 7433 + index },
    ...(spec.environmentId !== undefined && { environmentId: spec.environmentId }),
    ...(spec.protocolVersion !== undefined && { protocolVersion: spec.protocolVersion }),
    ...(spec.capabilities !== undefined && { capabilities: spec.capabilities }),
    ...(spec.icon !== undefined && { icon: spec.icon }),
    ...(spec.colour !== undefined && { colour: spec.colour }),
  });
  let discovery: ScriptedDiscovery = spec.discovery ?? "ready";
  let accepting = spec.autoAccept ?? true;
  const hello: Partial<HelloFrame> = { ...(spec.scopes && { scopes: [...spec.scopes] }), ...spec.hello };
  const setDiscovery = (answer: ScriptedDiscovery | Partial<DiscoveryDocument>) => {
    if (typeof answer === "string") {
      discovery = answer;
      wire.discovery(answer === "nothing" ? "unreachable" : { readiness: answer });
    } else {
      discovery = answer.readiness === "starting" ? "starting" : "ready";
      wire.discovery(answer);
    }
  };
  setDiscovery(discovery);

  const sessions = (spec.sessions ?? []).map((s, i) => summaryOf(clock, s, i));
  const groups = (spec.groups ?? []).map((g, i) => groupOf(clock, g, i));
  let sequence = 100;

  // The streams: the session list (`scripted-list.ts`) and each session, answered `subscribed`, then the list as it
  // stands or the session's whole log (a snapshot at its creation and every event since), then `synchronized` at the
  // head. What is emitted later goes to the subscriptions of the latest socket.
  const logs = new Map<string, { readonly base: number; readonly events: EventEnvelope[] }>(sessions.map((s) => [s.id, { base: sequence, events: [] }]));
  let subscriptions = 0;
  const sessionSubscriptions = new Map<string, string>();
  const subscribed = (request: { readonly id: string }): string => {
    const id = `${slug(spec.name)}-sub-${++subscriptions}`;
    wire.server.send({ type: "subscribed", id: request.id, subscription: id });
    return id;
  };
  wire.answer("sessions.subscribeSession", (params, request) => {
    const sessionId = String(params["sessionId"]).toLowerCase();
    const summary = sessions.find((s) => s.id === sessionId);
    const log = logs.get(sessionId);
    if (!summary || !log) return { error: { code: "not_found", message: "No such session.", data: { kind: "session" } } };
    const id = subscribed(request);
    // Live events go to the subscription only once its catch-up is sent, as an environment catching up sends them after it.
    const catchUp = () => {
      wire.server.send({ type: "snapshot", subscription: id, sequence: log.base, payload: { sequence: log.base, summary: summaryAt(sessionId), runs: [], items: [], parkedPrompts: [], rewinds: [] } });
      for (const event of log.events) wire.server.send({ type: "event", subscription: id, sequence: event.sequence, event });
      wire.server.send({ type: "synchronized", subscription: id, sequence });
      sessionSubscriptions.set(sessionId, id);
    };
    if (spec.holdSessions) held.push(catchUp);
    else catchUp();
    return undefined;
  });
  const held: (() => void)[] = [];
  let environmentSubscription: string | undefined;
  wire.answer("environment.subscribe", (_params, request) => {
    environmentSubscription = subscribed(request);
    // With the `setup` flag, a snapshot carrying every step's result as the environment last checked it (#569).
    if (flagged) {
      const payload = { status: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false }, setup: setup.snapshot() };
      wire.server.send({ type: "snapshot", subscription: environmentSubscription, sequence, payload });
    }
    wire.server.send({ type: "synchronized", subscription: environmentSubscription, sequence });
    return undefined;
  });
  let usage: readonly AccountUsage[] = [];
  wire.answer("accounts.usage", () => ({ result: { readings: [...usage] } }));
  /** Says a notice on the environment's own stream, as the environment does. */
  const notice = (type: string, payload: Record<string, unknown>) => {
    const at = ++sequence;
    const event: EventEnvelope = {
      sequence: at,
      eventId: `0199fe00-0000-7000-8000-${String(at).padStart(12, "0")}`,
      streamKind: ENVIRONMENT_STREAM_KIND,
      streamId: wire.environmentId,
      streamVersion: at,
      type,
      occurredAt: clock.now().toISOString(),
      commandId: null,
      causationId: null,
      correlationId: null,
      actor: { kind: "system", id: "script" },
      payload,
      metadata: {},
    };
    if (environmentSubscription) wire.server.send({ type: "event", subscription: environmentSubscription, sequence: at, event });
  };
  const flagged = spec.capabilities?.includes("setup") ?? false;
  const setup = scriptedSetup({ clock, wire, flagged, script: spec.setup, notice });
  const setUsage = (readings: readonly AccountUsage[]) => {
    usage = readings;
    for (const reading of readings) notice("usage.updated", { accountId: reading.accountId, identity: reading.identity });
  };

  /** The summary a session's snapshot holds: its creation's, since everything after is replayed on top of it. */
  const created = new Map<string, SessionSummary>(sessions.map((s) => [s.id, s]));
  const summaryAt = (sessionId: string): SessionSummary => created.get(sessionId) as SessionSummary;
  const summaryNow = (sessionId: string): SessionSummary => {
    const found = sessions.find((s) => s.id === sessionId);
    if (!found) throw new Error(`${spec.name} holds no session ${sessionId}.`);
    return found;
  };
  const setSummary = (summary: SessionSummary) => {
    const at = sessions.findIndex((s) => s.id === summary.id);
    if (at === -1) sessions.push(summary);
    else sessions[at] = summary;
  };

  // Each session's queue, kept in step with what its log says (ADR 0022): a message queued by `message.sent`, its holder
  // moved by `message.requeued`, and gone once a run reads it (`message.delivered`, a `run.started` carrying it) or it is
  // withdrawn, when why it is gone is kept for the environment's `not_found`.
  type Queued = { readonly messageId: string; readonly runId: string; readonly text: string; heldBy: QueueHolder };
  const queues = new Map<string, Queued[]>();
  const gone = new Map<string, string>();
  const queueOf = (sessionId: string): Queued[] => {
    let queue = queues.get(sessionId);
    if (queue === undefined) queues.set(sessionId, (queue = []));
    return queue;
  };
  const followQueue = (sessionId: string, type: string, payload: Record<string, unknown>) => {
    const queue = queueOf(sessionId);
    const drop = (ids: readonly unknown[], why: string) => {
      for (const id of ids) gone.set(String(id), why);
      queues.set(sessionId, queue.filter((message) => !ids.includes(message.messageId)));
    };
    if (type === "message.sent" && payload["delivery"] === "queued") {
      queue.push({ messageId: String(payload["messageId"]), runId: String(payload["runId"]), text: String(payload["text"]), heldBy: (payload["heldBy"] as QueueHolder | null) ?? "environment" });
    } else if (type === "message.requeued") {
      const message = queue.find((m) => m.messageId === payload["messageId"]);
      if (message) message.heldBy = "environment";
    } else if (type === "message.withdrawn") drop([payload["messageId"]], "it was withdrawn already");
    else if (type === "message.delivered") drop([payload["messageId"]], "a run has read it");
    else if (type === "run.started") drop(payload["queuedMessageIds"] as readonly unknown[], "a run has read it");
  };

  const emit: EnvironmentHandle["emit"] = (sessionId, type, payload, change = {}) => {
    const entry = eventTypeEntry(SESSION_STREAM_KIND, type);
    const checkedPayload = entry ? (entry.payload.parse(payload) as Record<string, unknown>) : payload;
    const patch: SummaryPatch | undefined = change.patch ?? (change.fields ? { op: "set", sessionId, fields: change.fields } : undefined);
    if (patch?.op === "add") {
      setSummary(patch.summary);
      created.set(patch.summary.id, patch.summary);
      logs.set(patch.summary.id, { base: sequence, events: [] });
    } else if (patch?.op === "set") setSummary(SessionSummary.parse({ ...summaryNow(sessionId), ...patch.fields }));
    const log = logs.get(sessionId);
    if (!log) throw new Error(`${spec.name} holds no session ${sessionId}.`);
    const at = ++sequence;
    const event: EventEnvelope = {
      sequence: at,
      eventId: `0199ff00-0000-7000-8000-${String(at).padStart(12, "0")}`,
      streamKind: SESSION_STREAM_KIND,
      streamId: sessionId,
      streamVersion: log.events.length + 1,
      type,
      occurredAt: clock.now().toISOString(),
      commandId: null,
      causationId: null,
      correlationId: null,
      actor: change.actor ?? (type === "message.sent" ? { kind: "client_session", id: "script" } : { kind: "system", id: "script" }),
      payload: checkedPayload,
      metadata: patch ? { [LIST_PATCH_KEY]: patch } : {},
    };
    log.events.push(event);
    followQueue(sessionId, type, checkedPayload);
    const own = sessionSubscriptions.get(sessionId);
    if (own) wire.server.send({ type: "event", subscription: own, sequence: at, event });
    if (patch || isListEvent(SESSION_STREAM_KIND, type)) list.publish(event);
    return event;
  };

  const live = new Map<string, string>();
  const records = (attachments: readonly AttachmentInput[] = []) =>
    attachments.map((a) => ({ kind: a.kind, name: a.name, mediaType: a.mediaType, size: Math.floor((a.data.length * 3) / 4) }));
  let runs = 0;
  const minted = (prefix: string) => `${prefix}-0000-4000-8000-${String(++runs).padStart(12, "0")}`;
  // The account each session forked here runs on, as `sessions.fork` names it: a summary names it only once a run has used it (a created one's carries
  // the account `sessions.create` named, `scripted-list.ts`).
  const sessionAccounts = new Map<string, string>();
  const ceiling = (): Mode => (hello.ceiling as Mode | undefined) ?? "bypassPermissions";
  /** Starts a run with a prompt, or (`text` null) a run of the queue carrying `queued`, as the environment starts one after a read-now. */
  const beginRun = (
    sessionId: string,
    text: string | null,
    attachments: readonly AttachmentInput[] | undefined,
    queued: readonly string[],
    choice: { readonly model?: string; readonly effort?: string } = {},
  ) => {
    const runId = minted("0199a100");
    const messageId = text === null ? null : minted("0199a200");
    const summary = summaryNow(sessionId);
    const accountId = sessionAccounts.get(sessionId) ?? summary.accountId ?? "account-1";
    // As the environment's run does (#1961): the model asked for, else the session's; the session's effort while on its model.
    const model = choice.model ?? summary.runChoice?.model ?? summary.model ?? "claude-fake";
    const effort = choice.effort ?? (summary.runChoice?.model === model ? summary.runChoice.effort : null);
    // As the environment's run does: the session's mode asked for, clamped to the ceiling; acceptEdits when the session has none.
    const requested = summary.mode;
    const effective = lowerMode(requested ?? "acceptEdits", ceiling());
    const clamped = requested !== null && compareModes(effective, requested) < 0;
    if (text !== null) emit(sessionId, "message.sent", { runId, messageId, text, attachments: records(attachments), delivery: "prompt", heldBy: null, ceiling: ceiling() });
    emit(
      sessionId,
      "run.started",
      {
        runId,
        accountId,
        identity: null,
        model,
        effort,
        mode: { requested, effective, clamped },
        workspace: summary.workspace,
        origin: "client",
        promptMessageId: messageId,
        queuedMessageIds: [...queued],
        resumedFrom: null,
        forkedFrom: null,
      },
      // As the environment's run.started does, the summary takes the run's account and model, and its model and effort for the next run.
      { fields: { activity: { state: "running", since: clock.now().toISOString() }, accountId, model, runChoice: { model, effort } } },
    );
    for (const id of queued) emit(sessionId, "message.delivered", { runId, messageId: id, delivery: "prompt" });
    live.set(sessionId, runId);
    return { runId, messageId };
  };
  const startRun: EnvironmentHandle["startRun"] = (sessionId, text, attachments, choice = {}) => {
    const { runId, messageId } = beginRun(sessionId, text, attachments, [], choice);
    return { runId, messageId: messageId as string };
  };
  const endRun: EnvironmentHandle["endRun"] = (sessionId, runId, end = {}) => {
    const reason = end.reason ?? "completed";
    // The environment takes back what the provider holds of a run it did not see complete, in the transaction of its end.
    if (reason !== "completed") {
      for (const message of queueOf(sessionId).filter((m) => m.heldBy === "provider" && m.runId === runId)) {
        emit(sessionId, "message.requeued", { runId, messageId: message.messageId });
      }
    }
    emit(
      sessionId,
      "run.ended",
      {
        runId,
        reason,
        cause: reason === "interrupted" ? (end.cause ?? "user") : null,
        error: reason === "error" ? { message: "The run failed.", code: null } : null,
        usage: end.usage ?? null,
        durationMs: end.durationMs ?? 1000,
        turnCount: null,
        resultText: null,
      },
      { fields: { activity: { state: "idle", since: clock.now().toISOString() } } },
    );
    if (live.get(sessionId) === runId) live.delete(sessionId);
    // The run of the queue: what the environment holds, read as the next run's prompt. After an interrupt nothing starts
    // (a read-now starts its run itself), and what the provider holds is read by a turn the provider opens, not modelled here.
    if (reason !== "interrupted") startFromQueue(sessionId);
  };
  /** The messages the environment holds for the session, in the order sent: what a run of the queue reads. */
  const environmentHeld = (sessionId: string) => queueOf(sessionId).filter((m) => m.heldBy === "environment").map((m) => m.messageId);
  /** Starts the run of the environment's queue, when it holds anything; the run's id, else undefined. */
  const startFromQueue = (sessionId: string): string | undefined => {
    const queued = environmentHeld(sessionId);
    return queued.length === 0 ? undefined : beginRun(sessionId, null, undefined, queued).runId;
  };

  // A run's file tools, as Claude's name them: the call, then the file as the environment reads it.
  let fileCalls = 0;
  const fileCall = (sessionId: string, runId: string, name: string, input: Record<string, unknown>): string => {
    const toolCallId = `toolu-${name.toLowerCase()}-${++fileCalls}`;
    emit(sessionId, "tool.started", { runId, toolCallId, name, input, title: null, agentId: null, parentToolCallId: null });
    emit(sessionId, "tool.ended", { runId, toolCallId, status: "ok", output: null, durationMs: 20 });
    return toolCallId;
  };
  const inWorkspaceOf = (sessionId: string, path: string) => `${summaryNow(sessionId).workspace.path.replace(/\/+$/, "")}/${path}`;
  const writeFile: EnvironmentHandle["writeFile"] = (sessionId, runId, path, text) => {
    contents.set(path, text);
    if (!listed.includes(path)) listed.push(path);
    return fileCall(sessionId, runId, "Write", { file_path: inWorkspaceOf(sessionId, path), content: text });
  };
  const editFile: EnvironmentHandle["editFile"] = (sessionId, runId, path, oldText, newText) => {
    const text = contents.get(path);
    if (typeof text !== "string") throw new Error(`${spec.name} holds no text at ${path} to edit.`);
    contents.set(path, text.replace(oldText, () => newText));
    return fileCall(sessionId, runId, "Edit", { file_path: inWorkspaceOf(sessionId, path), old_string: oldText, new_string: newText });
  };

  // Parked prompts and their answers (`scripted-prompts.ts`).
  const { prompts, answer: answerPrompt } = scriptedPrompts({
    clock,
    wire,
    emit,
    notice,
    summary: summaryNow,
    liveRun: (sessionId) => live.get(sessionId),
    nextSequence: () => ++sequence,
  });
  wire.answer("permissions.prompts.answer", (params) => answerPrompt(params));

  // The run commands, as the environment answers them (claude-adapter spec, "Wire methods"; ADR 0022): a start or a send
  // with no run live starts one; a send during a live run is queued, held by whoever the script says holds the queue; an
  // interrupt ends the run. A receipt the script rejects is answered as it is, and nothing is appended.
  const acceptedWith = (result: Record<string, unknown>): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence, changed: true }, result } });
  /** A scripted rejection of `method`; its receipt carries a new head, or the head it found (`advance` false) as a terminal command's does. */
  const rejection = (method: string, advance = true): FakeAnswer | undefined => {
    const scriptedReceipt = spec.receipts?.[method];
    if (scriptedReceipt === undefined || scriptedReceipt === "accepted") return undefined;
    const message = scriptedReceipt.message ?? `Rejected: ${scriptedReceipt.rejected}.`;
    const at = advance ? ++sequence : sequence;
    return {
      result: {
        receipt: { status: "rejected", sequence: at, changed: false, reason: scriptedReceipt.rejected, error: { code: scriptedReceipt.rejected, message, data: { ...scriptedReceipt.data } } },
      },
    };
  };
  const attachmentsOf = (params: Record<string, unknown>) => (params["attachments"] as readonly AttachmentInput[] | undefined) ?? [];
  /** The run's effort as the environment's decider takes it (#1950): the command's, its null the model's own; else `accounts.defaultEffort` where the model takes it. */
  const effortOf = (sessionId: string, params: Record<string, unknown>): string | undefined => {
    const asked = params["effort"];
    if (asked !== undefined) return typeof asked === "string" ? asked : undefined;
    const model = typeof params["model"] === "string" ? params["model"] : summaryNow(sessionId).model;
    const preset = values["accounts.defaultEffort"];
    if (preset === null) return undefined;
    return (spec.models ?? []).some((catalogue) => catalogue.models?.some((entry) => entry.id === model && entry.efforts.includes(preset))) ? preset : undefined;
  };
  wire.answer("runs.start", (params) => {
    const refused = rejection("runs.start");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    if (live.has(sessionId)) {
      return { result: { receipt: { status: "rejected", sequence: ++sequence, changed: false, reason: "conflict", error: { code: "conflict", message: "A run is live.", data: { reason: "run_active" } } } } };
    }
    const effort = effortOf(sessionId, params);
    const choice = { ...(typeof params["model"] === "string" && { model: params["model"] }), ...(effort !== undefined && { effort }) };
    return acceptedWith(startRun(sessionId, String(params["text"]), attachmentsOf(params), choice));
  });
  wire.answer("runs.send", (params) => {
    const refused = rejection("runs.send");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    const runId = live.get(sessionId);
    if (runId === undefined) return acceptedWith({ ...startRun(sessionId, String(params["text"]), attachmentsOf(params)), delivery: "prompt", heldBy: null });
    const messageId = minted("0199a200");
    const heldBy = spec.queue ?? "environment";
    emit(sessionId, "message.sent", { runId, messageId, text: String(params["text"]), attachments: records(attachmentsOf(params)), delivery: "queued", heldBy, ceiling: ceiling() });
    return acceptedWith({ runId, messageId, delivery: "queued", heldBy });
  });
  wire.answer("runs.interrupt", (params) => {
    const refused = rejection("runs.interrupt");
    if (refused) return refused;
    const runId = String(params["runId"]);
    const sessionId = [...live.entries()].find(([, id]) => id === runId)?.[0];
    if (sessionId === undefined) return acceptedWith({ runId, ended: true });
    if (spec.interruptHolds === true) return acceptedWith({ runId, ended: false });
    endRun(sessionId, runId, { reason: "interrupted" });
    return acceptedWith({ runId, ended: false });
  });
  // Read now (ADR 0022): with a run live, it ends interrupted with cause read-now (its end hands back what the provider held),
  // and the next run starts carrying the whole queue in order; with none live, the run of what the environment holds starts
  // at once, and what the provider holds is left to the turn it opens; with nothing to read, nothing happens.
  wire.answer("runs.readNow", (params) => {
    const refused = rejection("runs.readNow");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    const liveRun = live.get(sessionId);
    if (liveRun === undefined) return acceptedWith({ sessionId, interruptedRunId: null, runId: startFromQueue(sessionId) ?? null });
    if (queueOf(sessionId).length === 0) return acceptedWith({ sessionId, interruptedRunId: null, runId: null });
    endRun(sessionId, liveRun, { reason: "interrupted", cause: "read-now" });
    startFromQueue(sessionId);
    return acceptedWith({ sessionId, interruptedRunId: liveRun, runId: null });
  });
  // Withdraw (ADR 0022): a queued message taken back, a provider's requeued first; its text goes to the draft, in place of
  // an empty one, else after it on a paragraph of its own. One not queued, or one the provider holds with no run live (a
  // turn it opens reads it), is not_found, in the environment's words.
  const notFound = (messageId: string, why: string): FakeAnswer => ({
    result: {
      receipt: {
        status: "rejected",
        sequence: ++sequence,
        changed: false,
        reason: "not_found",
        error: { code: "not_found", message: `No queued message ${messageId} is on this environment: ${why}.`, data: { kind: "message", messageId } },
      },
    },
  });
  wire.answer("runs.withdraw", (params) => {
    const refused = rejection("runs.withdraw");
    if (refused) return refused;
    const messageId = String(params["messageId"]);
    const found = [...queues.entries()].flatMap(([sessionId, queue]) => queue.filter((m) => m.messageId === messageId).map((m) => ({ sessionId, message: m })))[0];
    if (found === undefined) return notFound(messageId, gone.get(messageId) ?? "it was never sent here, or its session was purged");
    if (found.message.heldBy === "provider" && !live.has(found.sessionId)) return notFound(messageId, "the provider has read it");
    const { sessionId, message } = found;
    const heldBy = message.heldBy;
    if (heldBy === "provider") emit(sessionId, "message.requeued", { runId: message.runId, messageId });
    emit(sessionId, "message.withdrawn", { runId: message.runId, messageId, heldBy });
    const before = summaryNow(sessionId).draft;
    const draft = before === null || before.length === 0 ? message.text : `${before}\n\n${message.text}`;
    emit(sessionId, "session.draft-set", { draft }, { fields: { draft } });
    return acceptedWith({ messageId, sessionId, heldBy });
  });
  wire.answer("runs.stopTask", (params) => rejection("runs.stopTask") ?? acceptedWith({ runId: params["runId"], taskId: params["taskId"], ended: false }));
  // The session's next-run model and effort (#1961), as the environment decides them: refused while a run is live.
  wire.answer("sessions.setModel", (params) => {
    const refused = rejection("sessions.setModel");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    if (live.has(sessionId)) {
      return { result: { receipt: { status: "rejected", sequence: ++sequence, changed: false, reason: "conflict", error: { code: "conflict", message: "A run is live.", data: { reason: "run_active" } } } } };
    }
    const runChoice = { model: String(params["model"]), effort: (params["effort"] as string | null | undefined) ?? null };
    emit(sessionId, "session.model-set", runChoice, { fields: { runChoice } });
    return acceptedWith({ summary: summaryNow(sessionId) });
  });
  wire.answer("sessions.setDraft", (params) => {
    const refused = rejection("sessions.setDraft");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    const draft = (params["draft"] as string | null | undefined) || null;
    emit(sessionId, "session.draft-set", { draft }, { fields: { draft } });
    return acceptedWith({ summary: summaryNow(sessionId) });
  });
  // Fork and rewind (ADR 0022), as the environment's `sessions/fork-rewind.ts` answers them: over the user messages a run
  // has read that no rewind standing hides, each at the sequence of its `message.sent`.
  type Prompt = { readonly messageId: string; readonly text: string; readonly sequence: number };
  type Rewind = { readonly sequence: number; readonly toMessageId: string; undone: boolean };
  const eventsOf = (sessionId: string): readonly EventEnvelope[] => logs.get(sessionId)?.events ?? [];
  const payloadOf = (event: EventEnvelope) => event.payload as Record<string, unknown>;
  const rewindsOf = (sessionId: string): Rewind[] => {
    const rewinds: Rewind[] = [];
    for (const event of eventsOf(sessionId)) {
      const payload = payloadOf(event);
      if (event.type === "session.rewound") rewinds.push({ sequence: event.sequence, toMessageId: String(payload["toMessageId"]), undone: false });
      if (event.type === "session.rewind-undone") {
        const undone = rewinds.find((rewind) => rewind.sequence === payload["rewindSequence"]);
        if (undone) undone.undone = true;
      }
    }
    return rewinds;
  };
  /** The session's visible user messages, in order: sent as a prompt or read by a run since, and not hidden by a rewind standing. */
  const visiblePrompts = (sessionId: string): Prompt[] => {
    const sent = new Map<string, Prompt>();
    const read: Prompt[] = [];
    for (const event of eventsOf(sessionId)) {
      const payload = payloadOf(event);
      if (event.type === "message.sent") {
        const prompt = { messageId: String(payload["messageId"]), text: String(payload["text"]), sequence: event.sequence };
        sent.set(prompt.messageId, prompt);
        if (payload["delivery"] !== "queued") read.push(prompt);
      } else if (event.type === "message.delivered") {
        const prompt = sent.get(String(payload["messageId"]));
        if (prompt && !read.includes(prompt)) read.push(prompt);
      }
    }
    const standing = rewindsOf(sessionId).filter((rewind) => !rewind.undone);
    const hidden = (prompt: Prompt) =>
      standing.some((rewind) => (sent.get(rewind.toMessageId)?.sequence ?? Number.POSITIVE_INFINITY) <= prompt.sequence && prompt.sequence < rewind.sequence);
    return read.filter((prompt) => !hidden(prompt)).sort((a, b) => a.sequence - b.sequence);
  };
  /** Whether a run of the session has started here, which links its provider session. */
  const linked = (sessionId: string): boolean => eventsOf(sessionId).some((event) => event.type === "run.started");
  /** A fork's own record, its `session.forked`; null for a session not forked here. */
  const forkRecordOf = (sessionId: string): { readonly atMessageId: string | null; readonly fromProviderSessionId: string | null } | null => {
    const forked = eventsOf(sessionId).find((event) => event.type === "session.forked");
    if (forked === undefined) return null;
    const payload = payloadOf(forked);
    return { atMessageId: (payload["atMessageId"] as string | null) ?? null, fromProviderSessionId: (payload["fromProviderSessionId"] as string | null) ?? null };
  };
  /** The latest rewind standing while no run has continued from it: none since has ended `completed` (`pendingRewind`). */
  const pendingRewind = (sessionId: string): Rewind | undefined => {
    const latest = rewindsOf(sessionId)
      .filter((rewind) => !rewind.undone)
      .at(-1);
    if (latest === undefined) return undefined;
    const continued = eventsOf(sessionId).some((event) => event.type === "run.ended" && event.sequence > latest.sequence && payloadOf(event)["reason"] === "completed");
    return continued ? undefined : latest;
  };
  /** Whether the provider's conversation holds anything before `messageId`: not for the session's first message, unless it is a fork that carried its source's in (`historyBefore`). */
  const historyBefore = (sessionId: string, prompts: readonly Prompt[], messageId: string): boolean =>
    prompts[0]?.messageId !== messageId || (forkRecordOf(sessionId)?.fromProviderSessionId ?? null) !== null;
  // What each rewind wrote into the draft and the draft it replaced, by the rewind's sequence: what an undo puts back.
  const rewoundDrafts = new Map<number, { readonly wrote: string | null; readonly before: string | null }>();
  const refusedWith = (code: string, message: string, data: Record<string, unknown>): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence: ++sequence, changed: false, reason: code, error: { code, message, data } } },
  });
  /** A message a command names that is not a user message of the session's visible transcript (`messageNotFound`). */
  const messageNotFound = (sessionId: string, messageId: string): FakeAnswer =>
    refusedWith("not_found", `No message ${messageId} is in the visible transcript of session ${sessionId}.`, { kind: "message", sessionId, messageId });
  const adapter = (): AdapterCapabilities => providerOf((spec.providers ?? [spec.provider ?? {}])[0]);
  /** The environment's `unsupported` (`adapter/capabilities.ts`): a wire error, thrown, never a receipt. */
  const unsupported = (flag: "fork" | "rewind", path: readonly string[], what: string): FakeAnswer => {
    const { displayName, provider } = adapter();
    const message = `The ${displayName} adapter cannot ${what}: it does not declare ${flag}.`;
    const error = invalidParams([{ code: "custom", path: [...path], message }], message);
    return { error: { ...error, data: { ...error.data, reason: "unsupported", capability: flag, provider } } };
  };
  wire.answer("sessions.fork", (params) => {
    const refused = rejection("sessions.fork");
    if (refused) return refused;
    const source = summaryNow(String(params["sessionId"]).toLowerCase());
    const id = String(params["id"]).toLowerCase();
    const at = clock.now().toISOString();
    // The anchor: the message asked for, else a rewind the source has not continued from.
    const prompts = visiblePrompts(source.id);
    let anchor: Prompt | undefined;
    if (typeof params["atMessageId"] === "string") {
      const asked = params["atMessageId"].toLowerCase();
      anchor = prompts.find((prompt) => prompt.messageId === asked);
      if (anchor === undefined) return messageNotFound(source.id, asked);
    }
    let atMessageId: string | null;
    let fromProviderSessionId: string | null;
    let inheritedDraft: string | null = null;
    if (linked(source.id)) {
      atMessageId = anchor?.messageId ?? pendingRewind(source.id)?.toMessageId ?? null;
      fromProviderSessionId = atMessageId === null || historyBefore(source.id, prompts, atMessageId) ? `provider-${source.id}` : null;
    } else {
      // A source no run of which has linked a provider session continues what its own fork named.
      const inherited = forkRecordOf(source.id);
      fromProviderSessionId = inherited?.fromProviderSessionId ?? null;
      atMessageId = fromProviderSessionId !== null ? (inherited?.atMessageId ?? null) : (anchor?.messageId ?? inherited?.atMessageId ?? null);
      if (anchor === undefined && atMessageId !== null && inherited !== null) {
        const forked = eventsOf(source.id).find((event) => event.type === "session.forked");
        const saved = eventsOf(source.id).find((event) => event.type === "session.draft-set" && forked !== undefined && event.sequence < forked.sequence);
        const text = saved === undefined ? null : payloadOf(saved)["draft"];
        inheritedDraft = typeof text === "string" ? text : null;
      }
    }
    if (fromProviderSessionId !== null && !adapter().fork) return unsupported("fork", params["account"] === undefined ? ["sessionId"] : ["account"], "fork a session");
    // On the account named, else the source's (sessions.fork).
    const account = typeof params["account"] === "string" ? params["account"] : (sessionAccounts.get(source.id) ?? source.accountId);
    if (account !== null) sessionAccounts.set(id, account);
    // The source's title (generated on the fork until the provider's replaces it), tags and group, never its archive, pins
    // or settle; the anchored text as the draft.
    const titled = typeof params["title"] === "string" ? params["title"] : null;
    const carriedTitle = titled === null ? generatedTitle(source.title) : null;
    const draft = (anchor?.text ?? inheritedDraft ?? "").slice(0, MAX_DRAFT_LENGTH);
    const summary = summaryOf(
      clock,
      {
        id,
        ...(titled !== null ? { title: titled, titleSource: "user" as const } : carriedTitle !== null ? { title: carriedTitle, titleSource: "generated" as const } : {}),
        tags: source.tags,
        groupId: source.groupId,
        workspace: source.workspace,
        accountId: account,
        draft: draft === "" ? null : draft,
        createdAt: at,
        updatedAt: at,
      },
      sessions.length,
    );
    const transcript = reduceSession({ runs: [], items: [], parkedPrompts: [], rewinds: [], instructions: "" }, eventsOf(source.id));
    const copied = transcript.items.flatMap((item) => {
      if (item.kind === "forked") return item.history?.items ?? [];
      if (item.kind === "rewound") return [];
      if (item.kind === "subagent") return item.calls.map((call) => TranscriptItem.parse(call));
      return [TranscriptItem.parse(item.kind === "question" || item.kind === "plan" ? { ...item, kind: "prompt" } : item)];
    });
    const items = copied.filter((item) => item.sequence < (anchor?.sequence ?? Number.POSITIVE_INFINITY));
    const copiedRuns = new Set(items.flatMap((item) => "runId" in item && typeof item.runId === "string" ? [item.runId] : []));
    const history = { title: source.title, anchor: anchor?.text ?? null, items,
      runs: [...transcript.runs, ...transcript.items.flatMap((item) => item.kind === "forked" ? item.history?.runs ?? [] : [])].filter((run) => copiedRuns.has(run.runId)),
    };
    // In the environment's order: created, title-generated, draft-set, forked.
    emit(
      id,
      "session.created",
      { title: titled, tags: [...source.tags], groupId: source.groupId, workspace: summary.workspace, repositoryIdentity: null, account, model: null, mode: null },
      { patch: { op: "add", summary } },
    );
    if (carriedTitle !== null) emit(id, "session.title-generated", { title: carriedTitle, source: "prompt" });
    if (draft !== "") emit(id, "session.draft-set", { draft }, { fields: { draft } });
    emit(id, "session.forked", { fromSessionId: source.id, atMessageId, fromProviderSessionId, history });
    return acceptedWith({ summary });
  });
  // The workspace's files, which a run's writes and edits (`writeFile`, `editFile`) change.
  const listed = [...(spec.files ?? [])];
  const contents = new Map<string, ScriptedFile>(Object.entries(spec.fileContents ?? {}));
  wire.answer("files.list", () => ({ result: { files: [...listed], truncated: spec.filesTruncated ?? false, source: "git" } }));
  // The directories the picker browses and inspects, and a worktree request is made from (`scripted-folders.ts`).
  const folders = scriptedFolders({ home: SCRIPTED_HOME, now: () => clock.now().toISOString(), ...(spec.folders !== undefined && { folders: spec.folders }) });
  wire.answer("workspaces.browse", (params) => folders.browse(params));
  wire.answer("workspaces.inspect", (params) => folders.inspect(params));
  wire.answer("files.read", (params) => {
    const path = String(params["path"]);
    const file = contents.get(path);
    if (file === undefined) {
      if (listed.some((f) => f.startsWith(`${path}/`))) {
        return { error: { code: "invalid_params", message: `${path} is not a file.`, data: { reason: "not_a_file" } } };
      }
      return { error: { code: "not_found", message: `No file ${path} in the workspace.`, data: { kind: "file" } } };
    }
    if (typeof file === "string") return { result: { path, size: utf8Size(file), binary: false, truncated: false, text: file } };
    if ("binary" in file) return { result: { path, size: file.size, binary: true, truncated: false, text: null } };
    return { result: { path, size: file.size, binary: false, truncated: true, text: file.text } };
  });
  wire.answer("diffs.session", () => ({ result: { files: [...(spec.sessionDiff?.files ?? [])], truncated: spec.sessionDiff?.truncated ?? false } }));
  wire.answer("diffs.workingTree", () => {
    const tree = spec.workingTree ?? { diff: "" };
    if ("refused" in tree) return { error: { code: "conflict", message: tree.message, data: { reason: tree.refused } } };
    return { result: { diff: tree.diff, truncated: tree.truncated ?? false, repository: tree.repository ?? true } };
  });

  // Terminals (#124's vocabulary), as the environment answers them: a terminal is opened with the client's id, sized, written
  // to and closed by commands; its output is a chunk sequence of its own, which a subscription gets as a snapshot from cursor
  // 0 (or from one before what it keeps), else as the chunks after the cursor, then live; its exit ends every subscription.
  interface HeldTerminal {
    readonly id: string;
    /** Its place among the terminals held, from 0: its events' ids are its own, as the environment mints each chunk's. */
    readonly index: number;
    readonly owner: TerminalInfo["owner"];
    readonly sessionId: string | null;
    readonly openedAt: string;
    cols: number;
    rows: number;
    readonly env: Readonly<Record<string, string>>;
    readonly chunks: { readonly sequence: number; readonly data: string }[];
    /** The newest chunk's sequence, and whether the cap has dropped any: neither goes back when the chunks kept are emptied. */
    last: number;
    cut: boolean;
    readonly writes: string[];
    readonly resizes: { readonly cols: number; readonly rows: number }[];
    /** How its shell ended, at what sequence, and when on the environment's clock, which its `terminal.exited` says every time it is sent. */
    exit: { readonly exitCode: number; readonly signal: number | null; readonly cause: TerminalExitCause; readonly sequence: number; readonly occurredAt: string } | null;
    closed: boolean;
    readonly subscriptions: Set<string>;
    /** A tool terminal's command, which hears what is typed and its end (`scripted-tools.ts`). */
    readonly tool: ToolTerminalHooks | undefined;
  }
  const terminals = new Map<string, HeldTerminal>();
  const infoOf = (t: HeldTerminal): TerminalInfo => {
    const fields = { id: t.id, openedAt: t.openedAt, cols: t.cols, rows: t.rows, exitCode: t.exit?.exitCode ?? null, signal: t.exit?.signal ?? null };
    // A tool terminal (#362) is the Managed tools registry's, serving no session.
    return t.sessionId === null ? { ...fields, owner: "managed-tools", sessionId: null } : { ...fields, owner: "session", sessionId: t.sessionId };
  };
  const lastOf = (t: HeldTerminal) => t.last;
  const terminalEnvelope = (t: HeldTerminal, at: number, type: string, payload: Record<string, unknown>, occurredAt = clock.now().toISOString()): EventEnvelope => ({
    sequence: at,
    // Unique per terminal and chunk, and apart from the session and environment streams' (their own first group).
    eventId: `0199fd00-${t.index.toString(16).padStart(4, "0")}-7000-8000-${String(at).padStart(12, "0")}`,
    streamKind: TERMINAL_STREAM_KIND,
    streamId: t.id,
    streamVersion: at,
    type,
    occurredAt,
    commandId: null,
    causationId: null,
    correlationId: null,
    actor: { kind: "system", id: "script" },
    payload,
    metadata: {},
  });
  const exitedEnvelope = (t: HeldTerminal) => {
    const exit = t.exit as NonNullable<HeldTerminal["exit"]>;
    return terminalEnvelope(t, exit.sequence, TERMINAL_EXITED_TYPE, { exitCode: exit.exitCode, signal: exit.signal, cause: exit.cause }, exit.occurredAt);
  };
  const hold = (
    id: string,
    sessionId: string | null,
    fields: { readonly cols?: number | undefined; readonly rows?: number | undefined; readonly env?: Record<string, string> | undefined },
    tool?: ToolTerminalHooks,
  ): HeldTerminal => {
    const t: HeldTerminal = {
      id,
      index: terminals.size,
      owner: tool === undefined ? "session" : "managed-tools",
      sessionId,
      openedAt: clock.now().toISOString(),
      cols: fields.cols ?? 80,
      rows: fields.rows ?? 24,
      env: fields.env ?? {},
      chunks: [],
      last: 0,
      cut: false,
      writes: [],
      resizes: [],
      exit: null,
      closed: false,
      subscriptions: new Set(),
      tool,
    };
    terminals.set(id, t);
    return t;
  };
  /** Sends on the client's socket; with none open (dropped) a chunk is only kept, for the replay after the reconnect. */
  const toSubscriber = (frame: Frame) => {
    try {
      wire.server.send(frame);
    } catch {
      // No socket: nothing to say it on.
    }
  };
  const terminalOutput = (id: string, data: string) => {
    const t = terminals.get(id);
    if (!t || t.exit) throw new Error(`${spec.name} holds no running terminal ${id}.`);
    const at = lastOf(t) + 1;
    t.last = at;
    t.chunks.push({ sequence: at, data });
    for (const subscription of t.subscriptions) toSubscriber({ type: "event", subscription, sequence: at, event: terminalEnvelope(t, at, TERMINAL_OUTPUT_TYPE, { data }) });
  };
  const exitTerminal = (id: string, exitCode: number, cause: TerminalExitCause = "exited", signal: number | null = null) => {
    const t = terminals.get(id);
    if (!t || t.exit) return;
    t.exit = { exitCode, signal, cause, sequence: lastOf(t) + 1, occurredAt: clock.now().toISOString() };
    const event = exitedEnvelope(t);
    for (const subscription of t.subscriptions) {
      toSubscriber({ type: "event", subscription, sequence: event.sequence, event });
      toSubscriber({ type: "end", subscription, reason: cause === "deleted" ? "deleted" : "closed" });
    }
    t.subscriptions.clear();
    t.tool?.ended({ exitCode, signal, cause });
    // A tool terminal is kept TOOL_TERMINAL_KEPT_MS on the environment's clock after its command exits, then closed, telling no one (#362).
    if (t.owner === "managed-tools" && !t.closed) clock.setTimeout(() => void (t.closed = true), TOOL_TERMINAL_KEPT_MS);
  };
  for (const held of spec.terminals ?? []) {
    const t = hold(held.id.toLowerCase(), sessions[held.session ?? 0]?.id ?? "", { cols: held.cols, rows: held.rows });
    if (held.output !== undefined) {
      t.chunks.push({ sequence: 1, data: held.output });
      t.last = 1;
    }
    if (held.exitCode !== undefined) t.exit = { exitCode: held.exitCode, signal: null, cause: "exited", sequence: lastOf(t) + 1, occurredAt: clock.now().toISOString() };
  }
  /** A terminal command's accepted receipt; a rejection the script names is answered before the command acts, as the environment refuses one. */
  const terminalReceipt = (result: Record<string, unknown>): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence, changed: false }, result } });
  const conflict = (reason: string, message: string): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence, changed: false, reason: "conflict", error: { code: "conflict", message, data: { reason } } } },
  });
  const unknownTerminal = (id: string): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence, changed: false, reason: "not_found", error: { code: "not_found", message: `No terminal ${id} is open.`, data: { kind: "terminal" } } } },
  });
  let heldOpens: (() => void)[] | null = null;
  for (const method of ["terminals.open", "terminals.run"] as const) {
    wire.answer(method, (params) => (heldOpens === null ? openTerminal(params, method) : new Promise<FakeAnswer>((resolve) => heldOpens?.push(() => resolve(openTerminal(params, method))))));
  }
  const openTerminal = (params: Record<string, unknown>, method: string): FakeAnswer => {
    const refused = rejection(method, false);
    if (refused) return refused;
    const id = String(params["id"]).toLowerCase();
    if (terminals.has(id)) return conflict("exists", `A terminal ${id} was opened on this environment already.`);
    const t = hold(id, String(params["sessionId"]).toLowerCase(), {
      cols: params["cols"] as number | undefined,
      rows: params["rows"] as number | undefined,
      env: params["env"] as Record<string, string> | undefined,
    });
    // The login shell's prompt, a moment after it starts.
    if (method === "terminals.open" && spec.terminalStartup !== undefined) terminalOutput(id, spec.terminalStartup);
    if (method === "terminals.open") later(() => t.exit === null && t.chunks.length === 0 && terminalOutput(id, "$ "));
    else later(() => {
      const ran = spec.oneOff?.(String(params["command"])) ?? { output: "", exitCode: 0 };
      terminalOutput(id, ran.output.replace(/\r?\n/g, "\r\n"));
      if (ran.exitCode !== undefined) exitTerminal(id, ran.exitCode);
    });
    return terminalReceipt({ terminal: infoOf(t) });
  };
  wire.answer("terminals.list", (params) => ({
    result: { terminals: [...terminals.values()].filter((t) => !t.closed && t.sessionId === String(params["sessionId"]).toLowerCase()).map(infoOf) },
  }));
  wire.answer("terminals.write", (params) => {
    const refused = rejection("terminals.write", false);
    if (refused) return refused;
    const id = String(params["id"]).toLowerCase();
    const t = terminals.get(id);
    if (!t || t.closed) return unknownTerminal(id);
    if (t.exit) return conflict("exited", "The terminal's shell has exited.");
    const data = String(params["data"]);
    t.writes.push(data);
    t.tool?.typed(data);
    return terminalReceipt({ id });
  });
  wire.answer("terminals.resize", (params) => {
    const refused = rejection("terminals.resize", false);
    if (refused) return refused;
    const id = String(params["id"]).toLowerCase();
    const t = terminals.get(id);
    if (!t || t.closed) return unknownTerminal(id);
    if (t.exit) return conflict("exited", "The terminal's shell has exited.");
    t.cols = Number(params["cols"]);
    t.rows = Number(params["rows"]);
    t.resizes.push({ cols: t.cols, rows: t.rows });
    return terminalReceipt({ terminal: infoOf(t) });
  });
  wire.answer("terminals.close", (params) => {
    const refused = rejection("terminals.close", false);
    if (refused) return refused;
    const id = String(params["id"]).toLowerCase();
    const t = terminals.get(id);
    if (!t || t.closed) return unknownTerminal(id);
    // Out of the list at once, as the environment drops it; its subscribers hear the hang-up after.
    t.closed = true;
    later(() => exitTerminal(id, 0, "closed", 1));
    return terminalReceipt({ id });
  });
  wire.answer("terminals.subscribe", (params, request) => {
    const id = String(params["id"]).toLowerCase();
    const t = terminals.get(id);
    if (!t || t.closed) return { error: { code: "not_found", message: `No terminal ${id} is open on this environment.`, data: { kind: "terminal", id } } };
    const subscription = subscribed(request);
    const after = Number(params["afterSequence"] ?? 0);
    const last = lastOf(t);
    const first = t.chunks[0]?.sequence ?? 0;
    if (after > 0 && after >= (t.chunks.length === 0 ? last : first - 1) && after <= last) {
      for (const chunk of t.chunks.filter((c) => c.sequence > after)) {
        wire.server.send({ type: "event", subscription, sequence: chunk.sequence, event: terminalEnvelope(t, chunk.sequence, TERMINAL_OUTPUT_TYPE, { data: chunk.data }) });
      }
    } else {
      // Truncated once the cap has dropped any chunk, as the environment's ring says.
      const payload = { terminal: infoOf(t), scrollback: t.chunks.map((c) => c.data).join(""), firstSequence: first, lastSequence: last, truncated: t.cut };
      wire.server.send({ type: "snapshot", subscription, sequence: last, payload });
    }
    if (t.exit) {
      const event = exitedEnvelope(t);
      wire.server.send({ type: "event", subscription, sequence: event.sequence, event });
      wire.server.send({ type: "end", subscription, reason: "closed" });
      return undefined;
    }
    wire.server.send({ type: "synchronized", subscription, sequence: last });
    t.subscriptions.add(subscription);
    return undefined;
  });
  // The rewinds a test holds (`holdRewinds`), each answered at the release; undefined while none are held.
  let heldRewinds: (() => void)[] | undefined;
  const holdable =
    (responder: FakeResponder): FakeResponder =>
    (params, request) => {
      const waiting = heldRewinds;
      if (waiting === undefined) return responder(params, request);
      return new Promise<FakeAnswer | undefined>((resolve) => waiting.push(() => resolve(responder(params, request))));
    };
  const holdRewinds = () => {
    heldRewinds ??= [];
    return () => {
      const waiting = heldRewinds ?? [];
      heldRewinds = undefined;
      for (const release of waiting) release();
    };
  };
  wire.answer("sessions.rewind", holdable((params) => {
    const refused = rejection("sessions.rewind");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]).toLowerCase();
    const messageId = String(params["messageId"]).toLowerCase();
    const running = live.get(sessionId);
    if (running !== undefined) return refusedWith("conflict", `A run of the session ${sessionId} is live; interrupt it before rewinding.`, { reason: "run_active", sessionId, runId: running });
    const queued = environmentHeld(sessionId);
    if (queued.length > 0) {
      return refusedWith("conflict", `The session ${sessionId} has queued messages the next run would read; withdraw them or let a run read them before rewinding.`, {
        reason: "queued_messages",
        sessionId,
        messageIds: queued,
      });
    }
    const prompts = visiblePrompts(sessionId);
    const target = prompts.find((prompt) => prompt.messageId === messageId);
    if (target === undefined) return messageNotFound(sessionId, messageId);
    if (!historyBefore(sessionId, prompts, messageId)) {
      return refusedWith("conflict", `The message ${messageId} is the session's first: start a new session with its text instead.`, { reason: "use_new_session", sessionId, messageId });
    }
    // The adapter asked is the one that holds the conversation: none before a run has linked one.
    if (linked(sessionId) && !adapter().rewind) return unsupported("rewind", ["messageId"], "rewind a session");
    const before = summaryNow(sessionId).draft;
    const rewound = emit(sessionId, "session.rewound", { toMessageId: messageId });
    const draft = target.text.slice(0, MAX_DRAFT_LENGTH);
    rewoundDrafts.set(rewound.sequence, { wrote: draft === "" ? null : draft, before });
    if (draft !== "") emit(sessionId, "session.draft-set", { draft }, { fields: { draft } });
    return acceptedWith({ sessionId, messageId });
  }));
  wire.answer("sessions.undoRewind", (params) => {
    const refused = rejection("sessions.undoRewind");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]).toLowerCase();
    const running = live.get(sessionId);
    if (running !== undefined) return refusedWith("conflict", `A run of the session ${sessionId} is live; interrupt it before undoing its rewind.`, { reason: "run_active", sessionId, runId: running });
    const latest = rewindsOf(sessionId)
      .filter((rewind) => !rewind.undone)
      .at(-1);
    if (latest === undefined) return refusedWith("not_found", `The session ${sessionId} has no rewind to undo.`, { kind: "rewind", sessionId });
    const since = eventsOf(sessionId).find((event) => event.type === "run.started" && event.sequence > latest.sequence);
    if (since !== undefined) {
      return refusedWith("conflict", `A run has started on the session ${sessionId} since its rewind; what the rewind hid stays hidden.`, {
        reason: "run_started",
        sessionId,
        runId: payloadOf(since)["runId"],
      });
    }
    emit(sessionId, "session.rewind-undone", { toMessageId: latest.toMessageId, rewindSequence: latest.sequence });
    // The draft the rewind replaced comes back while the draft still holds what the rewind wrote, and differs from it; a
    // draft changed since stays (`draftBefore`).
    const drafts = rewoundDrafts.get(latest.sequence);
    const current = summaryNow(sessionId).draft;
    if (drafts !== undefined && drafts.wrote !== null && current === drafts.wrote && drafts.before !== current) {
      emit(sessionId, "session.draft-set", { draft: drafts.before }, { fields: { draft: drafts.before } });
    }
    return acceptedWith({ sessionId, messageId: latest.toMessageId, rewindSequence: latest.sequence });
  });
  wire.answer("commands.list", (params) => {
    const sessionId = String(params["sessionId"]).toLowerCase();
    if (!sessions.some((s) => s.id === sessionId)) return { error: { code: "not_found", message: "No such session.", data: { kind: "session", sessionId } } };
    return { result: { accountId: "account-1", entries: [...(spec.commands ?? [])] } };
  });
  wire.answer("providers.list", () => ({ result: { providers: (spec.providers ?? [spec.provider ?? {}]).map((p) => providerOf(p)) } }));
  // A subagent's transcript, read from the provider's store on demand (#137): refused, as the environment's host refuses
  // it, while the session's provider (the script's first) does not declare `subagentTranscripts`.
  wire.answer("sessions.subagentTranscript", (params) => {
    const provider = providerOf((spec.providers ?? [spec.provider ?? {}])[0]);
    if (!provider.subagentTranscripts) {
      const message = `The ${provider.displayName} adapter cannot read a subagent's transcript: it does not declare subagentTranscripts.`;
      return { error: { code: "invalid_params", message, data: { reason: "unsupported", capability: "subagentTranscripts", provider: provider.provider } } };
    }
    const agentId = String(params["agentId"]);
    return { result: { sessionId: params["sessionId"], agentId, messages: [...(spec.subagentTranscripts?.[agentId] ?? [])] } };
  });
  const accountOf = (account: Partial<AccountRecord>, i: number): AccountRecord =>
    checked(AccountRecord, {
      id: `account-${i + 1}`,
      provider: "claude",
      label: `account ${i + 1}`,
      directory: { kind: "adopted", path: `/home/milo/.account-${i + 1}` },
      identity: null,
      status: { state: "signed-in", checkedAt: null, detail: null },
      createdAt: clock.now().toISOString(),
      ...account,
    });
  const accounts: AccountRecord[] = (spec.accounts ?? []).map(accountOf);
  /** The accounts minted so far, so a new account's id is never one a removed account had. */
  let accountsMinted = accounts.length;
  wire.answer("accounts.list", () =>
    spec.accountsError !== undefined ? { error: { code: "internal", message: spec.accountsError, data: {} } } : { result: { accounts: [...accounts] } },
  );
  wire.answer("models.list", () => ({
    result: { catalogues: (spec.models ?? []).map((catalogue) => checked(AccountCatalogue, { accountId: "account-1", live: false, models: [], ...catalogue })) },
  }));
  // The account store's commands (claude-adapter spec, "The account store"): each change said with `account.updated`.
  let ambient = checked(AmbientProbe, {
    provider: "claude",
    directory: "/home/milo/.claude",
    present: false,
    signedIn: false,
    identity: null,
    accountId: null,
    detail: null,
    checkedAt: clock.now().toISOString(),
    ...spec.ambient,
  });
  const accountUpdated = (accountId: string, change: AccountChange) => notice("account.updated", { accountId, change, warning: null });
  const accountRefusal = (reason: string, message: string, data: Record<string, unknown> = {}): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence: ++sequence, changed: false, reason: "conflict", error: { code: "conflict", message, data: { reason, ...data } } } },
  });
  const accountNotHeld = (accountId: unknown): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence: ++sequence, changed: false, reason: "not_found", error: { code: "not_found", message: `No account ${String(accountId)} on this environment.`, data: { kind: "account" } } } },
  });
  /** The refusal of `label` for another account than `accountId` holding it, ignoring case. */
  const labelTaken = (label: string, accountId?: string): FakeAnswer | undefined => {
    const holder = accounts.find((a) => a.id !== accountId && a.label.toLowerCase() === label.toLowerCase());
    return holder ? accountRefusal("label_taken", `The label ${label} is taken by another account on this environment, ignoring case.`, { accountId: holder.id }) : undefined;
  };
  /** Removes `held`, releasing the machine's own directory if it held it, as the account store does. */
  const removeAccount = (held: AccountRecord) => {
    accounts.splice(accounts.indexOf(held), 1);
    if (ambient.accountId === held.id) ambient = { ...ambient, accountId: null };
    accountUpdated(held.id, "removed");
  };
  wire.answer("accounts.probe", () => ({ result: { ...ambient, checkedAt: clock.now().toISOString() } }));
  wire.answer("accounts.refresh", () => ({ result: { accounts: [...accounts] } }));
  wire.answer("accounts.adopt", (params) => {
    const refused = rejection("accounts.adopt");
    if (refused) return refused;
    if (ambient.directory === null || !ambient.present || !ambient.signedIn) {
      return accountRefusal("ambient_unavailable", `The machine's own Claude directory is not signed in (${ambient.directory ?? "none"}); sign in with Claude's own CLI, then call accounts.probe.`);
    }
    const holder = accounts.find((a) => a.id === ambient.accountId);
    if (holder) return accountRefusal("already_added", `${ambient.directory} is already added as ${holder.label}.`, { accountId: holder.id });
    const label = (params["label"] as string | undefined) ?? ambient.identity?.email ?? "";
    const taken = labelTaken(label);
    if (taken) return taken;
    const account = accountOf({ id: `account-${++accountsMinted}`, label, directory: { kind: "adopted", path: ambient.directory }, identity: ambient.identity }, accounts.length);
    accounts.push(account);
    ambient = { ...ambient, accountId: account.id };
    accountUpdated(account.id, "adopted");
    return acceptedWith({ account });
  });
  wire.answer("accounts.relabel", (params) => {
    const refused = rejection("accounts.relabel");
    if (refused) return refused;
    const at = accounts.findIndex((a) => a.id === params["accountId"]);
    const held = accounts[at];
    if (!held) return accountNotHeld(params["accountId"]);
    const label = String(params["label"]);
    if (held.label === label) return acceptedWith({ account: held });
    const taken = labelTaken(label, held.id);
    if (taken) return taken;
    const account = { ...held, label };
    accounts[at] = account;
    accountUpdated(account.id, "relabelled");
    return acceptedWith({ account });
  });
  wire.answer("accounts.remove", (params) => {
    const refused = rejection("accounts.remove");
    if (refused) return refused;
    const held = accounts.find((a) => a.id === params["accountId"]);
    if (!held) return accountNotHeld(params["accountId"]);
    const deleteDirectory = params["deleteDirectory"] === true;
    if (deleteDirectory && held.directory.kind === "adopted") {
      return accountRefusal(
        "adopted_directory",
        `${held.label} is the machine's own provider directory, adopted in place; the environment never deletes it. Remove the account without deleting its directory.`,
        { accountId: held.id },
      );
    }
    removeAccount(held);
    return acceptedWith({ accountId: held.id, directoryDeleted: deleteDirectory });
  });
  const changeAccount = (accountId: string, changes: Partial<AccountRecord> | null) => {
    const at = accounts.findIndex((a) => a.id === accountId);
    const held = accounts[at];
    if (!held) throw new Error(`${spec.name} holds no account ${accountId}.`);
    if (changes === null) return removeAccount(held);
    accounts[at] = checked(AccountRecord, { ...held, ...changes });
    accountUpdated(accountId, changes.label !== undefined ? "relabelled" : changes.identity !== undefined ? "identity-set" : "status-changed");
  };

  // The sign-in director (ADR 0018): one sign-in at a time, moved by the handle as the provider's CLI would move it.
  let signIn: SignIn | null = null;
  const moveSignIn = (state: SignInState, fields: { readonly url?: string | null; readonly error?: string | null } = {}) => {
    if (!signIn) throw new Error(`${spec.name} has no sign-in to move.`);
    signIn = checked(SignIn, { ...signIn, state, ...(fields.url !== undefined && { url: fields.url }), ...(fields.error !== undefined && { error: fields.error }) });
    if (state === "done") {
      const at = accounts.findIndex((a) => a.id === signIn?.accountId);
      const held = accounts[at];
      if (held) accounts[at] = { ...held, status: { state: "signed-in", checkedAt: clock.now().toISOString(), detail: null } };
    }
    notice("signin.updated", { ...signIn });
  };
  const startSignIn = (accountId: string): SignIn => {
    const account = accounts.find((a) => a.id === accountId);
    const directory = account?.directory.path ?? "/home/milo/.agent-harness/accounts/new";
    const startedAt = clock.now();
    signIn = checked(SignIn, {
      accountId,
      state: "starting",
      url: null,
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + 10 * 60_000).toISOString(),
      fallback: { posix: `CLAUDE_CONFIG_DIR='${directory}' claude auth login`, powershell: `$env:CLAUDE_CONFIG_DIR = '${directory}'; & 'claude' auth login` },
      error: null,
    });
    // Announced as it started, whatever the handle moves it to before the announcement goes.
    const started = signIn;
    later(() => notice("signin.updated", { ...started }));
    return signIn;
  };
  /** The sign-in that has not ended, which holds the environment: one at a time, as the director runs them. */
  const runningSignIn = (): SignIn | null => (signIn !== null && !(SIGN_IN_ENDED_STATES as readonly SignInState[]).includes(signIn.state) ? signIn : null);
  /** What the director says of a sign-in held by `running`'s account. */
  const heldMessage = (running: SignIn) =>
    `A sign-in is already running for ${accounts.find((a) => a.id === running.accountId)?.label ?? running.accountId}; cancel it, or wait for it to end.`;
  wire.answer("accounts.signin.get", () => ({ result: { signIn } }));
  wire.answer("accounts.add", (params) => {
    const refused = rejection("accounts.add");
    if (refused) return refused;
    const id = ++accountsMinted;
    const label = String(params["label"]);
    const running = runningSignIn();
    const account = accountOf({ id: `account-${id}`, label, directory: { kind: "owned", path: `/home/milo/.agent-harness/accounts/${id}` }, status: { state: "signed-out", checkedAt: null, detail: null } }, accounts.length);
    accounts.push(account);
    const start =
      spec.addSignIn ?? (running === null ? { started: true, message: null } : { started: false, message: `${heldMessage(running)} Sign ${label} in with accounts.signin.start once it has.` });
    if (start.started) startSignIn(account.id);
    return acceptedWith({ account, signIn: start });
  });
  wire.answer("accounts.signin.start", (params) => {
    const refused = rejection("accounts.signin.start");
    if (refused) return refused;
    const running = runningSignIn();
    if (running !== null) return accountRefusal("signin_running", heldMessage(running), { accountId: running.accountId });
    return acceptedWith({ signIn: startSignIn(String(params["accountId"])) });
  });
  wire.answer("accounts.signin.code", (params) => {
    const refused = rejection("accounts.signin.code");
    if (refused) return refused;
    const held: SignIn | null = signIn;
    if (held === null || held.state !== "awaiting-code" || held.accountId !== params["accountId"]) {
      return { result: { receipt: { status: "rejected", sequence: ++sequence, changed: false, reason: "conflict", error: { code: "conflict", message: "No sign-in of that account is waiting for a code.", data: { reason: "not_awaiting_code" } } } } };
    }
    moveSignIn("submitting");
    return acceptedWith({ signIn });
  });
  wire.answer("accounts.signin.cancel", (params) => {
    const refused = rejection("accounts.signin.cancel");
    if (refused) return refused;
    const held: SignIn | null = signIn;
    if (held !== null && held.accountId === params["accountId"] && (held.state === "starting" || held.state === "awaiting-code" || held.state === "submitting")) moveSignIn("cancelled");
    return acceptedWith({ signIn });
  });

  // Plan usage's hand-off recommendation, answered from what the script holds.
  let recommendation = checked(HandoffRecommendation, {
    accountId: null,
    reason: "no-target",
    message: "No other account has room.",
    fromAccountId: null,
    trigger: null,
    headroom: null,
    binding: null,
    candidates: 0,
    basis: null,
    ...spec.recommendation,
  });
  wire.answer("accounts.handoff.recommend", (params) => ({ result: { ...recommendation, fromAccountId: (params["fromAccountId"] as string | undefined) ?? null } }));
  const recommend = (changes: Partial<HandoffRecommendation>) => {
    recommendation = checked(HandoffRecommendation, { ...recommendation, ...changes });
    notice("usage.updated", { accountId: recommendation.fromAccountId ?? "account-1", identity: null });
  };

  // The settings, the permission settings among them, and the containment the probe reports.
  let values: SettingsValues = { ...presetSettings(), ...spec.settings };
  const containment = checked(ContainmentReport, {
    levels: CONTAINMENT_LEVELS.map((level) => ({ level, available: true, reason: null, cause: null })),
    mechanism: "bubblewrap",
    container: { declared: false, detected: false },
    ...spec.containment,
  });
  const permissionValues = () => Object.fromEntries(PERMISSION_SETTINGS_KEYS.map((key) => [key, values[key]]));
  /** Takes some settings' values as every write does: the keys whose values change, said with one `settings.changed` notice naming them (#391). */
  const changeSettings = (patch: Partial<SettingsValues>) => {
    const keys = (Object.keys(patch) as (keyof SettingsValues)[]).filter((key) => JSON.stringify(values[key]) !== JSON.stringify(patch[key]));
    values = { ...values, ...patch };
    if (keys.length > 0) notice("settings.changed", { keys });
  };
  // Browser-origin controls share the same scripted settings seam as their neighbours.
  let webOrigins = { clientOrigins: [...(spec.webOrigins?.clientOrigins ?? [])], connectOrigins: [...(spec.webOrigins?.connectOrigins ?? [])] };
  wire.answer("web.origins.get", () => ({ result: webOrigins }));
  wire.answer("web.origins.set", params => {
    const refused = rejection("web.origins.set");
    if (refused) return refused;
    webOrigins = { clientOrigins: params["clientOrigins"] as string[], connectOrigins: params["connectOrigins"] as string[] };
    notice("web.origins.updated", {});
    return acceptedWith(webOrigins);
  });
  wire.answer("settings.get", (params) => {
    const keys = (params["keys"] as readonly (keyof SettingsValues)[] | undefined) ?? (Object.keys(values) as (keyof SettingsValues)[]);
    return { result: { values: Object.fromEntries(keys.map((key) => [key, values[key]])) } };
  });
  wire.answer("settings.update", (params) => {
    const refused = rejection("settings.update");
    if (refused) return refused;
    changeSettings(params["values"] as Partial<SettingsValues>);
    return acceptedWith({ values });
  });
  // The denylist and the Unattended review (`scripted-permissions.ts`).
  const permissions = scriptedPermissions({
    clock,
    wire,
    lostPresets: spec.lostPresets,
    review: spec.review,
    sessionId: () => sessions[0]?.id ?? "0199aa00-0000-4000-8000-000000000001",
    head: () => sequence,
    next: () => ++sequence,
    refusal: (method) => rejection(method),
    notice,
  });
  // The update keys (#335), which only updates.settings.set writes.
  wire.answer("updates.settings.set", (params) => {
    const refused = rejection("updates.settings.set");
    if (refused) return refused;
    changeSettings(params["values"] as Partial<SettingsValues>);
    return acceptedWith({ values: Object.fromEntries(UPDATE_SETTINGS_KEYS.map((key) => [key, values[key]])) });
  });
  // The update methods (#354), as `ScriptedUpdates` says.
  let updates: { readonly status: UpdatesStatus; readonly desktopBuild: NonNullable<ScriptedUpdates["desktopBuild"]>; readonly updateId: string | undefined } = {
    status: checked(UpdatesStatus, {
      version: FAKE_HARNESS_VERSION,
      protocolVersion: spec.protocolVersion ?? PROTOCOL_VERSION,
      bundledClaudeCodeVersion: "2.1.0-test",
      manager: { kind: "launcher", launcherVersion: FAKE_HARNESS_VERSION },
      releaseSource: { origin: "https://git.example.test", kind: "forgejo", repository: "david/agent-harness" },
      newest: null,
      lastCheck: null,
      lastReadAt: null,
      target: null,
      passedOver: null,
      pending: { state: "current" },
      lastOutcome: null,
      failedVersions: [],
      installed: [FAKE_HARNESS_VERSION],
      ...spec.updates?.status,
    }),
    desktopBuild: spec.updates?.desktopBuild ?? { refused: "not_found", message: "The release has no desktop build for this platform and format." },
    updateId: spec.updates?.updateId,
  };
  const setUpdates = (changes: ScriptedUpdates) => {
    updates = { status: checked(UpdatesStatus, { ...updates.status, ...changes.status }), desktopBuild: changes.desktopBuild ?? updates.desktopBuild, updateId: changes.updateId ?? updates.updateId };
  };
  wire.answer("updates.status", () => ({ result: updates.status }));
  wire.answer("updates.check", () => ({ result: updates.status }));
  wire.answer("updates.desktop.stage", () => {
    const build = updates.desktopBuild;
    if (!("refused" in build)) return { result: { ...build } };
    return { error: { code: build.refused, message: build.message ?? `Refused: ${build.refused}.`, data: { ...build.data } } };
  });
  wire.answer("updates.apply", (params) => {
    const refused = rejection("updates.apply");
    if (refused) return refused;
    const toVersion = (params["version"] as string | undefined) ?? updates.status.newest ?? updates.status.version;
    return acceptedWith({ updateId: updates.updateId ?? uuidv4(), toVersion });
  });

  /** The refusal of a level the probe says cannot be enforced (`containment_unavailable`); undefined for one it can. */
  const unavailable = (level: ContainmentLevel): FakeAnswer | undefined => {
    const availability = containment.levels.find((l) => l.level === level);
    if (!availability || availability.available) return undefined;
    return {
      result: {
        receipt: {
          status: "rejected",
          sequence: ++sequence,
          changed: false,
          reason: "containment_unavailable",
          error: { code: "containment_unavailable", message: `${level} cannot be enforced here: ${availability.reason}`, data: { level, reason: availability.reason, cause: availability.cause } },
        },
      },
    };
  };
  wire.answer("permissions.settings.get", () => ({
    result: { values: permissionValues(), containment, isRoot: false, denylist: permissions.counts() },
  }));
  wire.answer("permissions.settings.set", (params) => {
    const refused = rejection("permissions.settings.set");
    if (refused) return refused;
    const asked = params["values"] as Partial<SettingsValues>;
    // A containment default the probe cannot enforce is refused, checked only when it differs from the one stored (#133).
    const level = asked["permissions.containment.default"];
    const unenforceable = level === undefined || level === values["permissions.containment.default"] ? undefined : unavailable(level);
    if (unenforceable) return unenforceable;
    let acknowledged: Partial<SettingsValues> = {};
    if (asked["permissions.unattended.mode"] === "bypassPermissions" && values["permissions.unattended.bypassAcknowledgedAt"] === null) {
      if (params["acknowledgeBypass"] !== true) return { error: { code: "invalid_params", message: `acknowledgeBypass must come with the first bypassPermissions: ${BYPASS_SENTENCE}`, data: {} } };
      acknowledged = { "permissions.unattended.bypassAcknowledgedAt": clock.now().toISOString() };
    }
    changeSettings({ ...asked, ...acknowledged });
    return acceptedWith({ values: permissionValues() });
  });

  // A session's mode, clamped to this client session's ceiling, and its containment level, refused where the probe says it cannot be enforced.
  wire.answer("permissions.mode.set", (params) => {
    const refused = rejection("permissions.mode.set");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    const requested = params["mode"] as Mode;
    const effective = lowerMode(requested, ceiling());
    const clamped = compareModes(effective, requested) < 0;
    const mode = { requested, effective, ceiling: ceiling(), clamped, clampReason: clamped ? "ceiling" : null };
    const running = live.get(sessionId);
    const payload = { mode, live: running === undefined ? null : { runId: running, mode: effective } };
    emit(sessionId, "session.mode.set", payload, { fields: { mode: effective } });
    return acceptedWith({ sessionId, ...payload });
  });
  wire.answer("permissions.containment.set", (params) => {
    const refused = rejection("permissions.containment.set");
    if (refused) return refused;
    const sessionId = String(params["sessionId"]);
    const level = params["level"] as ContainmentLevel;
    const unenforceable = unavailable(level);
    if (unenforceable) return unenforceable;
    const payload = { containment: { requested: level, effective: level, clamped: false } };
    emit(sessionId, "session.containment.set", payload);
    return acceptedWith({ sessionId, ...payload });
  });
  // The Managed tools' rows, their verify commands, claude's doctor and the tool runs (`scripted-tools.ts`).
  const tools = scriptedTools({
    clock,
    wire,
    rows: spec.keyManagers?.tools,
    script: spec.managedTools,
    notice,
    head: () => sequence,
    next: () => ++sequence,
    refusal: (method) => rejection(method),
    openToolTerminal: (id, size, hooks) => (terminals.has(id) ? undefined : infoOf(hold(id, null, size, hooks))),
    output: (id, data) => terminalOutput(id, data),
    exit: (id, exitCode) => exitTerminal(id, exitCode),
  });

  // The key-manager connections and Move (`scripted-key-managers.ts`).
  const keyManagers = scriptedKeyManagers({
    clock,
    wire,
    script: spec.keyManagers,
    toolRows: () => tools.toolRows(),
    notice,
    head: () => sequence,
    next: () => ++sequence,
    refusal: (method) => rejection(method),
  });

  // The forge accounts (`scripted-forges.ts`).
  const forges = scriptedForges({
    clock,
    wire,
    script: spec.forges,
    notice,
    head: () => sequence,
    next: () => ++sequence,
    refusal: (method) => rejection(method),
    clientSession: () => wire.credential()?.clientSessionId,
  });

  const receiptFor = (method: string): FakeAnswer | undefined => {
    const scriptedReceipt = spec.receipts?.[method] ?? "accepted";
    if (scriptedReceipt === "accepted") return undefined;
    const message = scriptedReceipt.message ?? `Rejected: ${scriptedReceipt.rejected}.`;
    return {
      result: {
        receipt: {
          status: "rejected",
          sequence: ++sequence,
          changed: false,
          reason: scriptedReceipt.rejected,
          error: { code: scriptedReceipt.rejected, message, data: { ...scriptedReceipt.data } },
        },
      },
    };
  };
  // The client sessions, their ceilings and revocations, pairings, the access log and the lifecycle's verbs (`scripted-access.ts`).
  const access = scriptedAccess({
    clock,
    wire,
    local: spec.reach === "local",
    clientSessions: spec.clientSessions,
    accessLog: spec.accessLog,
    status: spec.status,
    settings: () => values,
    head: () => sequence,
    next: () => ++sequence,
    refusal: receiptFor,
    queryRefusal(method) {
      const refusal = spec.receipts?.[method];
      return refusal === undefined || refusal === "accepted" ? undefined : { error: { code: refusal.rejected, message: refusal.message ?? `Rejected: ${refusal.rejected}.`, data: {} } };
    },
    notice,
  });
  // The environment's name, icon and colour (#323): a look command, or `setLook`, changes what discovery and `hello` say and
  // notices each field that changed; a value already held appends nothing (`changed: false`). The answer is the look as it
  // now is, `server` and `blue` for a field the script left unset, as an environment that answers these always holds both.
  let look: LookChanges & { readonly name: string } = { name: spec.name, ...(spec.icon && { icon: spec.icon }), ...(spec.colour && { colour: spec.colour }) };
  const changeLook = (changes: LookChanges): boolean => {
    const name = changes.name === undefined ? undefined : normaliseEnvironmentName(changes.name);
    const changed: LookChanges = {
      ...(name !== undefined && name !== look.name && { name }),
      ...(changes.icon !== undefined && changes.icon !== look.icon && { icon: changes.icon }),
      ...(changes.colour !== undefined && changes.colour !== look.colour && { colour: changes.colour }),
    };
    if (Object.keys(changed).length === 0) return false;
    look = { ...look, ...changed };
    wire.look(changed);
    if (changed.name !== undefined) notice("environment.renamed", { name: changed.name });
    if (changed.icon !== undefined) notice("environment.icon-set", { icon: changed.icon });
    if (changed.colour !== undefined) notice("environment.colour-set", { colour: changed.colour });
    return true;
  };
  const lookCommands: Readonly<Record<string, (params: Record<string, unknown>) => LookChanges>> = {
    "environment.rename": (params) => ({ name: String(params["name"]) }),
    "environment.setIcon": (params) => ({ icon: params["icon"] as EnvironmentIcon }),
    "environment.setColour": (params) => ({ colour: params["colour"] as EnvironmentColour }),
  };
  for (const [method, changesOf] of Object.entries(lookCommands)) {
    wire.answer(method, (params) => {
      const refusal = receiptFor(method);
      if (refusal) return refusal;
      const changed = changeLook(changesOf(params));
      return { result: { receipt: { status: "accepted", sequence, changed }, result: { name: look.name, icon: look.icon ?? "server", colour: look.colour ?? "blue" } } };
    });
  }
  // Every other scripted command, `access.*` ones included, answers its receipt alone, as a retry answered from a stored receipt does.
  const ownResponders = new Set([
    ...Object.keys(lookCommands),
    ...ACCESS_COMMANDS,
    "runs.start",
    "runs.send",
    "runs.interrupt",
    "runs.readNow",
    "runs.withdraw",
    "runs.stopTask",
    "sessions.setDraft",
    "sessions.fork",
    "sessions.rewind",
    "sessions.undoRewind",
    "accounts.adopt",
    "accounts.add",
    "accounts.relabel",
    "accounts.remove",
    "accounts.signin.start",
    "accounts.signin.code",
    "accounts.signin.cancel",
    "settings.update",
    "web.origins.set",
    "updates.settings.set",
    "updates.apply",
    "permissions.settings.set",
    "permissions.mode.set",
    "permissions.containment.set",
    "permissions.prompts.answer",
    "terminals.open",
    "terminals.run",
    "terminals.write",
    "terminals.resize",
    "terminals.close",
    ...KEY_MANAGER_COMMANDS,
    ...FORGE_COMMANDS,
    ...PERMISSION_COMMANDS,
    ...LIST_COMMANDS,
  ]);
  for (const method of Object.keys(spec.receipts ?? {})) {
    if (ownResponders.has(method)) continue;
    wire.answer(method, () => receiptFor(method) ?? { result: { receipt: { status: "accepted", sequence: ++sequence, changed: true } } });
  }
  // The session list and the organisation commands (`sessions.create` among them), applied with their patches to the
  // sessions the session streams read; a rejection the script names still stands.
  const list = scriptedList({
    wire,
    clock,
    store: {
      all: () => sessions,
      get: (id) => sessions.find((s) => s.id === id),
      put: (summary) => {
        if (!logs.has(summary.id)) {
          created.set(summary.id, summary);
          logs.set(summary.id, { base: sequence, events: [] });
        }
        setSummary(summary);
      },
      remove: (id) => {
        const at = sessions.findIndex((s) => s.id === id);
        if (at !== -1) sessions.splice(at, 1);
      },
    },
    groups,
    next: () => ++sequence,
    head: () => sequence,
    refusal: receiptFor,
    ...(spec.directories !== undefined && { directories: spec.directories }),
    folders,
  });

  const fetch: HttpFetch = async (url, request) => {
    if (spec.pairing && url === `${wire.origin}${PAIR_PATH}` && request?.method === "POST" && discovery !== "nothing") {
      const refusal = PAIRING_REFUSALS[spec.pairing];
      const body = { code: refusal.code, message: `Refused: ${refusal.code}.`, data: {} };
      return { status: refusal.status, json: async () => body };
    }
    return wire.fetch(url, request);
  };

  const webSocket: WebSocketFactory = (url, handlers) => {
    // A socket that closes takes its terminal subscriptions with it, as the environment drops a connection's subscriptions.
    const socket = wire.webSocket(url, {
      ...handlers,
      onClose: (code, reason) => {
        for (const t of terminals.values()) t.subscriptions.clear();
        handlers.onClose(code, reason);
      },
    });
    return {
      send(text) {
        socket.send(text);
        if (!accepting || (JSON.parse(text) as Frame).type !== "auth") return;
        later(() => {
          try {
            wire.server.hello(hello);
          } catch {
            // The socket closed before the answer: nothing to say it on.
          }
        });
      },
      close: (code, reason) => socket.close(code, reason),
    };
  };

  const handle: EnvironmentHandle = {
    name: spec.name,
    environmentId: wire.environmentId,
    wire,
    server: wire.server,
    discovery: setDiscovery,
    readiness: () => discovery,
    bye: (reason, fields) => wire.server.bye(reason, fields),
    accept: async (overrides) => void (await wire.server.accept({ ...hello, ...overrides })),
    autoAccept(on) {
      accepting = on;
    },
    requests: (method) =>
      wire.server
        .received()
        .filter((f): f is Extract<Frame, { readonly type: "request" }> => f.type === "request" && (method === undefined || f.method === method)),
    list,
    sessionId(at = 0) {
      const found = sessions[at];
      if (!found) throw new Error(`${spec.name} lists no session at ${at}.`);
      return found.id;
    },
    summary: summaryNow,
    emit,
    startRun,
    endRun,
    writeFile,
    editFile,
    liveRun: (sessionId) => live.get(sessionId),
    messageId(sessionId, text) {
      const sent = (logs.get(sessionId)?.events ?? []).filter((event) => event.type === "message.sent" && (event.payload as Record<string, unknown>)["text"] === text).at(-1);
      if (!sent) throw new Error(`${spec.name} holds no message ${JSON.stringify(text)} on ${sessionId}.`);
      return String((sent.payload as Record<string, unknown>)["messageId"]);
    },
    events: (sessionId) => [...(logs.get(sessionId)?.events ?? [])],
    queued: (sessionId) => queueOf(sessionId).map((m) => ({ ...m })),
    accounts: () => [...accounts],
    changeAccount,
    setUsage,
    setUpdates,
    releaseSessions: () => held.splice(0).forEach((catchUp) => catchUp()),
    holdRewinds,
    signIn: moveSignIn,
    currentSignIn: () => signIn,
    recommend,
    settings: () => values,
    setSettings: changeSettings,
    notice,
    setLook: (changes) => void changeLook(changes),
    ...prompts,
    setSetup: setup.setSetup,
    ...keyManagers,
    ...tools,
    ...forges,
    ...access,
    denylist: permissions.denylist,
    reviewWatermark: permissions.reviewWatermark,
    holdDenylistWrites: permissions.holdDenylistWrites,
    setDenylist: permissions.setDenylist,
    decideReviewRun: permissions.decideReviewRun,
    seeReview: permissions.seeReview,
    holdSetupChecks: setup.holdSetupChecks,
    refuseSetupChecks: setup.refuseSetupChecks,
    passSetup: setup.passSetup,
    terminals: () => [...terminals.values()],
    terminal(id) {
      const found = terminals.get(id.toLowerCase());
      if (!found) throw new Error(`${spec.name} never held a terminal ${id}.`);
      return found;
    },
    holdTerminalOpens() {
      heldOpens ??= [];
      return () => {
        const waiting = heldOpens ?? [];
        heldOpens = null;
        for (const release of waiting) release();
      };
    },
    terminalOutput: (id, data) => terminalOutput(id.toLowerCase(), data),
    exitTerminal(id, exitCode, signal = null) {
      if (!terminals.has(id.toLowerCase())) throw new Error(`${spec.name} never held a terminal ${id}.`);
      exitTerminal(id.toLowerCase(), exitCode, "exited", signal);
    },
    closeTerminal(id) {
      const t = terminals.get(id.toLowerCase());
      if (!t) throw new Error(`${spec.name} never held a terminal ${id}.`);
      t.closed = true;
      exitTerminal(t.id, 0, "closed", 1);
    },
    dropScrollback(id, chunks) {
      const t = terminals.get(id.toLowerCase());
      if (!t) throw new Error(`${spec.name} never held a terminal ${id}.`);
      if (t.chunks.splice(0, chunks).length > 0) t.cut = true;
    },
  };
  return { handle, fetch, webSocket, wsUrl: `${wire.origin.replace(/^http/, "ws")}${WIRE_PATH}` };
};

/** Builds the script's environments on `clock`, with one `fetch` and one WebSocket factory routing to them by address. */
export const scriptedWorld = (clock: ManualClock, script: Script): ScriptedWorld => {
  const built = script.environments.map((spec, index) => scripted(clock, spec, index));
  const byName = new Map(built.map((b) => [b.handle.name, b.handle]));
  const local = script.environments.findIndex((spec) => spec.reach === "local");
  if (script.environments.filter((spec) => spec.reach === "local").length > 1) throw new Error("A script has at most one local environment.");
  return {
    environments: built.map((b) => b.handle),
    fetch: async (url, request) => {
      const target = built.find((b) => url.startsWith(`${b.handle.wire.origin}/`));
      if (!target) throw new TypeError("fetch failed");
      return target.fetch(url, request);
    },
    webSocket: (url, handlers) => {
      const target = built.find((b) => b.wsUrl === url);
      if (target) return target.webSocket(url, handlers);
      later(() => handlers.onClose(1006, "Nothing answered."));
      return { send: () => undefined, close: () => undefined };
    },
    grant: local === -1 ? undefined : (built[local] as (typeof built)[number]).handle.wire.grant,
    environment(name) {
      const found = byName.get(name);
      if (!found) throw new Error(`The script has no environment named ${name}.`);
      return found;
    },
  };
};

/** The discovery path, for a test that reads it through the world's `fetch`. */
export { DISCOVERY_PATH };
export { SCRIPTED_HOME, type ScriptedList } from "./scripted-list.js";
export { OTHER_CLIENT, type ScriptedPrompt, type ScriptedPrompts } from "./scripted-prompts.js";
export { type ScriptedSetup, type ScriptedStepResult } from "./scripted-setup.js";
export { type ScriptedDetection, type ScriptedForges } from "./scripted-forges.js";
export { certificateOf, type ScriptedKeyManagers, type ScriptedMoveItem } from "./scripted-key-managers.js";
export { SUDO_PROMPT, type ScriptedManagedTools, type ScriptedToolRun } from "./scripted-tools.js";
export { type ScriptedPermissionsHandle } from "./scripted-permissions.js";
export { type ClientSessionRow, type ScriptedAccessEvent, type ScriptedAccessHandle } from "./scripted-access.js";
