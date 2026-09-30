import { compareKeys, keyBetween, spreadKeys } from "@agent-harness/contracts";
import type { Commands, DispatchAnswer } from "../outbox/outbox.js";
import type { SessionRow } from "../projections/session-list.js";
import { rowKey, type SessionBlock, type SessionHeading } from "./headings.js";

/**
 * Arranging sessions by hand (session-state spec, "Ordering: fractional
 * keys"; docs/specs/tui.md, "The rail"; docs/specs/gui.md, "The window and
 * the sidebar"), which the terminal UI's `Shift+↑` and `Shift+↓` and the
 * window's drag both do, so both send the same commands:
 *
 * - **A move within a block** (the pinned block, or one heading's active
 *   sessions: a merged group's across environments, an environment's
 *   ungrouped ones) gives the session moved one key between its drawn
 *   neighbours, on its own environment, touching no neighbour, so lists
 *   from several environments merge with no agreement. When a neighbour
 *   has no key (a section in activity order, or keyless pins), or the
 *   neighbours' keys leave no room between them, keys are spread evenly
 *   over the section in its new order: one command per session whose key
 *   changes. The contracts' ordering module generates both.
 * - **A drop** (the window's) onto a row takes that row's place: within the
 *   dragged session's own block it is a move as above; into the pinned
 *   block it pins the session there (`sessions.pin` with the key between
 *   its new neighbours, spread as above when there is no room); onto a
 *   group, its heading or its rows, it moves the session into it
 *   (`commands.moveToGroup`, by the merged heading's name); onto its own
 *   environment's heading, out of its group. Onto the pinned block's
 *   heading it pins it at the end, with no key.
 * - **Refused**, with nothing sent: a shelf (the snoozed, settled and
 *   archived ones), which has no manual order; another environment's
 *   heading, since a session stays on its environment; by repository, a
 *   repository's heading or its rows, for a session not of that
 *   repository, and an environment's heading for one of any repository,
 *   since a repository is not a group: a session's is its workspace's; and
 *   a filtered list, since the neighbours a move goes between may be
 *   hidden. Each renderer says why in its own words (`noManualOrder` for a
 *   shelf). A session of the repository dropped on its heading, or one with
 *   none on its environment's, stays where it is.
 */

/** A shelf, which has no manual order. */
export type UnorderedShelf = "snoozed" | "settled" | "archived";

/** Why a shelf has no manual order, in words: a move on it, or a drop onto it, is refused with it. */
export const noManualOrder = (shelf: UnorderedShelf): string => {
  switch (shelf) {
    case "snoozed":
      return "the snoozed shelf has no manual order; it is sorted by wake time";
    case "settled":
      return "the settled shelf has no manual order; it is sorted by when each settled, newest first";
    case "archived":
      return "the archive has no manual order; it is sorted by when each was archived, newest first";
  }
};

/** A row a manual order goes among: where the session is, and which it is, with its keys. */
export type Placed = Pick<SessionRow, "environmentId" | "summary">;

/** One command's worth: the key to write to one session on its environment. */
export interface KeyMove {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly key: string;
}

/** Why an arrangement sends nothing: a shelf, another environment (the session's own named), a repository, a filtered list. */
export type Refusal =
  | { readonly kind: "refused"; readonly why: "shelf"; readonly shelf: UnorderedShelf }
  | { readonly kind: "refused"; readonly why: "environment"; readonly environmentId: string }
  | { readonly kind: "refused"; readonly why: "repository" }
  | { readonly kind: "refused"; readonly why: "filtered" };

/** What an arrangement sends, or why it sends nothing. */
export type Arrangement =
  | Refusal
  /** Dropped where it already is: nothing to send. */
  | { readonly kind: "unchanged" }
  /** Keys within the pinned block (`sessions.reorderPinned`) or an active list (`sessions.reorderActive`). */
  | { readonly kind: "reorder"; readonly block: "pinned" | "active"; readonly moves: readonly KeyMove[] }
  /** `sessions.pin` of `row`, with `key` (null: none, at the block's end), then the other pins' `moves` when keys were spread. */
  | { readonly kind: "pin"; readonly row: SessionRow; readonly key: string | null; readonly moves: readonly KeyMove[] }
  /** `commands.moveToGroup` of `row` into the group of that name on its environment, or (null) out of its group. */
  | { readonly kind: "group"; readonly row: SessionRow; readonly name: string | null };

