import type { Checks, ChecksView } from "./checks.js";
import type { RegisteredStepId, StateImportFailure } from "@agent-harness/contracts";
import type { LocalStatus } from "./bootstrap.js";
import type { CapabilityAnswer, CapabilityName } from "./capabilities.js";
import type { DesktopUpdate } from "./desktop-update.js";
import type { ClientPreferences } from "./connections/records.js";
import type { Connections } from "./connections/registry.js";
import type { Notice } from "./notices.js";
import type { Commands } from "./outbox/outbox.js";
import type { SkillsCopies } from "./skills-copy.js";
import type { Drafts } from "./outbox/drafts.js";
import type { CopyTarget } from "./copies.js";
import type { Forges } from "./forges.js";
import type { KeyManagers } from "./key-managers.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Observable } from "./observable.js";
import type { Platform } from "./platform.js";
import type { EnvironmentView } from "./projections/environments.js";
import type { RequestAnswer, Requests } from "./requests.js";
import type { SessionListView, SessionRow } from "./projections/session-list.js";
import type { SessionHandle } from "./streams/session-handles.js";
import type { TerminalHandle, TerminalOutput } from "./streams/terminals.js";
import type { AccountsAnswer, ModelsAnswer, UsageView } from "./projections/accounts.js";
import type { AccountNames } from "./projections/account-names.js";
import type { BrowsersView } from "./projections/browsers.js";
import type { Attention } from "./projections/attention.js";
import type { ClientCalls } from "./projections/client-calls.js";
import type { SessionDocument } from "./projections/documents.js";
import type { KnownDirectory } from "./projections/known-directories.js";
import type { NewSessionContext, NewSessionView } from "./projections/new-session.js";
import type { ModePicker } from "./projections/modes.js";
import type { RoutineMoves } from "./routine-moves.js";
import type { RoutineHistory, RoutinesView } from "./projections/routines.js";
import type { RunsProjection } from "./projections/runs.js";
import type { SessionProjection } from "./projections/session.js";
import type { SetupView } from "./projections/setup.js";
import type { ToolRunsView } from "./managed-tools/tool-runs.js";

/**
 * The client runtime (docs/specs/client-runtime.md): what every client
 * renders from, and all a renderer sees. Given a platform it keeps the saved
 * connections, exchanges the local bootstrap grant, pairs, keeps one socket
 * per environment alive through the backoff ladder and the watchdog, fills
 * each connection from `hello`, raises the connection's notices, and answers
 * capability questions. While a connection is enabled it subscribes the
 * environment's session list and its own stream, caches each with its
 * cursor, and projects the list across environments; a session is
 * subscribed while a handle holds it. Every `sessions:write` and
 * `runs:drive` command goes through the outbox with a command id minted once
 * (`commands`, `drafts`), so a retry never applies twice: a session-list
 * change shows at once and waits while the environment is unreachable; a run
 * command never waits, failing `unreachable` instead. The `admin` calls are
 * direct requests (`requests`). It carries no frames and no raw requests
 * (ADR 0004: renderers never reach the streams).
 */
