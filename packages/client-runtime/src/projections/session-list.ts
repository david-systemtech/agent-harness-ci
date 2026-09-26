import {
  groupNameKey,
  shelfOf,
  sortActive,
  sortArchived,
  sortGroups,
  sortPinned,
  sortSettled,
  sortSnoozed,
  type SessionSummary,
  type Shelf,
} from "@agent-harness/contracts";
import type { ConnectionRecord } from "../connections/records.js";
import { derived, writable, type Observable } from "../observable.js";
import type { Clock, Timer } from "../platform.js";
import type { CommandTargets } from "../outbox/overlay.js";
import type { ListData } from "../streams/kinds.js";
import { emptyStream, type Freshness, type StreamState } from "../streams/stream.js";

/**
 * `projections.sessionList` (docs/specs/client-runtime.md, "Projections";
 * session-state spec, "Ordering: fractional keys" and "Merged groups by
 * name: a client obligation"): every summary across the enabled
 * environments, each row with its environment id for the badge (ADR 0005),
 * its pending flag and whether a command about it awaits its receipt, and
 * the views a sidebar renders, all sorted by the
 * contracts' ordering module, so every client orders the same summaries the
 * same way: order keys compare as plain strings, ties go to the
 * environment's place in the connection list, then the id. A pure function
 * of the connection records, each environment's list stream and each
 * environment's clock; nothing here is stored (ADR 0003): a merged heading
 * is a view over the groups each environment owns.
 *
 * Shelves read each session against its own environment's time (the skew
 * from `hello`), and the observable wakes itself when the next snooze
 * passes, so a session comes back on time without an event.
 */

/** One session as a list row. */
export interface SessionRow {
  /** The environment the session is on: the badge, and where a command about it goes. */
  readonly environmentId: string;
  readonly summary: SessionSummary;
  /** The name of the group the session is in on its environment; null when it is in none. */
  readonly groupName: string | null;
  /** A command about it waits in the outbox while its environment is unreachable: what it shows is the command's effect, not yet the environment's word. */
  readonly pending: boolean;
  /**
   * A command about it is queued or in flight in the outbox, whatever the
   * connection's phase, until its receipt (accepted or rejected) or its
   * drop: the row's pending marker. `pending` is this while the environment
   * cannot be reached.
   */
  readonly awaitingReceipt: boolean;
}

/** Sessions on each visible shelf, each sorted by its rule. */
export interface SessionShelves {
  /** Keyed by `pinOrderKey` across environments, then keyless by `pinnedAt`, oldest first. */
  readonly pinned: readonly SessionRow[];
  /** Keyless by latest activity first, then keyed by `activeOrderKey`. */
  readonly active: readonly SessionRow[];
  /** By `snoozedUntil`, soonest first. */
  readonly snoozed: readonly SessionRow[];
  /** By `settledAt`, newest first. */
  readonly settled: readonly SessionRow[];
  /** By `archivedAt`, newest first. */
  readonly archived: readonly SessionRow[];
}

/** One group of one environment inside a merged heading: what a command about it targets. */
export interface HeadingMember {
  readonly environmentId: string;
  readonly groupId: string;
  /** The name as that environment keeps it. */
  readonly name: string;
}

/**
 * Same-named groups of several environments as one heading: names equal
 * after trimming, collapsing white space and ignoring case (`groupNameKey`).
 * Its text is the primary environment's casing, else that of the first
 * environment in the connection list that has the name; it carries every
 * group it merges, so a command still targets one environment's group; a
 * rename on one environment splits it.
 */
export interface MergedGroupHeading {
  /** The name's merge key: `groupNameKey`, for client-local presentation keyed by heading. */
  readonly key: string;
  readonly name: string;
  /** In the connection list's order. */
  readonly groups: readonly HeadingMember[];
  readonly shelves: SessionShelves;
  /** A command about one of its groups waits in the outbox while that group's environment is unreachable. */
  readonly pending: boolean;
  /** A command about one of its groups is queued or in flight in the outbox, whatever the connection's phase, until its receipt or its drop. */
  readonly awaitingReceipt: boolean;
}

