import type { LocalStatus } from "./bootstrap.js";
import type { CapabilityAnswer, CapabilityName } from "./capabilities.js";
import type { DesktopUpdate } from "./desktop-update.js";
import type { ClientPreferences } from "./connections/records.js";
import type { Connections } from "./connections/registry.js";
import type { Notice } from "./notices.js";
import type { Commands } from "./outbox/outbox.js";
import type { Drafts } from "./outbox/drafts.js";
import type { CopyTarget } from "./copies.js";
import type { Forges } from "./forges.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Observable } from "./observable.js";
import type { Platform } from "./platform.js";
import type { EnvironmentView } from "./projections/environments.js";
import type { Requests } from "./requests.js";
import type { SessionListView, SessionRow } from "./projections/session-list.js";
import type { SessionHandle } from "./streams/session-handles.js";
import type { TerminalHandle, TerminalOutput } from "./streams/terminals.js";
import type { AccountsAnswer, ModelsAnswer, UsageView } from "./projections/accounts.js";
import type { Attention } from "./projections/attention.js";
import type { ClientCalls } from "./projections/client-calls.js";
import type { SessionDocument } from "./projections/documents.js";
import type { KnownDirectory } from "./projections/known-directories.js";
import type { NewSessionContext, NewSessionView } from "./projections/new-session.js";
import type { ModePicker } from "./projections/modes.js";
import type { RunsProjection } from "./projections/runs.js";
import type { SessionProjection } from "./projections/session.js";

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
  readonly projections: {
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
     * in the card's order, environment, account, model, workspace. A new
     * observable on every call: a renderer keeps the one it follows while
     * its context holds.
     */
    newSession(context: NewSessionContext): Observable<NewSessionView>;
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
  /** The `sessions:write` and `runs:drive` commands, through the outbox. */
  readonly commands: Commands;
  /** The composer's draft, a session field: debounced a second, then `sessions.setDraft` through the outbox. */
  readonly drafts: Drafts;
  /** Direct requests, never queued: the queries and the `admin` calls. */
  readonly requests: Requests;
  /** Forge accounts beyond their cached list: this computer's `gh` handed over once, and copies to other environments, direct and never queued (#320). */
  readonly forges: Forges;
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
  /** Closes every socket, dispatches the drafts still waiting, and writes what the cache and the outbox have pending. Idempotent. */
  close(): Promise<void>;
}

export const createRuntime = (platform: Platform): Runtime => createRuntimeWithSeams(platform).runtime;
