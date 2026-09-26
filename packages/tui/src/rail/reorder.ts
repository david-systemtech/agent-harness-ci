import { compareKeys, keyBetween, spreadKeys } from "@agent-harness/contracts";

/**
 * The keys `Shift+↑` and `Shift+↓` write (session-state spec, "Ordering:
 * fractional keys"): a move gives the session moved one key between its
 * rendered neighbours in the section (the pinned block, or one heading's
 * active sessions), on its own environment, touching no neighbour, so lists
 * from several environments merge with no agreement. When a neighbour has
 * no key (a section in activity order, or keyless pins), or the neighbours'
 * keys leave no room between them, keys are spread evenly over the section
 * in its new order: one command per session whose key changes. The
 * contracts' ordering module generates both, as every client does.
 */

/** A row of a section: where the session is, and which it is. */
export interface Placed {
  readonly environmentId: string;
  readonly summary: { readonly id: string };
}

/** One command's worth: the key to write to one session on its environment. */
export interface KeyMove {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly key: string;
}

/** The keys to write, or the end of the section the session is already at. */
export type Reorder = { readonly moves: readonly KeyMove[] } | { readonly edge: "top" | "bottom" };

const moveOf = <R extends Placed>(row: R, key: string): KeyMove => ({ environmentId: row.environmentId, sessionId: row.summary.id, key });

/** The moves that put the session at `at` in `section` one place up (-1) or down (1); `keyOf` reads the section's key. */
export const movesFor = <R extends Placed>(section: readonly R[], at: number, step: -1 | 1, keyOf: (row: R) => string | null): Reorder => {
  const target = at + step;
  if (target < 0) return { edge: "top" };
  if (target >= section.length) return { edge: "bottom" };
  const order = [...section];
  const [moved] = order.splice(at, 1);
  if (moved === undefined) return { edge: step < 0 ? "top" : "bottom" };
  order.splice(target, 0, moved);
  const before = order[target - 1];
  const after = order[target + 1];
  const beforeKey = before === undefined ? null : keyOf(before);
  const afterKey = after === undefined ? null : keyOf(after);
  const neighboursKeyed = (before === undefined || beforeKey !== null) && (after === undefined || afterKey !== null);
  if (neighboursKeyed && (beforeKey === null || afterKey === null || compareKeys(beforeKey, afterKey) < 0)) {
    return { moves: [moveOf(moved, keyBetween(beforeKey, afterKey))] };
  }
  const keys = spreadKeys(order.length);
  return { moves: order.flatMap((row, i) => (keys[i] !== undefined && keys[i] !== keyOf(row) ? [moveOf(row, keys[i])] : [])) };
};