/** The sessions of one repository across environments (ADR 0005): the same kind of view over `repositoryIdentity`. */
export interface RepositoryHeading {
  readonly repositoryIdentity: string;
  readonly shelves: SessionShelves;
}

/** How current one environment's list is, and why its subscription failed if it did. */
export interface ListFreshness {
  readonly environmentId: string;
  readonly freshness: Freshness;
  readonly fault: string | null;
}

export interface SessionListView extends SessionShelves {
  /** Each enabled environment's list, in the connection list's order. */
  readonly environments: readonly ListFreshness[];
  /** Every session of every enabled environment, environment by environment. */
  readonly rows: readonly SessionRow[];
  /** Merged headings: those the primary environment has in its group order, then those found only on other environments by their key (`groupNameKey`). */
  readonly groups: readonly MergedGroupHeading[];
  /** One heading per repository identity, in plain string order. */
  readonly repositories: readonly RepositoryHeading[];
}

export interface SessionListInput {
  /** Every connection, in the saved sequence: the first is the primary environment. */
  readonly records: readonly ConnectionRecord[];
  /** Each environment's list, with the outbox's overlay laid over it. */
  readonly lists: ReadonlyMap<string, StreamState<ListData>>;
  /** Each environment's time now. */
  readonly now: (environmentId: string) => Date;
  /** The sessions and groups a command waits in the outbox about, on environments that cannot be reached. */
  readonly pending: CommandTargets;
  /** The sessions and groups a queued or in-flight command is about, on every environment. */
  readonly awaiting: CommandTargets;
}

type Visible = Exclude<Shelf, "hidden">;

