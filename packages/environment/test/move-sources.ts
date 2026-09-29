import type { KeyManagerReference, WireError } from "@agent-harness/contracts";
import type { MoveSource, MoveSourceItem } from "../src/key-managers/moves.js";

/**
 * A scripted Move source (key-managers spec, "Testing Decisions"; #371):
 * forge accounts that are no forge's, each holding the stored value the
 * test gives it at a place of its own, whose swap and delete fail when the
 * test says. Every swap and delete is recorded; `whileSwapping` runs inside
 * each swap, where a test looks at what the environment holds meanwhile.
 */
export interface ScriptedMoveSource {
  readonly source: MoveSource;
  /** Makes item `id` hold `value` as its stored value, known by `name`, its entry `forge-<entry>`. */
  hold(id: string, value: string, entry: string): void;
  /** Makes item `id`'s swaps refuse with `error` from now on; null to let them take. */
  failSwap(id: string, error: WireError | null): void;
  /** Makes item `id`'s deletes fail from now on, or take again. */
  failDelete(id: string, fails: boolean): void;
  /** Runs inside every swap, before it answers. */
  whileSwapping(hook: (id: string) => void): void;
  /** The references items were swapped to, by id. */
  readonly swapped: ReadonlyMap<string, KeyManagerReference>;
  /** Every delete asked for, in order, whether it took or not. */
  readonly deletes: readonly { readonly id: string; readonly storedAt: string }[];
}

/** Where the scripted source keeps item `id`'s stored value. */
export const storedAtOf = (id: string): string => `scripted:${id}`;

export const scriptedMoveSource = (): ScriptedMoveSource => {
  const values = new Map<string, { readonly value: string; readonly item: MoveSourceItem }>();
  const swapFailures = new Map<string, WireError>();
  const deleteFailures = new Set<string>();
  const swapped = new Map<string, KeyManagerReference>();
  const deletes: { id: string; storedAt: string }[] = [];
  let hook: (id: string) => void = () => undefined;
  return {
    source: {
      kind: "forge-account",
      key: "token",
      items: () => [...values.entries()].filter(([id]) => !swapped.has(id)).map(([, held]) => held.item),
      read: async (id) => {
        const held = values.get(id);
        return held === undefined || swapped.has(id) ? null : { value: held.value, storedAt: storedAtOf(id) };
      },
      swap: async (id, reference) => {
        hook(id);
        const failure = swapFailures.get(id);
        if (failure !== undefined) return { outcome: "refused", error: failure };
        swapped.set(id, reference);
        return { outcome: "swapped" };
      },
      delete: async (id, storedAt) => {
        deletes.push({ id, storedAt });
        if (deleteFailures.has(id)) throw new Error(`The scripted source was told to fail deleting ${storedAt}.`);
      },
    },
    hold: (id, value, entry) => void values.set(id, { value, item: { id, name: `scripted ${entry}`, entry: `forge-${entry}`, service: "scripted.example", note: `The scripted item ${entry}.` } }),
    failSwap: (id, error) => void (error === null ? swapFailures.delete(id) : swapFailures.set(id, error)),
    failDelete: (id, fails) => void (fails ? deleteFailures.add(id) : deleteFailures.delete(id)),
    whileSwapping: (given) => void (hook = given),
    swapped,
    deletes,
  };
};
