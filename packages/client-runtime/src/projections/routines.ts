import { ROUTINE_HISTORY_LIMIT, registry, type EnvironmentColour, type EnvironmentIcon, type ListedRoutine, type ParamsOf, type RoutineEntry } from "@agent-harness/contracts";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "../connections/records.js";
import { derived, dynamic, writable, type Observable } from "../observable.js";
import type { OutboxEntry } from "../outbox/entries.js";
import { reachable, type OutboxView } from "../outbox/overlay.js";
import { routineOf } from "../outbox/rules.js";
import type { CachedAnswer, RequestAnswer, RequestFailure } from "../requests.js";

/**
 * `projections.routines` (docs/specs/routines.md, "Clients"; #532): every
 * enabled environment's routines, from its `routines.list` in the request
 * cache, so each list is fetched while followed, kept five minutes, and
 * fetched again on every ready, on `routine.updated`, and on what a
 * listing's mode and attention are read from changing: an account, the
 * skill set, an endpoint, the settings (`QUERY_REFRESH_NOTICES`). Grouped by environment in the connection
 * list's order, each group carrying the environment's name, icon and colour
 * as the runtime's descriptor holds them; an environment that cannot be
 * reached keeps the list last fetched, marked stale with when it was.
 *
 * The routine commands at `sessions:write` go through the outbox (ADR 0008),
 * which queues them while their environment cannot be reached. A routine a
 * waiting command names is flagged pending while it cannot, as a session
 * row is; and a create waiting in the outbox shows its routine from the
 * definition it sent, its listing (state, next due time, mode, attention)
 * still to come from the environment.
 *
 * `projections.routineHistory` reads a routine's `routines.history`: its
 * newest page from the request cache, fetched again with the list, and each
 * older page on demand, by `before`.
 */

/** A routine's definition as a create sent it: what has a preset filled in, and no zone when the environment's own is to be its zone. */
export type SentDefinition = ParamsOf<"routines.create">["definition"];

/** One routine as the list shows it. */
export interface RoutineRow {
  readonly environmentId: string;
  readonly routineId: string;
  /** Its definition: as the environment listed it, or as the create still waiting in the outbox sent it. */
  readonly definition: SentDefinition;
  /** The routine as the environment listed it, with its state, next due time, effective mode and attention; null for a create still waiting in the outbox. */
  readonly listed: ListedRoutine | null;
  /** A routine command about it waits in the outbox while the environment cannot be reached. */
  readonly pending: boolean;
}

/** One environment's routines. */
export interface RoutineGroup {
  readonly environmentId: string;
  /** The environment's name, icon and colour, as the runtime's descriptor holds them. */
  readonly name: string;
  readonly icon: EnvironmentIcon | null;
  readonly colour: EnvironmentColour | null;
  /** The routines the environment listed, in its order, then the creates waiting in the outbox it does not list yet, in the order they were dispatched. */
  readonly routines: readonly RoutineRow[];
  /** When the list shown was fetched, on this client's clock; null until one was. */
  readonly fetchedAt: string | null;
  /** The environment cannot be reached now, so the list shown is the one last fetched (`fetchedAt`). */
  readonly stale: boolean;
  /** Why the last fetch failed, the list last fetched kept beside it; null when it did not. */
  readonly error: RequestFailure | null;
  readonly loading: boolean;
}

export interface RoutinesView {
  /** Each enabled environment's routines, in the connection list's order. */
  readonly groups: readonly RoutineGroup[];
  /** How many routines need attention, across every environment shown. */
  readonly attention: number;
}

export interface RoutinesHost {
  /** The connection list: the environments, their order, whether each is enabled and can be reached, and their descriptors. */
  readonly records: Observable<readonly ConnectionRecord[]>;
  readonly outbox: Observable<OutboxView>;
  /** The request cache's `routines.list` for the environment: the same observable for each. */
  readonly source: (environmentId: string) => Observable<CachedAnswer<"routines.list">>;
}

/** What waits in an environment's outbox about its routines: the routines its commands name, and its creates in the order dispatched. */
interface WaitingRoutines {
  readonly named: ReadonlySet<string>;
  readonly creates: readonly OutboxEntry[];
}