/** The longest delay a timer takes: a signed 32-bit count of milliseconds, about 24.8 days. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

const shelvesOf = (rows: readonly SessionRow[], order: readonly string[], shelf: (row: SessionRow) => Shelf): SessionShelves => {
  const on = (name: Visible) => rows.filter((row) => shelf(row) === name);
  return {
    pinned: sortPinned(on("pinned"), order),
    active: sortActive(on("active"), order),
    snoozed: sortSnoozed(on("snoozed"), order),
    settled: sortSettled(on("settled"), order),
    archived: sortArchived(on("archived"), order),
  };
};

export const sessionListView = (input: SessionListInput): SessionListView => {
  const order = input.records.map((record) => record.environmentId);
  const primary = order[0];
  const enabled = input.records.filter((record) => record.enabled);
  const rows: SessionRow[] = [];
  // The environments are in connection order, the primary first, so the first to have a name gives its heading the casing.
  const headings = new Map<string, { name: string; members: HeadingMember[]; place: number | null; rows: SessionRow[] }>();
  const headingOf = new Map<string, string>();
  for (const { environmentId } of enabled) {
    const data = input.lists.get(environmentId)?.data;
    if (!data) continue;
    const groups = sortGroups([...data.groups.values()].map((group) => ({ environmentId, group })), order);
    groups.forEach(({ group }, index) => {
      const key = groupNameKey(group.name);
      let heading = headings.get(key);
      if (!heading) headings.set(key, (heading = { name: group.name, members: [], place: null, rows: [] }));
      heading.members.push({ environmentId, groupId: group.id, name: group.name });
      if (environmentId === primary) heading.place = index;
      headingOf.set(`${environmentId} ${group.id}`, key);
    });
    for (const summary of data.sessions.values()) {
      const groupName = summary.groupId === null ? null : (data.groups.get(summary.groupId)?.name ?? null);
      rows.push({
        environmentId,
        summary,
        groupName,
        pending: input.pending.get(environmentId)?.sessions.has(summary.id) === true,
        awaitingReceipt: input.awaiting.get(environmentId)?.sessions.has(summary.id) === true,
      });
    }
  }

  const nows = new Map(enabled.map(({ environmentId }) => [environmentId, input.now(environmentId)]));
  const shelves = new Map(rows.map((row) => [row, shelfOf(row.summary, nows.get(row.environmentId) as Date)]));
  const shelf = (row: SessionRow) => shelves.get(row) as Shelf;

  // One pass puts each row under its heading and its repository; the shelves then sort each bucket.
  const repositories = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const { groupId, repositoryIdentity } = row.summary;
    const key = groupId === null ? undefined : headingOf.get(`${row.environmentId} ${groupId}`);
    if (key !== undefined) headings.get(key)?.rows.push(row);
    if (repositoryIdentity !== null) {
      const bucket = repositories.get(repositoryIdentity);
      if (bucket) bucket.push(row);
      else repositories.set(repositoryIdentity, [row]);
    }
  }

  // The primary environment's headings in its group order, then the rest by key: one rule, whatever the connection order of the others.
  const placed = [...headings].sort(([keyA, a], [keyB, b]) => {
    if (a.place !== null || b.place !== null) return a.place === null ? 1 : b.place === null ? -1 : a.place - b.place;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  return {
    environments: enabled.map(({ environmentId }) => {
      const state = input.lists.get(environmentId) ?? emptyStream<ListData>();
      return { environmentId, freshness: state.freshness, fault: state.fault };
    }),
    rows,
    ...shelvesOf(rows, order, shelf),
    groups: placed.map(([key, heading]) => ({
      key,
      name: heading.name,
      groups: heading.members,
      shelves: shelvesOf(heading.rows, order, shelf),
      pending: heading.members.some((member) => input.pending.get(member.environmentId)?.groups.has(member.groupId) === true),
      awaitingReceipt: heading.members.some((member) => input.awaiting.get(member.environmentId)?.groups.has(member.groupId) === true),
    })),
    repositories: [...repositories.keys()].sort().map((repositoryIdentity) => ({
      repositoryIdentity,
      shelves: shelvesOf(repositories.get(repositoryIdentity) as SessionRow[], order, shelf),
    })),
  };
};

/** When the next snoozed session wakes, in milliseconds from now on its environment's clock; null when none is snoozed. */
const nextWake = (view: SessionListView, now: (environmentId: string) => Date): number | null => {
  let soonest: number | null = null;
  for (const row of view.snoozed) {
    const due = Date.parse(row.summary.snoozedUntil as string) - now(row.environmentId).getTime();
    if (soonest === null || due < soonest) soonest = due;
  }
  return soonest;
};

export interface SessionListProjection {
  readonly view: Observable<SessionListView>;
  /** Cancels the wake timer: the runtime closed. */
  stop(): void;
}

export const sessionListProjection = (options: {
  readonly records: Observable<readonly ConnectionRecord[]>;
  readonly lists: Observable<ReadonlyMap<string, StreamState<ListData>>>;
  readonly now: (environmentId: string) => Date;
  readonly clock: Clock;
  readonly pending: Observable<CommandTargets>;
  readonly awaiting: Observable<CommandTargets>;
}): SessionListProjection => {
  const wakes = writable(0);
  let wake: Timer | undefined;
  const view = derived([options.records, options.lists, options.pending, options.awaiting, wakes] as const, (records, lists, pending, awaiting) => {
    const value = sessionListView({ records, lists, now: options.now, pending, awaiting });
    wake?.cancel();
    wake = undefined;
    const due = nextWake(value, options.now);
    // A snooze is over at its instant (`shelfOf` holds it only while it is after now). A timer cannot wait longer than
    // `MAX_TIMER_MS` (past it a real `setTimeout` fires at once, over and over), so a snooze further off wakes the list early
    // to look again.
    if (due !== null) wake = options.clock.setTimeout(() => wakes.update((n) => n + 1), Math.min(MAX_TIMER_MS, Math.max(0, due)));
    return value;
  });
  return {
    view,
    stop() {
      wake?.cancel();
      wake = undefined;
    },
  };
};
