import {
  EnvironmentNotice,
  EnvironmentStatus,
  EventEnvelope,
  GROUP_STREAM_KIND,
  Group,
  GroupPatch,
  LIST_PATCH_KEY,
  SESSION_STREAM_KIND,
  SessionListSnapshot,
  SessionSnapshot,
  SessionSummary,
  SummaryPatch,
  registry,
} from "@agent-harness/contracts";
import { utf8Length } from "./cache.js";
import type { StreamKind } from "./stream.js";

/**
 * The three kinds of stream the runtime subscribes (docs/specs/client-runtime.md,
 * "Subscriptions, cursor cache and snapshots"), each a `StreamKind`: the
 * session list (`sessions.subscribe`), one session (`sessions.subscribeSession`)
 * and the environment's own notices (`environment.subscribe`). The list and
 * a session apply the summary patch a `list`-flagged event carries in its
 * metadata and never read a payload (session-state spec, "The list stream
 * and the summary patch"); an event with no patch changes nothing listed.
 */

/** The session list: every summary and every group of one environment, by id. */
export interface ListData {
  readonly sessions: ReadonlyMap<string, SessionSummary>;
  readonly groups: ReadonlyMap<string, Group>;
}

/**
 * What a session's snapshot holds beside its summary, as the environment
 * sends it (`SessionSnapshot`, the claude-adapter spec's): its runs, the
 * settled items of its transcript (an item of a kind this client does not
 * know kept opaque) and its parked prompts. Held and cached as sent;
 * `projections.session` (#142) folds them with the events after them.
 */
export type SessionSnapshotParts = Pick<SessionSnapshot, "runs" | "items" | "parkedPrompts">;

const NO_SNAPSHOT_PARTS: SessionSnapshotParts = { runs: [], items: [], parkedPrompts: [] };
const SnapshotParts = SessionSnapshot.pick({ runs: true, items: true, parkedPrompts: true });

/** One session: its summary (null once it is gone), the rest of its snapshot as sent, and every event after that snapshot. */
export interface SessionData {
  readonly summary: SessionSummary | null;
  readonly snapshot: SessionSnapshotParts;
  /** The events since the snapshot, in order, unknown types included: `projections.session` folds them. */
  readonly events: readonly EventEnvelope[];
  /** What `events` take as UTF-8 JSON, counted as they come; not stored. */
  readonly eventBytes: number;
}

/**
 * The most events a held session keeps since its snapshot, and the most
 * bytes they may take, before it is resubscribed for a snapshot that folds
 * them: without a bound a session held open appends every event forever,
 * in memory and in its cache document. Chosen defaults.
 */
export const SESSION_EVENTS_BOUND = 1000;
export const SESSION_EVENT_BYTES_BOUND = 1024 * 1024;

const sizeOf = (events: readonly EventEnvelope[]): number => events.reduce((sum, event) => sum + utf8Length(JSON.stringify(event)), 0);

/** The environment's own stream: its status as the snapshot gave it and the notices since changed it. */
export interface EnvironmentData {
  readonly status: EnvironmentStatus | null;
}

