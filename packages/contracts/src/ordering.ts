import { z } from "zod";
import type { Group, SessionSummary } from "./sessions.js";

/**
 * Order keys and the session-list sort (session-state spec, "Ordering:
 * fractional keys"): the one module every client imports, so every client
 * orders the same summaries the same way. A move writes one key to one
 * session on its own environment and touches no neighbour, so lists from
 * several environments merge without agreement. Making keys is a client's
 * job; the environment only validates and stores them. Everything here is
 * pure: the client passes its connection list and the environment's time.
 */

/** The digits of a key, lowest first: `a` is zero, so a key never ends in it. */
const DIGITS = "abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const ZERO = DIGITS.charAt(0);
const LAST = DIGITS.charAt(BASE - 1);
/** Any digits, then one that is not zero. */
const ORDER_KEY = new RegExp(`^[${DIGITS}]*[${DIGITS.slice(1)}]$`);
/** The zeros a key may not end in, which `spreadKeys` strips. */
const TRAILING_ZEROS = new RegExp(`${ZERO}+$`);

/**
 * A fractional order key: letters `a` to `z`, compared as plain strings,
 * never empty and never ending in `a`, so a key can always be made before
 * any key. Clients make keys; the environment only stores them.
 */
export const OrderKey = z
  .string()
  .regex(ORDER_KEY)
  .meta({
    description: `A fractional order key: letters ${ZERO} to ${LAST} compared as plain strings, never empty and never ending in ${ZERO}, so a key can always be made before any other.`,
  });
export type OrderKey = z.infer<typeof OrderKey>;

/** Whether `value` is an order key: `a` to `z`, not empty, not ending in `a`. */
export const isOrderKey = (value: string): boolean => ORDER_KEY.test(value);

/** Orders two keys as plain strings: negative when `a` sorts first, zero when equal, positive after. */
export const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const digit = (key: string, at: number): number => (at < key.length ? DIGITS.indexOf(key.charAt(at)) : 0);

/**
 * The key between `low` (or zero, when empty) and `high` (or one, when
 * null), reading a key as a fraction in base 26 after the point. Both are
 * valid keys or their open ends, and `low < high`. It works a digit at a
 * time, so plain numbers suffice however long the keys; `spreadKeys`
 * divides whole fractions and needs BigInt.
 */
const midpoint = (low: string, high: string | null): string => {
  if (high !== null) {
    // Carry the prefix the two share (reading a missing digit of `low` as a).
    let shared = 0;
    while ((low.charAt(shared) || ZERO) === high.charAt(shared)) shared++;
    if (shared > 0) return high.slice(0, shared) + midpoint(low.slice(shared), high.slice(shared));
  }
  const lowDigit = low === "" ? 0 : digit(low, 0);
  const highDigit = high === null ? BASE : digit(high, 0);
  if (highDigit - lowDigit > 1) return DIGITS.charAt(Math.round((lowDigit + highDigit) / 2));
  // Adjacent first digits: `high`'s first digit alone is between, if `high` goes on past it.
  if (high !== null && high.length > 1) return high.charAt(0);
  return DIGITS.charAt(lowDigit) + midpoint(low.slice(1), null);
};

/**
 * The key to give a session placed between its rendered neighbours: after
 * `before` and before `after`, either null for the open end of the section.
 * Both must be order keys with `before < after`; anything else is a
 * `RangeError`, since a client asking for it has sorted wrongly.
 */
export const keyBetween = (before: string | null, after: string | null): string => {
  for (const key of [before, after]) {
    if (key !== null && !isOrderKey(key)) throw new RangeError(`${JSON.stringify(key)} is not an order key.`);
  }
  if (before !== null && after !== null && compareKeys(before, after) >= 0) {
    throw new RangeError(`The key before (${before}) must sort before the key after (${after}).`);
  }
  return midpoint(before ?? "", after);
};

/**
 * `count` keys, ascending, spread evenly over the whole key space: what a
 * client gives every session of a section, in the order it renders them,
 * when a move lands next to a neighbour with no key. Each key is the
 * fraction `(i + 1) / (count + 1)` to as few letters as keep them distinct,
 * so there is room before the first and after the last.
 */
export const spreadKeys = (count: number): string[] => {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`A count of keys is a whole number of zero or more; got ${count}.`);
  // Exact arithmetic on fractions of `length` digits: count × 26^length outgrows a double's integers for large counts.
  const slots = BigInt(count + 1);
  let length = 1;
  let space = BigInt(BASE);
  while (space < slots) {
    length++;
    space *= BigInt(BASE);
  }
  const keys: string[] = [];
  for (let i = 1n; i <= BigInt(count); i++) {
    let value = (i * space) / slots;
    let key = "";
    for (let place = 0; place < length; place++) {
      key = DIGITS.charAt(Number(value % BigInt(BASE))) + key;
      value /= BigInt(BASE);
    }
    keys.push(key.replace(TRAILING_ZEROS, ""));
  }
  return keys;
};

