import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { exchangeGrant, type LocalStatus } from "./bootstrap.js";
import { answerCapability, type CapabilityAnswer, type CapabilityName } from "./capabilities.js";
import { createRegistry, type ConnectionSeams, type Connections } from "./connections/registry.js";
import type { ClientPreferences } from "./connections/records.js";
import { writable, type Observable } from "./observable.js";
import type { Platform } from "./platform.js";
import { environmentsProjection, type EnvironmentView } from "./projections/environments.js";

/**
 * The client runtime (docs/specs/client-runtime.md): what every client
 * renders from. Given a platform it keeps the saved connections, exchanges
 * the local bootstrap grant, pairs, fills each connection from `hello`, and
 * answers capability questions. Subscriptions (#127), the outbox (#128) and
 * the reconnect machine (#126) attach through `seams`.
 */
export interface Runtime {
  /** Reads what was saved, exchanges the local grant when the platform reads one, and makes one attempt on every enabled connection. */
  start(): Promise<void>;
  /** What became of the local environment at start. */
  readonly local: Observable<LocalStatus>;
  readonly connections: Connections;
  /** The client-local preferences: the environment sequence, enabled flags, the last environment used. */
  readonly preferences: Observable<ClientPreferences>;
  readonly projections: { readonly environments: Observable<readonly EnvironmentView[]> };
  /** `present`, or `absent` with a reason and one line for people. */
  capability(environmentId: string, name: CapabilityName): CapabilityAnswer;
  readonly seams: ConnectionSeams;
  /** Closes every socket. Idempotent. */
  close(): Promise<void>;
}

export const createRuntime = (platform: Platform): Runtime => {
  const registry = createRegistry(platform, PROTOCOL_VERSION);
  const local = writable<LocalStatus>({ state: "none" });
  const environments = environmentsProjection(registry.list);
  let started: Promise<void> | undefined;

  const start = async () => {
    await registry.load();
    const exchange = await exchangeGrant({ fetch: platform.fetch, grant: platform.grant, client: platform.client, protocolVersion: PROTOCOL_VERSION });
    if (exchange.ok) {
      await registry.adoptLocal(exchange.origin, exchange.discovery, exchange.credential);
      local.set({ state: "exchanged", environmentId: exchange.discovery.environmentId });
    } else {
      local.set(exchange.status);
    }
    await registry.connectAll();
  };

  return {
    start: () => (started ??= start()),
    local,
    connections: {
      list: registry.list,
      add: (input, options) => registry.add(input, options),
      setAddress: (environmentId, address) => registry.setAddress(environmentId, address),
      setEnabled: (environmentId, enabled) => registry.setEnabled(environmentId, enabled),
      setOrder: (environmentIds) => registry.setOrder(environmentIds),
      setLastUsed: (environmentId) => registry.setLastUsed(environmentId),
      remove: (environmentId) => registry.remove(environmentId),
      retryNow: (environmentId) => registry.retryNow(environmentId),
    },
    preferences: registry.preferences,
    projections: { environments },
    capability: (environmentId, name) => answerCapability(name, registry.record(environmentId), platform.shell),
    seams: registry.seams,
    async close() {
      registry.close();
    },
  };
};