type WaitingByEnvironment = ReadonlyMap<string, WaitingRoutines>;

/** The routine commands at `sessions:write` waiting in each outbox; an environment with none is left out. */
const waitingRoutinesOf = (outbox: OutboxView): WaitingByEnvironment => {
  const waiting = new Map<string, WaitingRoutines>();
  for (const [environmentId, { entries }] of outbox) {
    const named = new Set<string>();
    const creates: OutboxEntry[] = [];
    for (const entry of entries) {
      const routineId = routineOf(entry.method, entry.params);
      if (registry[entry.method].scope !== "sessions:write" || routineId === null) continue;
      named.add(routineId);
      if (entry.method === "routines.create") creates.push(entry);
    }
    if (named.size > 0) waiting.set(environmentId, { named, creates });
  }
  return waiting;
};

const sameWaiting = (a: WaitingByEnvironment, b: WaitingByEnvironment): boolean =>
  a.size === b.size &&
  [...a].every(([environmentId, held]) => {
    const other = b.get(environmentId);
    return (
      other !== undefined &&
      held.named.size === other.named.size &&
      [...held.named].every((id) => other.named.has(id)) &&
      held.creates.length === other.creates.length &&
      held.creates.every((entry, i) => entry.commandId === other.creates[i]?.commandId)
    );
  });

/** The waiting routine commands, the same value while they name the same routines and creates: an entry sent or its attempt counted changes nothing shown. */
const keepingSameWaiting = () => {
  let last: WaitingByEnvironment | undefined;
  return (outbox: OutboxView): WaitingByEnvironment => {
    const next = waitingRoutinesOf(outbox);
    if (last === undefined || !sameWaiting(last, next)) last = next;
    return last;
  };
};

const NOTHING_WAITS: WaitingRoutines = { named: new Set(), creates: [] };

const groupOf = (record: ConnectionRecord, answer: CachedAnswer<"routines.list">, waiting: WaitingRoutines): RoutineGroup => {
  const { environmentId } = record;
  const unreachable = !reachable(record);
  const row = (routineId: string, definition: SentDefinition, listed: ListedRoutine | null): RoutineRow => ({
    environmentId,
    routineId,
    definition,
    listed,
    pending: unreachable && waiting.named.has(routineId.toLowerCase()),
  });
  const listed = (answer.result?.routines ?? []).map((routine) => row(routine.state.id, routine.definition, routine));
  const held = new Set(listed.map(({ routineId }) => routineId.toLowerCase()));
  // A create the environment lists already is its listing's; one under an id another create waiting took is refused there.
  const created = waiting.creates.flatMap((entry) => {
    const { routineId, definition } = entry.params as ParamsOf<"routines.create">;
    if (held.has(routineId.toLowerCase())) return [];
    held.add(routineId.toLowerCase());
    return [row(routineId, definition, null)];
  });
  return {
    environmentId,
    name: record.descriptor.name,
    icon: record.descriptor.icon,
    colour: record.descriptor.colour,
    routines: [...listed, ...created],
    fetchedAt: answer.fetchedAt,
    stale: unreachable && answer.fetchedAt !== null,
    error: answer.error,
    loading: answer.loading,
  };
};

/** `projections.routines`: every enabled environment's routines, each list followed while the view is. */
export const routinesProjection = (host: RoutinesHost): Observable<RoutinesView> => {
  const enabled = derived([host.records] as const, (records) => records.filter((record) => record.enabled && record.environmentId !== LOCAL_PLACEHOLDER_ID));
  const waiting = derived([host.outbox] as const, keepingSameWaiting());
  return dynamic(
    () => [enabled, waiting, ...enabled.read().map((record) => host.source(record.environmentId))],
    (): RoutinesView => {
      const groups = enabled.read().map((record) => groupOf(record, host.source(record.environmentId).read(), waiting.read().get(record.environmentId) ?? NOTHING_WAITS));
      return { groups, attention: groups.reduce((count, group) => count + group.routines.filter((row) => (row.listed?.attention.length ?? 0) > 0).length, 0) };
    },
  );
};