/** What the sort reads of a summary; a deleted session, as `sessions.listDeleted` has it, also carries `deletedAt`. */
export type SortableSummary = Pick<
  SessionSummary,
  | "id"
  | "createdAt"
  | "lastActivityAt"
  | "unsettledAt"
  | "archivedAt"
  | "pinnedAt"
  | "pinOrderKey"
  | "activeOrderKey"
  | "settledAt"
  | "snoozedUntil"
> & { readonly deletedAt?: string | null };

/** A session as a client lists it: the environment it is on (the client's id for that connection) and its summary. */
export interface ListedSession<S extends SortableSummary = SortableSummary> {
  readonly environmentId: string;
  readonly summary: S;
}

/** What the sort reads of a group. */
export type SortableGroup = Pick<Group, "id" | "orderKey" | "createdAt">;

/** A group as a client lists it: the environment it is on and the group. */
export interface ListedGroup<G extends SortableGroup = SortableGroup> {
  readonly environmentId: string;
  readonly group: G;
}

/**
 * The environments in the order of the client's connection list, by the ids
 * its `ListedSession`s carry: the last tie-break before an id. An
 * environment not in it sorts after every one that is.
 */
export type EnvironmentOrder = readonly string[];

/** Where a session shows: hidden (deleted), archived, settled, snoozed, pinned or active. */
export const SHELVES = ["hidden", "archived", "settled", "snoozed", "pinned", "active"] as const;
export type Shelf = (typeof SHELVES)[number];

const instant = (timestamp: string | null): number => (timestamp === null ? Number.NaN : Date.parse(timestamp));

/** What shelf membership reads of a session. */
export type ShelfFields = Pick<SortableSummary, "archivedAt" | "settledAt" | "snoozedUntil" | "pinnedAt" | "deletedAt">;

/**
 * The shelf a session is on once any snooze has passed: hidden if deleted;
 * else archived; else settled; else pinned; else active. A session is
 * settled while it has a `settledAt`, which an unsettle clears. The
 * environment asks this of a snoozed session, which keeps its slot.
 */
export const awakeShelfOf = (summary: ShelfFields): Exclude<Shelf, "snoozed"> => {
  if (summary.deletedAt !== undefined && summary.deletedAt !== null) return "hidden";
  if (summary.archivedAt !== null) return "archived";
  if (summary.settledAt !== null) return "settled";
  if (summary.pinnedAt !== null) return "pinned";
  return "active";
};

/**
 * The shelf a session is on: hidden if deleted; else archived; else
 * settled; else snoozed (`snoozedUntil` after `now`, the environment's time
 * as the client reckons it from `hello`); else pinned; else active.
 */
export const shelfOf = (summary: ShelfFields, now: Date): Shelf => {
  const awake = awakeShelfOf(summary);
  const snoozed = summary.snoozedUntil !== null && instant(summary.snoozedUntil) > now.getTime();
  return snoozed && (awake === "pinned" || awake === "active") ? "snoozed" : awake;
};

type Compare<T> = (a: T, b: T) => number;

/** Instants compared as instants, earliest first or latest first; a missing instant after every present one, either way. */
const byTime =
  (order: "earliest" | "latest") =>
  (a: string | null, b: string | null): number => {
    const [x, y] = [instant(a), instant(b)];
    if (Number.isNaN(x) || Number.isNaN(y)) return Number(Number.isNaN(x)) - Number(Number.isNaN(y));
    return order === "earliest" ? x - y : y - x;
  };
const earliestFirst = byTime("earliest");
const latestFirst = byTime("latest");

/** Ids compared as plain strings: the last tie-break, a total order whatever an id looks like. */
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Keyed before keyless, keyed ascending by key; two keyless by `keyless`.
 * Two equal keys are a tie, for the tie-break.
 */
const keyedFirst = (a: string | null, b: string | null, keyless: () => number): number => {
  if (a !== null && b !== null) return compareKeys(a, b);
  if (a === null && b === null) return keyless();
  return a === null ? 1 : -1;
};

/** Ties: the environment's position in the connection list, then the id. */
const tieBreak =
  (environments: EnvironmentOrder): Compare<{ environmentId: string; id: string }> =>
  (a, b) => {
    const position = (id: string) => {
      const at = environments.indexOf(id);
      return at === -1 ? environments.length : at;
    };
    return position(a.environmentId) - position(b.environmentId) || compareIds(a.id, b.id);
  };

