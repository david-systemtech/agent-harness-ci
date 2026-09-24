import type { LocalStatus } from "./bootstrap.js";
import type { CapabilityAnswer, CapabilityName } from "./capabilities.js";
import type { ClientPreferences } from "./connections/records.js";
import type { Connections } from "./connections/registry.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Observable } from "./observable.js";
import type { Platform } from "./platform.js";
import type { EnvironmentView } from "./projections/environments.js";

/**
 * The client runtime (docs/specs/client-runtime.md): what every client
 * renders from, and all a renderer sees. Given a platform it keeps the saved
 * connections, exchanges the local bootstrap grant, pairs, fills each
 * connection from `hello`, and answers capability questions. It carries no
 * frames and no raw requests (ADR 0004: renderers never reach the streams).
 */
export interface Runtime {
  /** Reads what was saved, exchanges the local grant when the platform reads one, and makes one attempt on every enabled connection. A failed start may be called again. */
  start(): Promise<void>;
  /** What became of the local environment's grant exchange. */
  readonly local: Observable<LocalStatus>;
  readonly connections: Connections;
  /** The client-local preferences: the environment sequence, enabled flags, the last environment used. */
  readonly preferences: Observable<ClientPreferences>;
  readonly projections: { readonly environments: Observable<readonly EnvironmentView[]> };
  /** `present`, or `absent` with a reason and one line for people. */
  capability(environmentId: string, name: CapabilityName): CapabilityAnswer;
  /** Closes every socket. Idempotent. */
  close(): Promise<void>;
}

export const createRuntime = (platform: Platform): Runtime => createRuntimeWithSeams(platform).runtime;