/** A routine's history as read so far. */
export interface RoutineHistoryView {
  readonly environmentId: string;
  readonly routineId: string;
  /** Its firings and skips, newest first: the newest page, then each older page read, in order. */
  readonly entries: readonly RoutineEntry[];
  /** Every entry is read: the last page came short. */
  readonly complete: boolean;
  /** When the newest page shown was fetched, on this client's clock; null until one was. */
  readonly fetchedAt: string | null;
  /** Why the last read of a page failed, what was read kept beside it; null when it did not. */
  readonly error: RequestFailure | null;
  /** A page is being read. */
  readonly loading: boolean;
}

export interface RoutineHistory extends Observable<RoutineHistoryView> {
  /**
   * Reads the page before the oldest entry held (`before`, the
   * environment's page of 50) and settles once it is in; nothing while one
   * is being read, before the newest page came, or once every entry is.
   */
  more(): Promise<void>;
}

export interface RoutineHistoryHost {
  /** The request cache's newest page of the routine's history: fetched while followed, on every ready and on `routine.updated`. */
  readonly newest: Observable<CachedAnswer<"routines.history">>;
  /** The page of entries recorded before `before`, read directly: an older page changes only with a delivery's retries, so it is read once. */
  readonly page: (before: string) => Promise<RequestAnswer<"routines.history">>;
}

const NO_ENTRIES: readonly RoutineEntry[] = [];

/**
 * `projections.routineHistory(environmentId, routineId)`. The older pages
 * hang below the newest: when it is fetched again with new entries on top,
 * those it no longer reaches stay shown below it, the older pages after
 * them, so nothing read goes missing; a newest page that no longer reaches
 * anything shown (more new entries than a page holds) starts the older
 * pages again.
 */
export const routineHistoryProjection = (host: RoutineHistoryHost, environmentId: string, routineId: string): RoutineHistory => {
  /** The newest page the older entries were read below, and those entries, oldest last. */
  let base: readonly RoutineEntry[] = NO_ENTRIES;
  let older: readonly RoutineEntry[] = NO_ENTRIES;
  /** The last older page came short: there is nothing before `older`. */
  let olderComplete = false;
  let reading: Promise<void> | null = null;
  let failure: RequestFailure | null = null;
  /** Moves whenever an older page is asked for or comes in, so the view recomputes. */
  const version = writable(0);

  /** Takes `newest` as the page the older entries hang below: those shown below its last entry stay. */
  const rebase = (newest: readonly RoutineEntry[]) => {
    if (newest === base) return;
    const shown = [...base, ...older];
    const last = newest.at(-1);
    const at = newest.length < ROUTINE_HISTORY_LIMIT || last === undefined ? -1 : shown.findIndex((entry) => entry.id === last.id);
    older = at < 0 ? NO_ENTRIES : shown.slice(at + 1);
    if (at < 0) olderComplete = false;
    base = newest;
  };

  const view = derived([host.newest, version] as const, (answer): RoutineHistoryView => {
    const newest = answer.result?.entries ?? NO_ENTRIES;
    rebase(newest);
    return {
      environmentId,
      routineId,
      entries: older.length === 0 ? newest : [...newest, ...older],
      complete: answer.result !== null && (newest.length < ROUTINE_HISTORY_LIMIT || olderComplete),
      fetchedAt: answer.fetchedAt,
      error: answer.error ?? failure,
      loading: answer.loading || reading !== null,
    };
  });

  const more = (): Promise<void> => {
    if (reading !== null) return reading;
    const { entries, complete } = view.read();
    const oldest = entries.at(-1);
    if (complete || oldest === undefined) return Promise.resolve();
    reading = host.page(oldest.id).then((answer) => {
      reading = null;
      if (!answer.ok) failure = answer.error;
      // Kept only where it still hangs: below the oldest entry shown, the one it was read before.
      else if ((older.at(-1) ?? base.at(-1))?.id === oldest.id) {
        older = [...older, ...answer.result.entries];
        olderComplete = answer.result.entries.length < ROUTINE_HISTORY_LIMIT;
        failure = null;
      }
      version.update((n) => n + 1);
    });
    version.update((n) => n + 1);
    return reading;
  };

  return { read: view.read, subscribe: view.subscribe, more };
};
