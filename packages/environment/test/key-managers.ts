import type { KeyManagerReference } from "@agent-harness/contracts";
import type { KeyManagerRegistry, ReferenceRequest } from "../src/key-managers/registry.js";

/**
 * A scripted key-manager registry (#312): the resolve seam the environment's
 * registry fills (#370), standing in for it. Each reference answers the
 * value the test scripted for it, or that it is unavailable
 * (`credential_source_unavailable`); every request is recorded, and the
 * values it has answered and not yet had released are counted. It registers
 * nothing with the scrub registry itself, so what a test sees scrubbed is
 * what its caller registered.
 */
export interface ScriptedKeyManagers {
  readonly registry: KeyManagerRegistry;
  /** Scripts what `reference` answers from now on: a value, or null for unavailable. */
  answer(reference: KeyManagerReference, value: string | null): void;
  /** Every request so far, in order. */
  readonly requests: readonly ReferenceRequest[];
  /** How many answered values have not been released. */
  outstanding(): number;
}

const keyOf = (reference: KeyManagerReference): string => JSON.stringify(Object.entries(reference).sort(([a], [b]) => (a < b ? -1 : 1)));

export const scriptedKeyManagers = (): ScriptedKeyManagers => {
  const values = new Map<string, string | null>();
  const requests: ReferenceRequest[] = [];
  let outstanding = 0;
  return {
    registry: {
      async resolve(request) {
        requests.push(request);
        const value = values.get(keyOf(request.reference)) ?? null;
        if (value === null) {
          return { outcome: "unavailable", code: "credential_source_unavailable", message: `The key manager answered no value for ${request.reference.provider} reference ${request.reference.connectionId}.` };
        }
        outstanding += 1;
        let released = false;
        return {
          outcome: "resolved",
          value,
          release: () => {
            if (released) return;
            released = true;
            outstanding -= 1;
          },
        };
      },
    },
    answer: (reference, value) => void values.set(keyOf(reference), value),
    requests,
    outstanding: () => outstanding,
  };
};
