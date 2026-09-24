import type { LocalStatus } from "./bootstrap.js";
import type { CapabilityAnswer, CapabilityName } from "./capabilities.js";
import type { ClientPreferences } from "./connections/records.js";
import type { Connections } from "./connections/registry.js";
import type { Notice } from "./notices.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Observable } from "./observable.js";
import type { Platform } from "./platform.js";
import type { EnvironmentView } from "./projections/environments.js";

/**
 * The client runtime (docs/specs/client-runtime.md): what every client
 * renders from, and all a renderer sees. Given a platform it keeps the saved
 * connections, exchanges the local bootstrap grant, pairs, keeps one socket
 * per environment alive through the backoff ladder and the watchdog, fills
 * each connection from `hello`, raises the connection's notices, and answers
 * capability questions. It carries no frames and no raw requests (ADR 0004:
 * renderers never reach the streams).
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
    /** What the runtime has to tell David, newest last, at most 100: the connection's own notices so far. */
    readonly notices: Observable<readonly Notice[]>;
  };
  readonly notices: {
    /** Takes a notice off `projections.notices`, on this client only. */
    dismiss(noticeId: string): void;
  };
  /** `present`, or `absent` with a reason and one line for people. */
  capability(environmentId: string, name: CapabilityName): CapabilityAnswer;
  /** Closes every socket. Idempotent. */
  close(): Promise<void>;
}

export const createRuntime = (platform: Platform): Runtime => createRuntimeWithSeams(platform).runtime;
