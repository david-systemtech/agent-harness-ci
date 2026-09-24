import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { answerCapability } from "./capabilities.js";
import { createRegistry, type ConnectionSeams } from "./connections/registry.js";
import { createNotices } from "./notices.js";
import type { Platform } from "./platform.js";
import { environmentsProjection } from "./projections/environments.js";
import type { Runtime } from "./runtime.js";

/**
 * The runtime together with its internal seams: raw frames, socket closes,
 * forgetting, and requests on a connection's socket. Subscriptions (#127)
 * and the outbox (#128) attach here, inside the package; renderers never do
 * (ADR 0004). This module is not exported from
 * the package, so a renderer cannot import it.
 */
export interface RuntimeWithSeams {
  readonly runtime: Runtime;
  readonly seams: ConnectionSeams;
}

export interface InternalOptions {
  /** The protocol version the runtime speaks: `PROTOCOL_VERSION`; a test names another to be the newer side of a mismatch. */
  readonly protocolVersion?: number;
}

export const createRuntimeWithSeams = (platform: Platform, options: InternalOptions = {}): RuntimeWithSeams => {
  const notices = createNotices(platform.clock);
  const registry = createRegistry(platform, options.protocolVersion ?? PROTOCOL_VERSION, notices);
  const environments = environmentsProjection(registry.list);
  let started: Promise<void> | undefined;

  const runtime: Runtime = {
    // A start that failed is not kept: the next call starts again.
    start: () =>
      (started ??= registry.start().catch((error: unknown) => {
        started = undefined;
        throw error;
      })),
    local: registry.local,
    connections: {
      list: registry.list,
      add: (input, pairing) => registry.add(input, pairing),
      setAddress: (environmentId, address) => registry.setAddress(environmentId, address),
      setEnabled: (environmentId, enabled) => registry.setEnabled(environmentId, enabled),
      setOrder: (environmentIds) => registry.setOrder(environmentIds),
      setLastUsed: (environmentId) => registry.setLastUsed(environmentId),
      remove: (environmentId) => registry.remove(environmentId),
      retryNow: (environmentId) => registry.retryNow(environmentId),
      startService: (environmentId) => registry.startService(environmentId),
    },
    preferences: registry.preferences,
    projections: { environments, notices: notices.list },
    notices: { dismiss: (id) => notices.dismiss(id) },
    capability: (environmentId, name) => answerCapability(name, registry.record(environmentId), platform.shell),
    async close() {
      registry.close();
    },
  };
  return { runtime, seams: registry.seams };
};
