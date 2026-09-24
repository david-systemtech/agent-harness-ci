import type { Adapter } from "./contract.js";

/** The adapters the host holds, by provider id (the descriptor's `provider`): one per provider. */
export interface AdapterRegistry {
  get(provider: string): Adapter | undefined;
  list(): readonly Adapter[];
}

export const createAdapterRegistry = (adapters: readonly Adapter[]): AdapterRegistry => {
  const byProvider = new Map<string, Adapter>();
  for (const adapter of adapters) {
    const { provider } = adapter.descriptor;
    if (byProvider.has(provider)) throw new Error(`Two adapters declare the provider ${provider}.`);
    if (adapter.descriptor.steering && !adapter.descriptor.providerQueue) {
      throw new Error(`The ${provider} adapter declares steering without providerQueue, which steering presupposes (ADR 0022).`);
    }
    byProvider.set(provider, adapter);
  }
  return { get: (provider) => byProvider.get(provider), list: () => [...byProvider.values()] };
};