/** The fields of a stored or sent object; throws on anything else. */
const fieldsOf = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${what} is not an object.`);
  return value as Record<string, unknown>;
};

const EnvironmentSnapshot = registry["environment.subscribe"].result;

const byId = <T extends { readonly id: string }>(items: readonly T[]): ReadonlyMap<string, T> => new Map(items.map((item) => [item.id, item]));

const summaryPatchOf = (event: EventEnvelope): SummaryPatch | undefined => {
  const raw = event.metadata[LIST_PATCH_KEY];
  return raw === undefined ? undefined : SummaryPatch.parse(raw);
};

/** `summary` with `patch`'s set applied; a set for a session not held cannot be applied. */
const patched = (summary: SessionSummary | undefined, patch: Extract<SummaryPatch, { op: "set" }>): SessionSummary => {
  if (!summary) throw new Error(`Session ${patch.sessionId} is not in the list.`);
  return { ...summary, ...patch.fields } as SessionSummary;
};

export const listKind = (): StreamKind<ListData> => ({
  empty: () => ({ sessions: new Map(), groups: new Map() }),
  emptyIsState: true,
  fromSnapshot(payload) {
    const snapshot = SessionListSnapshot.parse(payload);
    return { sessions: byId(snapshot.sessions), groups: byId(snapshot.groups) };
  },
  apply(data, event) {
    const raw = event.metadata[LIST_PATCH_KEY];
    if (raw === undefined) return data;
    if (event.streamKind === GROUP_STREAM_KIND) {
      const patch = GroupPatch.parse(raw);
      const next = new Map(data.groups);
      if (patch.op === "add") next.set(patch.group.id, patch.group);
      else if (patch.op === "remove") next.delete(patch.groupId);
      else {
        const held = next.get(patch.groupId);
        if (!held) throw new Error(`Group ${patch.groupId} is not in the list.`);
        next.set(patch.groupId, { ...held, ...patch.fields } as Group);
      }
      return { ...data, groups: next };
    }
    if (event.streamKind !== SESSION_STREAM_KIND) return data;
    const patch = SummaryPatch.parse(raw);
    const next = new Map(data.sessions);
    if (patch.op === "add") next.set(patch.summary.id, patch.summary);
    else if (patch.op === "remove") next.delete(patch.sessionId);
    else next.set(patch.sessionId, patched(next.get(patch.sessionId), patch));
    return { ...data, sessions: next };
  },
  encode: (data) => ({ sessions: [...data.sessions.values()], groups: [...data.groups.values()] }),
  decode(value) {
    const stored = fieldsOf(value, "The stored list");
    return { sessions: byId(SessionSummary.array().parse(stored["sessions"])), groups: byId(Group.array().parse(stored["groups"])) };
  },
});

export const sessionKind = (): StreamKind<SessionData> => ({
  empty: () => ({ summary: null, snapshot: NO_SNAPSHOT_PARTS, events: [], eventBytes: 0 }),
  // Nothing sent is no session yet, not one that is gone.
  emptyIsState: false,
  outgrown: (data) => data.events.length > SESSION_EVENTS_BOUND || data.eventBytes > SESSION_EVENT_BYTES_BOUND,
  fromSnapshot(payload) {
    const { summary, runs, items, parkedPrompts } = SessionSnapshot.parse(payload);
    return { summary, snapshot: { runs, items, parkedPrompts }, events: [], eventBytes: 0 };
  },
  apply(data, event) {
    const patch = summaryPatchOf(event);
    let summary = data.summary;
    if (patch?.op === "add") summary = patch.summary;
    else if (patch?.op === "remove") summary = null;
    else if (patch?.op === "set") summary = patched(summary ?? undefined, patch);
    return { summary, snapshot: data.snapshot, events: [...data.events, event], eventBytes: data.eventBytes + sizeOf([event]) };
  },
  encode: (data) => ({ summary: data.summary, snapshot: data.snapshot, events: data.events }),
  decode(value) {
    const stored = fieldsOf(value, "The stored session");
    const events = EventEnvelope.array().parse(stored["events"]);
    return {
      summary: SessionSummary.nullable().parse(stored["summary"]),
      // A document from before #119 (a `transcript` field, no `snapshot`) does not read: no cache, so the session subscribes from nothing.
      snapshot: SnapshotParts.parse(stored["snapshot"]),
      events,
      eventBytes: sizeOf(events),
    };
  },
});

/**
 * The environment's own stream. Its notices are read here, and name, icon
 * and colour would be too: they come from the environment, never the client
 * (ADR 0005), from `environment.status` and an environment-updated notice.
 * As built neither carries them: the notices are `environment.started`,
 * `environment.updated` (harness versions), `environment.draining`,
 * `account.updated` (the account store, #134) and `usage.updated` (plan
 * usage, #136), and
 * the status is readiness, activity and `updatesManagedOutside`; so the name
 * comes from discovery and `hello`, and icon and colour stay null until the
 * workspace-picker workstream adds the notice this `apply` then reads.
 *
 * The status follows the notices: `environment.draining` makes it draining,
 * and `environment.started` (the restart after a drain, or any start) makes
 * it ready and idle, since a process that has just started runs nothing.
 */
export const environmentKind = (): StreamKind<EnvironmentData> => ({
  empty: () => ({ status: null }),
  emptyIsState: true,
  fromSnapshot: (payload) => ({ status: EnvironmentSnapshot.parse(payload).status }),
  apply(data, event) {
    // A notice this client does not know (a newer environment's) changes nothing it holds.
    const notice = EnvironmentNotice.safeParse(event);
    if (!notice.success || data.status === null) return data;
    switch (notice.data.type) {
      case "environment.draining":
        return { status: { ...data.status, readiness: "draining", activity: { state: "draining", drainingSince: notice.data.payload.drainingSince } } };
      case "environment.started":
        return { status: { ...data.status, readiness: "ready", activity: { state: "idle" } } };
      // A new version, an account changed (#134) or its plan usage (#136): the status holds none; a request cache refreshes on the last two.
      case "environment.updated":
      case "account.updated":
      case "usage.updated":
        return data;
    }
  },
  encode: (data) => data,
  decode: (value) => ({ status: EnvironmentStatus.nullable().parse(fieldsOf(value, "The stored environment")["status"]) }),
});