/** Sorts a copy of `rows` by `rule`, then the tie-break. */
const sortSessions = <R extends ListedSession>(
  rows: readonly R[],
  environments: EnvironmentOrder,
  rule: Compare<SortableSummary>,
): R[] => {
  const tie = tieBreak(environments);
  return [...rows].sort(
    (a, b) =>
      rule(a.summary, b.summary) ||
      tie({ environmentId: a.environmentId, id: a.summary.id }, { environmentId: b.environmentId, id: b.summary.id }),
  );
};

/** The latest of the session's last activity, its unsettle and its creation: the active list's clock for a keyless session. */
const activeAnchor = (summary: SortableSummary): string =>
  [summary.lastActivityAt, summary.unsettledAt].reduce<string>(
    (latest, at) => (at !== null && instant(at) > instant(latest) ? at : latest),
    summary.createdAt,
  );

/** The pinned block: keyed sessions ascending by `pinOrderKey`, then keyless by `pinnedAt` ascending (the oldest pin first). */
export const sortPinned = <R extends ListedSession>(rows: readonly R[], environments: EnvironmentOrder): R[] =>
  sortSessions(rows, environments, (a, b) => keyedFirst(a.pinOrderKey, b.pinOrderKey, () => earliestFirst(a.pinnedAt, b.pinnedAt)));

/**
 * The active list: keyless sessions first, by the latest of
 * `lastActivityAt`, `unsettledAt` and `createdAt`, newest first; then keyed
 * sessions ascending by `activeOrderKey`. New and unsettled sessions appear
 * above the arranged run; arranging a session takes it out of the activity order.
 */
export const sortActive = <R extends ListedSession>(rows: readonly R[], environments: EnvironmentOrder): R[] =>
  sortSessions(rows, environments, (a, b) => {
    // Keyless first here, the reverse of the pinned block and the groups.
    if ((a.activeOrderKey === null) !== (b.activeOrderKey === null)) return a.activeOrderKey === null ? -1 : 1;
    if (a.activeOrderKey !== null && b.activeOrderKey !== null) return compareKeys(a.activeOrderKey, b.activeOrderKey);
    return latestFirst(activeAnchor(a), activeAnchor(b));
  });

/** The settled shelf: by `settledAt`, newest first. */
export const sortSettled = <R extends ListedSession>(rows: readonly R[], environments: EnvironmentOrder): R[] =>
  sortSessions(rows, environments, (a, b) => latestFirst(a.settledAt, b.settledAt));

/** The snoozed shelf: by `snoozedUntil`, soonest first. */
export const sortSnoozed = <R extends ListedSession>(rows: readonly R[], environments: EnvironmentOrder): R[] =>
  sortSessions(rows, environments, (a, b) => earliestFirst(a.snoozedUntil, b.snoozedUntil));

/** The archive: by `archivedAt`, newest first. */
export const sortArchived = <R extends ListedSession>(rows: readonly R[], environments: EnvironmentOrder): R[] =>
  sortSessions(rows, environments, (a, b) => latestFirst(a.archivedAt, b.archivedAt));

/** Groups: keyed ascending by `orderKey`, then keyless by `createdAt`, oldest first. */
export const sortGroups = <R extends ListedGroup>(rows: readonly R[], environments: EnvironmentOrder): R[] => {
  const tie = tieBreak(environments);
  return [...rows].sort(
    (a, b) =>
      keyedFirst(a.group.orderKey, b.group.orderKey, () => earliestFirst(a.group.createdAt, b.group.createdAt)) ||
      tie({ environmentId: a.environmentId, id: a.group.id }, { environmentId: b.environmentId, id: b.group.id }),
  );
};

/** Every visible shelf of a list, each sorted by its rule. */
export type Shelves<R extends ListedSession> = { readonly [S in Exclude<Shelf, "hidden">]: R[] };

/** Puts each session on its shelf (`shelfOf` at `now`) and sorts every shelf; hidden sessions are left out. */
export const shelves = <R extends ListedSession>(rows: readonly R[], environments: EnvironmentOrder, now: Date): Shelves<R> => {
  const on = (shelf: Shelf) => rows.filter((listed) => shelfOf(listed.summary, now) === shelf);
  return {
    pinned: sortPinned(on("pinned"), environments),
    active: sortActive(on("active"), environments),
    snoozed: sortSnoozed(on("snoozed"), environments),
    settled: sortSettled(on("settled"), environments),
    archived: sortArchived(on("archived"), environments),
  };
};