/** Where a session is dropped: a row of a heading (its place in the heading's block), a heading, the pinned block while it holds nothing, or a filtered list. */
export type DropTarget =
  | { readonly kind: "row"; readonly heading: SessionHeading; readonly at: number }
  | { readonly kind: "heading"; readonly heading: SessionHeading }
  | { readonly kind: "pinned" }
  | { readonly kind: "filtered" };

const moveOf = (row: Placed, key: string): KeyMove => ({ environmentId: row.environmentId, sessionId: row.summary.id, key });

/** The key a block's manual order is kept in: `pinOrderKey` in the pinned block, `activeOrderKey` in an active list. */
const keyIn =
  (block: "pinned" | "active") =>
  (row: Placed): string | null =>
    block === "pinned" ? row.summary.pinOrderKey : row.summary.activeOrderKey;

/**
 * The keys that hold `order[at]` where it is in `order`, the section as it
 * will be drawn: one key between its neighbours when both have keys with
 * room between (or it is at an end), else keys spread over the section, one
 * move per session whose key changes.
 */
export const keysFor = <R extends Placed>(order: readonly R[], at: number, keyOf: (row: R) => string | null): readonly KeyMove[] => {
  const moved = order[at];
  if (moved === undefined) return [];
  const before = order[at - 1];
  const after = order[at + 1];
  const beforeKey = before === undefined ? null : keyOf(before);
  const afterKey = after === undefined ? null : keyOf(after);
  const neighboursKeyed = (before === undefined || beforeKey !== null) && (after === undefined || afterKey !== null);
  if (neighboursKeyed && (beforeKey === null || afterKey === null || compareKeys(beforeKey, afterKey) < 0)) return [moveOf(moved, keyBetween(beforeKey, afterKey))];
  const keys = spreadKeys(order.length);
  return order.flatMap((row, i) => (keys[i] !== undefined && keys[i] !== keyOf(row) ? [moveOf(row, keys[i])] : []));
};

/** `rows` with the one at `from` put at `to`. */
const moved = <R>(rows: readonly R[], from: number, to: number): R[] => {
  const order = [...rows];
  const [row] = order.splice(from, 1);
  if (row !== undefined) order.splice(to, 0, row);
  return order;
};

const shelfOf = (block: SessionBlock): UnorderedShelf | null => (block.kind === "pinned" || block.kind === "active" ? null : block.kind);

/** The row at `from` of `block` put at `to` of its new order: the keys, refused on a shelf, unchanged in its own place. */
const reorder = (block: SessionBlock, from: number, to: number): Arrangement => {
  const shelf = shelfOf(block);
  if (shelf !== null) return { kind: "refused", why: "shelf", shelf };
  if (from === to) return { kind: "unchanged" };
  const kind = block.kind === "pinned" ? "pinned" : "active";
  return { kind: "reorder", block: kind, moves: keysFor(moved(block.rows, from, to), to, keyIn(kind)) };
};

/** The row at `at` of `block` one place up (-1) or down (1): the terminal UI's `Shift+↑` and `Shift+↓`; the edge when it is at that end already. */
export const stepIn = (block: SessionBlock, at: number, step: -1 | 1): Arrangement | { readonly edge: "top" | "bottom" } => {
  const shelf = shelfOf(block);
  if (shelf !== null) return { kind: "refused", why: "shelf", shelf };
  const to = at + step;
  if (to < 0) return { edge: "top" };
  if (to >= block.rows.length) return { edge: "bottom" };
  return reorder(block, at, to);
};

/** `row` pinned at `at` of the pinned block's rows (`pinned`), or at its end with no key. */
const pinAt = (row: SessionRow, pinned: readonly SessionRow[], at: number | null): Arrangement => {
  if (at === null) return { kind: "pin", row, key: null, moves: [] };
  const order = [...pinned.slice(0, at), row, ...pinned.slice(at)];
  const moves = keysFor(order, at, keyIn("pinned"));
  const own = moves.find((move) => move.sessionId === row.summary.id && move.environmentId === row.environmentId);
  return { kind: "pin", row, key: own?.key ?? null, moves: moves.filter((move) => move !== own) };
};

