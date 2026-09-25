import type { LocalStatus } from "./bootstrap.js";
import type { CapabilityAnswer, CapabilityName } from "./capabilities.js";
import type { ClientPreferences } from "./connections/records.js";
import type { Connections } from "./connections/registry.js";
import type { Notice } from "./notices.js";
import type { Commands } from "./outbox/outbox.js";
import type { Drafts } from "./outbox/drafts.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Observable } from "./observable.js";
import type { Platform } from "./platform.js";
import type { EnvironmentView } from "./projections/environments.js";
import type { Requests } from "./requests.js";
import type { SessionListView, SessionRow } from "./projections/session-list.js";
import type { SessionHandle } from "./streams/session-handles.js";
import type { AccountsAnswer, ModelsAnswer, UsageView } from "./projections/accounts.js";
import type { Attention } from "./projections/attention.js";
import type { ClientCalls } from "./projections/client-calls.js";
import type { ModePicker } from "./projections/modes.js";
import type { RunsView } from "./projections/runs.js";
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
    /** Each session's run state, and the parked asks of every enabled environment with their TTL countdowns. */
    readonly runs: Observable<RunsView>;
    /** The environment's accounts, from the request cache; fetched while followed. */
    accounts(environmentId: string): Observable<AccountsAnswer>;
    /** The models the environment's accounts can use, from the request cache; fetched while followed. */
    models(environmentId: string): Observable<ModelsAnswer>;
    /** Plan usage of every enabled environment, pooled by account identity into one gauge per login. */
    readonly usage: Observable<UsageView>;
    /** The mode picker for the environment: the contracts' modes in their order, each allowed up to the connection's ceiling. */
    modes(environmentId: string): Observable<ModePicker>;
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
  };
  readonly notices: {
    /** Takes a notice off `projections.notices`, on this client only. */
    dismiss(noticeId: string): void;
  };
  /** The `sessions:write` and `runs:drive` commands, through the outbox. */
  readonly commands: Commands;
  /** The composer's draft, a session field: debounced a second, then `sessions.setDraft` through the outbox. */
  readonly drafts: Drafts;
  /** Direct requests, never queued: the queries and the `admin` calls. */
  readonly requests: Requests;
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
