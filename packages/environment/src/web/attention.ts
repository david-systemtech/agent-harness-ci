import type { Vault } from "../serve/vault.js";
import { readdir } from "node:fs/promises";
import type { Clock } from "../serve/clock.js";
import type { EventLog } from "../event-log/event-log.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { RoutineEndpoints } from "../routines/endpoints.js";
import { createAttentionDispatcher } from "../attention/dispatcher.js";
import { attentionMethods } from "../attention/methods.js";
import type { AttentionTransport, AttentionTransports } from "../attention/targets.js";

/** Transport leaves export createAttentionTransport(context); no startup edits are needed. */
export interface WebAttentionContext {
  readonly log: EventLog;
  readonly vault: Vault;
  readonly clock: Clock;
  readonly environmentId: string;
  readonly webOrigin: () => string | undefined;
  readonly endpoints: RoutineEndpoints;
}
export type AttentionTransportFactory = (context: WebAttentionContext) => (AttentionTransport & { readonly handlers?: MethodHandlers }) | Promise<AttentionTransport & { readonly handlers?: MethodHandlers }>;
const registered = new Map<keyof AttentionTransports, AttentionTransportFactory>();
/** Embedders/tests can supply transports at the network seam; each environment gets a fresh instance. */
export const registerAttentionTransport = (name: keyof AttentionTransports, factory: AttentionTransportFactory): (() => void) => {
  if (registered.has(name)) throw new Error(`Attention transport ${name} is already registered.`);
  registered.set(name, factory);
  return () => { registered.delete(name); };
};

export const webAttention = async (context: WebAttentionContext): Promise<{ readonly handlers: MethodHandlers; readonly close: () => void }> => {
  const transports: Partial<Record<keyof AttentionTransports, AttentionTransport>> = {};
  const leafHandlers: MethodHandlers = {};
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const directory = new URL("../attention/", import.meta.url);
  const files = await readdir(directory);
  for (const name of ["webhook", "push"] as const) {
    try {
      let factory = registered.get(name);
      if (!factory && files.includes(`${name}${extension}`)) {
        const leaf = await import(new URL(`${name}${extension}`, directory).href) as { readonly createAttentionTransport: AttentionTransportFactory };
        factory = leaf.createAttentionTransport;
      }
      if (factory) { const transport = await factory(context); transports[name] = transport; Object.assign(leafHandlers, transport.handlers); }
    } catch { console.error(`Attention transport ${name} is unavailable.`); }
  }
  const dispatcher = createAttentionDispatcher({ ...context, transports });
  return { handlers: { ...attentionMethods(dispatcher.store, transports, () => context.webOrigin() !== undefined, context.endpoints), ...leafHandlers }, close: dispatcher.close };
};