/** `dragged` dropped onto a heading, or a row of one taking the place `at` of its block. */
const ontoHeading = (dragged: SessionRow, heading: SessionHeading, at: number | null): Arrangement => {
  const from = heading.block.rows.findIndex((row) => rowKey(row) === rowKey(dragged));
  const shelf = shelfOf(heading.block);
  if (shelf !== null) return { kind: "refused", why: "shelf", shelf };
  if (from !== -1) return at === null ? { kind: "unchanged" } : reorder(heading.block, from, at);
  if (heading.kind === "pinned") return pinAt(dragged, heading.block.rows, at);
  const { repositoryIdentity } = dragged.summary;
  // A repository is not a group: a session's is its workspace's, and no drop puts it under another.
  const underIt = (identity: string | null) => (repositoryIdentity === identity ? { kind: "unchanged" as const } : { kind: "refused" as const, why: "repository" as const });
  if (heading.kind === "repository") return underIt(heading.repository);
  if (heading.kind === "environment") {
    if (heading.environment.environmentId !== dragged.environmentId) return { kind: "refused", why: "environment", environmentId: dragged.environmentId };
    if (heading.holds === "unidentified") return underIt(null);
    return dragged.groupName === null ? { kind: "unchanged" } : { kind: "group", row: dragged, name: null };
  }
  const group = heading.kind === "group" ? heading.group : null;
  if (group === null) return { kind: "unchanged" };
  const inIt = group.groups.some((member) => member.environmentId === dragged.environmentId && member.groupId === dragged.summary.groupId);
  return inIt ? { kind: "unchanged" } : { kind: "group", row: dragged, name: group.name };
};

/** What dropping `dragged` onto `target` sends, or why it sends nothing. */
export const dropOnto = (dragged: SessionRow, target: DropTarget): Arrangement => {
  switch (target.kind) {
    case "filtered":
      return { kind: "refused", why: "filtered" };
    case "pinned":
      return dragged.summary.pinnedAt === null ? pinAt(dragged, [], null) : { kind: "unchanged" };
    case "heading":
      return target.heading.kind === "pinned" && dragged.summary.pinnedAt !== null ? { kind: "unchanged" } : ontoHeading(dragged, target.heading, null);
    case "row":
      return ontoHeading(dragged, target.heading, target.at);
  }
};

/** An answer of one of the commands an arrangement sends. */
export type ArrangeAnswer = DispatchAnswer<"sessions.reorderPinned" | "sessions.reorderActive" | "sessions.pin" | "sessions.setGroup">;

/**
 * Sends what `arrangement` says through the outbox, each command once with
 * its command id; answers every command's answer, none for an arrangement
 * that sends nothing.
 */
export const arrange = (commands: Pick<Commands, "dispatch" | "moveToGroup">, arrangement: Arrangement): Promise<readonly ArrangeAnswer[]> => {
  const reorders = (method: "sessions.reorderPinned" | "sessions.reorderActive", moves: readonly KeyMove[]) =>
    moves.map((move) => commands.dispatch(move.environmentId, method, { sessionId: move.sessionId, orderKey: move.key }));
  switch (arrangement.kind) {
    case "refused":
    case "unchanged":
      return Promise.resolve([]);
    case "reorder":
      return Promise.all(reorders(arrangement.block === "pinned" ? "sessions.reorderPinned" : "sessions.reorderActive", arrangement.moves));
    case "pin": {
      const { row, key } = arrangement;
      const pinned = commands.dispatch(row.environmentId, "sessions.pin", { sessionId: row.summary.id, ...(key !== null && { orderKey: key }) });
      return Promise.all([pinned, ...reorders("sessions.reorderPinned", arrangement.moves)]);
    }
    case "group":
      return Promise.all([commands.moveToGroup(arrangement.row.environmentId, arrangement.row.summary.id, arrangement.name)]);
  }
};
