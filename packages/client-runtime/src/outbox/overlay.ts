import { registry, type Group, type SessionSummary } from "@agent-harness/contracts";
import type { ConnectionRecord } from "../connections/records.js";
import type { ListData } from "../streams/kinds.js";
import type { StreamState } from "../streams/stream.js";
import type { OutboxEntry } from "./entries.js";
import type { OverlayChange } from "./rules.js";

/**
 * The optimistic overlay (docs/specs/client-runtime.md, "Optimistic
 * application"): per command id, the change the command will make, laid
 * over the session list the environment confirmed, in the order the
 * commands were dispatched. A projection reads the list through it; the
 * confirmed list, and its cache, are written by events and snapshots alone
 * (session-state spec, "Sync semantics").
 *
 * An overlay leaves when an event carrying its command id applies, when the
 * list's cursor reaches the sequence its receipt names, or when its command
 * is rejected, dropped or replaced; an applied change to a session's fields
 * waits for the session's own stream's cursor too while the runtime holds
 * that stream live, since the session's projection reads it (#1767). Until then it holds its fields whatever
 * the confirmed list says: a live event from another client changing the
 * same field does not displace it, since this command lands later by
 * sequence and wins there (last writer wins per field, no merge; ADR 0003).
 */

export interface OverlayRecord {
  readonly commandId: string;
  readonly change: OverlayChange;
  /** The sequence the command's accepted receipt names; null until it comes. */
  readonly sequence: number | null;
}

/** One environment's outbox: its entries still to be answered, in order, and the overlays still shown, in dispatch order. */
export interface EnvironmentOutbox {
  readonly entries: readonly OutboxEntry[];
  readonly overlays: readonly OverlayRecord[];
}

export type OutboxView = ReadonlyMap<string, EnvironmentOutbox>;

/** The drafts typed and not yet dispatched (their second's debounce under way), by environment, then session. */
export type WaitingDrafts = ReadonlyMap<string, ReadonlyMap<string, string | null>>;

/** The sessions and groups queued or in-flight commands are about, by environment. */
export type CommandTargets = ReadonlyMap<string, { readonly sessions: ReadonlySet<string>; readonly groups: ReadonlySet<string> }>;

/** `data` with `overlays` laid over it in order, then the drafts waiting on top. */
export const overlaid = (data: ListData, overlays: readonly OverlayRecord[], drafts: ReadonlyMap<string, string | null> | undefined): ListData => {
  const sessions = new Map<string, SessionSummary>(data.sessions);
  const groups = new Map<string, Group>(data.groups);
  const gone = new Set<string>();
  for (const { change } of overlays) {
    const { id } = change.target;
    if (change.target.kind === "group") {
      if (change.op === "add") {
        if (!groups.has(id)) groups.set(id, change.group);
      } else if (change.op === "hide") {
        if (groups.delete(id)) gone.add(id);
      } else {
        const group = groups.get(id);
        if (group) groups.set(id, { ...group, ...change.fields } as Group);
      }
      continue;
    }
    if (change.op === "hide") sessions.delete(id);
    else if (change.op === "set") {
      const session = sessions.get(id);
      if (session) sessions.set(id, { ...session, ...change.fields } as SessionSummary);
    }
  }
  for (const [id, draft] of drafts ?? []) {
    const session = sessions.get(id);
    if (session) sessions.set(id, { ...session, draft: draft === "" ? null : draft });
  }
  // A group deleted here ungroups its members, as the environment will in the same transaction.
  if (gone.size > 0) {
    for (const [id, session] of sessions) if (session.groupId !== null && gone.has(session.groupId)) sessions.set(id, { ...session, groupId: null });
  }
  return { sessions, groups };
};

/** Each environment's list with its overlays and waiting drafts laid over it; a list with neither is the same object. */
export const overlaidLists = (
  lists: ReadonlyMap<string, StreamState<ListData>>,
  outbox: OutboxView,
  drafts: WaitingDrafts,
): ReadonlyMap<string, StreamState<ListData>> => {
  let changed: Map<string, StreamState<ListData>> | undefined;
  for (const [environmentId, state] of lists) {
    const overlays = outbox.get(environmentId)?.overlays ?? [];
    const waiting = drafts.get(environmentId);
    if (state.data === null || (overlays.length === 0 && (waiting === undefined || waiting.size === 0))) continue;
    changed ??= new Map(lists);
    changed.set(environmentId, { ...state, data: overlaid(state.data, overlays, waiting) });
  }
  return changed ?? lists;
};

/** Whether the connection has a ready socket: `syncing` is ready, catching its list up. */
export const reachable = (record: ConnectionRecord | undefined): boolean => record?.phase === "ready" || record?.phase === "syncing";

/**
 * The sessions and groups each environment's `sessions:write` entries are
 * about, of the environments `include` admits. A `runs:drive` command
 * changes nothing the list shows (it has no overlay), so it marks no row
 * (docs/specs/client-runtime.md, "Which commands queue"). An environment
 * with no such entry is left out.
 */
const targetsOf = (outbox: OutboxView, include: (environmentId: string) => boolean): CommandTargets => {
  const targets = new Map<string, { sessions: Set<string>; groups: Set<string> }>();
  for (const [environmentId, { entries }] of outbox) {
    if (!include(environmentId)) continue;
    const about = { sessions: new Set<string>(), groups: new Set<string>() };
    for (const { method, target } of entries) {
      if (registry[method].scope !== "sessions:write") continue;
      if (target?.kind === "session") about.sessions.add(target.id);
      else if (target?.kind === "group") about.groups.add(target.id);
    }
    if (about.sessions.size > 0 || about.groups.size > 0) targets.set(environmentId, about);
  }
  return targets;
};

/**
 * The sessions and groups a queued or in-flight `sessions:write` command is
 * about, whatever the connection's phase: what carries `awaitingReceipt`. An
 * entry leaves the outbox on its receipt, accepted or rejected, or when it
 * is dropped, and the flag with it.
 */
export const awaitedTargets = (outbox: OutboxView): CommandTargets => targetsOf(outbox, () => true);

/** The sessions and groups with a command waiting on an environment that cannot be reached: what carries `pending`. */
export const pendingTargets = (records: readonly ConnectionRecord[], outbox: OutboxView): CommandTargets =>
  targetsOf(outbox, (environmentId) => !reachable(records.find((record) => record.environmentId === environmentId)));

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((id) => b.has(id));

const sameTargets = (a: CommandTargets, b: CommandTargets): boolean =>
  a.size === b.size &&
  [...a].every(([environmentId, about]) => {
    const other = b.get(environmentId);
    return other !== undefined && sameSet(about.sessions, other.sessions) && sameSet(about.groups, other.groups);
  });

/**
 * `compute` answering the targets it answered last while the new ones name
 * the same sessions and groups, so an observable derived through it changes
 * only when the set does, not on each outbox change (an entry sent, an
 * attempt counted, an overlay settled).
 */
export const keepingSameTargets = <A extends unknown[]>(compute: (...args: A) => CommandTargets): ((...args: A) => CommandTargets) => {
  let last: CommandTargets | undefined;
  return (...args) => {
    const next = compute(...args);
    if (last === undefined || !sameTargets(last, next)) last = next;
    return last;
  };
};
