import type { LocalStatus } from "./bootstrap.js";
import type { CapabilityAnswer, CapabilityName } from "./capabilities.js";
import type { ClientPreferences } from "./connections/records.js";
import type { Connections } from "./connections/registry.js";
import type { Notice } from "./notices.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Observable } from "./observable.js";
import type { Platform } from "./platform.js";
import type { EnvironmentView } from "./projections/environments.js";
import type { SessionListView, SessionRow } from "./projections/session-list.js";
import type { SessionHandle } from "./streams/session-handles.js";

/**
 * The client runtime (docs/specs/client-runtime.md): what every client
 * renders from, and all a renderer sees. Given a platform it keeps the saved
 * connections, exchanges the local bootstrap grant, pairs, keeps one socket
 * per environment alive through the backoff ladder and the watchdog, fills
 * each connection from `hello`, raises the connection's notices, and answers
 * capability questions. While a connection is enabled it subscribes the
 * environment's session list and its own stream, caches each with its
 * cursor, and projects the list across environments; a session is
 * subscribed while a handle holds it. It carries no frames and no raw
 * requests (ADR 0004: renderers never reach the streams).
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
    /** What the runtime has to tell David, newest last, at most 100: the connections' notices and environment updates. */
    readonly notices: Observable<readonly Notice[]>;
    /** Every session across the enabled environments with the sidebar's views: shelves, merged groups, repositories; and each list's freshness. */
    readonly sessionList: Observable<SessionListView>;
    /** A case-insensitive substring match over titles, tags, group names and repository identity, in the sidebar's order. */
    search(query: string): Observable<readonly SessionRow[]>;
  };
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
  /**
   * The environment's time now, as this client reckons it from the server
   * time its last `hello` carried: what a snooze-until or a prompt's TTL is
   * counted down against. This client's own time for one never reached.
   */
  environmentNow(environmentId: string): Date;
  /** `present`, or `absent` with a reason and one line for people. */
  capability(environmentId: string, name: CapabilityName): CapabilityAnswer;
  /** Closes every socket and writes what the cache has pending. Idempotent. */
  close(): Promise<void>;
}

export const createRuntime = (platform: Platform): Runtime => createRuntimeWithSeams(platform).runtime;