export interface Runtime {
  /** Reads what was saved, exchanges the local grant when the platform reads one, and starts every connection; settles once each first attempt has. A failed start may be called again. */
  start(): Promise<void>;
  /** What became of the local environment's grant exchange. */
  readonly local: Observable<LocalStatus>;
  readonly connections: Connections;
  /** The client-local preferences: the environment sequence, enabled flags, the last environment used. */
  readonly preferences: Observable<ClientPreferences>;
  /** Workspace check requests and explicit failure sends, shared by both renderers. */
  readonly checks: Checks;
  readonly projections: {
    checks(environmentId: string, sessionId: string): Observable<ChecksView>;
    readonly environments: Observable<readonly EnvironmentView[]>;
    /** What the runtime has to tell David, newest last, at most 100: the connections' notices, the environment's (updated, draining, an account, a prompt parked or settled unanswered) and the outbox's rejections and drops. */
    readonly notices: Observable<readonly Notice[]>;
    /** Every session across the enabled environments with the sidebar's views: shelves, merged groups, repositories; and each list's freshness. */
    readonly sessionList: Observable<SessionListView>;
    /** A case-insensitive substring match over titles, tags, group names and repository identity, in the sidebar's order. */
    search(query: string): Observable<readonly SessionRow[]>;
    /**
     * One session's stream reduced into runs and transcript entries, with
     * its parked prompts, its queue, its rewind, its summary and its draft.
     * Following it holds the session's subscription as a handle does;
     * reading it never subscribes.
     */
    session(environmentId: string, sessionId: string): Observable<SessionProjection>;
    /**
     * The pages, SVGs and markdown one session wrote, most recently touched
     * first: its write and edit tool calls folded into one entry per
     * workspace path, each with the call that first wrote it and when, its
     * last touch, its revisions and its size when last written whole
     * (`sessionDocuments`). Following it follows the session as `session`
     * does.
     */
    documents(environmentId: string, sessionId: string): Observable<readonly SessionDocument[]>;
    /**
     * Each session's run state, and the parked asks of every enabled
     * environment with their TTL countdowns; `runs.session(environmentId,
     * sessionId)` is one session's run state with its queue, its rewind and
     * each verb of ADR 0022 present or absent with its reason, and following
     * it holds the session's subscription.
     */
    readonly runs: RunsProjection;
    /** The environment's accounts, from the request cache; fetched while followed. */
    accounts(environmentId: string): Observable<AccountsAnswer>;
    /** What a surface calls the environment's accounts: their labels, kept from the last answer for a window opened while it is not answering (#1752). */
    accountNames(environmentId: string): Observable<AccountNames>;
    /** The last completed state import's failures, from the environment stream and its retained cache. */
    stateImportFailures(environmentId: string): Observable<readonly StateImportFailure[]>;
    /** The models the environment's accounts can use, from the request cache; fetched while followed. */
    models(environmentId: string): Observable<ModelsAnswer>;
    /** Plan usage of every enabled environment, pooled by account identity into one gauge per login. */
    readonly usage: Observable<UsageView>;
    /** The mode picker for the environment: the contracts' modes in their order, each allowed up to the connection's ceiling. */
    modes(environmentId: string): Observable<ModePicker>;
    /** The environments a copy from this one offers: every other enabled one this client holds an `admin` connection to, in the connection list's order (#320). */
    copyTargets(environmentId: string): Observable<readonly CopyTarget[]>;
    /**
     * The directories the environment's sessions use (a directory's path, a
     * worktree's repository, never a scratch workspace), each with its
     * repository identity, last use and missing mark, most recent first, at
     * most `KNOWN_DIRECTORY_LIMIT`: derived from the session list, cached
     * offline with it, and stored nowhere.
     */
    knownDirectories(environmentId: string): Observable<readonly KnownDirectory[]>;
    /**
     * The new-session card's chips for what is in focus and the chips already
     * set (ADR 0005): each chip's preset, the reason for it and its options,
     * in the card's order, environment, account, model, workspace, browser
     * (the account's `browser.reach`, #561). A new
     * observable on every call: a renderer keeps the one it follows while
     * its context holds.
     */
    newSession(context: NewSessionContext): Observable<NewSessionView>;
    /**
     * The environment's Set up checklist (#570): the eleven steps in the
     * milestone-1 order, each with its label, its home row, whether the
     * environment registers it, its latest result with its age and whether
     * it is stale, and whether this client's own check of it is pending;
     * the counts over the registered steps; and whether the environment can
     * be reached. Filled from the environment stream's snapshot and its
     * `setup.result-changed` notices, cached with the stream's cursor, with
     * no call of its own; an environment without the `setup` flag is asked
     * `setup.check` of every step each time the view comes to be followed.
     */
    setup(environmentId: string): Observable<SetupView>;
    /**
     * The environment's tool runs as its stream tells of them (#426): the
     * run under way (`tool.run-started`), and each tool's last run heard to
     * finish with its exit and verification (`tool.run-finished`). Heard,
     * never asked; in memory only.
     */
    toolRuns(environmentId: string): Observable<ToolRunsView>;
    /**
     * Every enabled environment's routines (#532), from its `routines.list`
     * in the request cache, fetched while followed, on every ready and on
     * `routine.updated`: grouped by environment in the connection list's
     * order with its name, icon and colour, the list of one that cannot be
     * reached kept and marked stale, each routine a waiting command names
     * flagged pending, a create shown from the definition it sent until a
     * list asked for after its receipt is held, and the routines needing
     * attention counted. Following both environments also settles a moved
     * copy whose untouched original has not heard its disable.
     */
    readonly routines: Observable<RoutinesView>;
    /**
     * A routine's firings and skips, newest first (#532): the newest page of
     * `routines.history` from the request cache, fetched while followed, on
     * every ready and on `routine.updated`, and each older page as `more()`
     * asks for it, by `before`.
     */
    routineHistory(environmentId: string, routineId: string): RoutineHistory;
    /**
     * The session's browser picker (#561), which both renderers draw: the
     * default with what a null field resolves to, a row for each Chrome
     * paired with this client's local environment or with the session's
     * (connected, or dimmed with the reason), the plain My Chrome where
     * more than one is paired, other known environments' Chromes dimmed
     * with why this client cannot drive them, the session environment's headless browser
     * with its availability, and the browser dock where the shell has
     * `webView`, and explicit no browser; the session's browser marked. From `browser.chromes.list`
     * and `browser.status` in the request cache, fetched while followed and
     * again on `chrome.updated`; the status also on `extension.seen` and on
     * `settings.changed`, since the default and headless rows read its
     * `browser.headless.*` part.
     */
    browsers(environmentId: string, sessionId: string): Observable<BrowsersView>;
  };
  /** Run ended, prompt parked, notice arrived: for the renderer to surface; the runtime never calls the shell for them. */
  readonly attention: Attention;
  /** The calls the environment addresses to this client (ADR 0014), each handed to the handler registered for its kind. */
  readonly clientCalls: ClientCalls;
  readonly subscriptions: {
    /**
     * Subscribes one session for as long as a handle holds it, from its
     * cached snapshot when there is one; its state reads from the cache
     * offline. Releasing the last handle keeps the subscription five more
     * minutes.
     */
    session(environmentId: string, sessionId: string): SessionHandle;
    /**
     * Subscribes one terminal's output for as long as the handle is held
     * (docs/specs/tui.md, "The terminal pane"): the retained scrollback as a
     * reset, then each chunk once, in order, to `listener`; after a
     * reconnect it resubscribes from its cursor, so the environment replays
     * what was missed. Never cached: a terminal's output stays in memory.
     */
    terminal(environmentId: string, terminalId: string, listener: (output: TerminalOutput) => void): TerminalHandle;
  };
  readonly notices: {
    /** Takes a notice off `projections.notices`, on this client only. */
    dismiss(noticeId: string): void;
  };
  readonly knownDirectories: {
    /**
     * Takes a directory off `projections.knownDirectories(environmentId)`, on
     * this client only (`hiddenDirectories`), until a session uses it after
     * the hiding. Rejects with a `RangeError` when no session of the
     * environment uses it.
     */
    hide(environmentId: string, path: string): Promise<void>;
  };
  /** The `sessions:write` and `runs:drive` commands through the outbox, and copies through direct admin requests. */
  readonly commands: Commands & SkillsCopies & RoutineMoves;
  /** The composer's draft, a session field: debounced a second, then `sessions.setDraft` through the outbox. */
  readonly drafts: Drafts;
  /** Direct requests, never queued: the queries and the `admin` and `terminal` commands. */
  readonly requests: Requests;
  /** Set up beyond its projection (#570). */
  readonly setup: {
    /**
     * `setup.check` of `step`, or of every step the environment registers,
     * through the request path (a query under `read`, never queued: an
     * environment not ready answers `unreachable` at once). Each step it
     * asks about reads pending in `projections.setup` once half a second
     * passes without the answer, until the answer or the failure; each
     * result it answers is applied there.
     */
    check(environmentId: string, step?: RegisteredStepId): Promise<RequestAnswer<"setup.check">>;
  };
  /** Forge accounts beyond their cached list: this computer's `gh` handed over once, and copies to other environments, direct and never queued (#320). */
  readonly forges: Forges;
  /** Key-manager connections beyond their cached list: copies to other environments without the credential, direct and never queued (#384). */
  readonly keyManagers: KeyManagers;
  /**
   * The desktop's own update through its local environment, on a shell with
   * `update` (checked at launch and hourly, a newer build staged, "Restart
   * to update"), and the server artefact it carries, handed to that
   * environment or offered, on a shell with `installer.bundledServer`.
   */
  readonly desktopUpdate: DesktopUpdate;
  /**
   * The environment's time now, as this client reckons it from the server
   * time its last `hello` carried: what a snooze-until or a prompt's TTL is
   * counted down against. This client's own time for one never reached.
   */
  environmentNow(environmentId: string): Date;
  /** `present`, or `absent` with a reason and one line for people. */
  capability(environmentId: string, name: CapabilityName): CapabilityAnswer;
  /** Persists waiting drafts, outbox and cached projections without closing the client. */
  checkpoint(): Promise<void>;

  /** Closes every socket, dispatches the drafts still waiting, and writes what the cache and the outbox have pending. Idempotent. */
  close(): Promise<void>;
}

export const createRuntime = (platform: Platform): Runtime => createRuntimeWithSeams(platform).runtime;
