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
  StandingRewind,
  StepResult,
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
 * know kept opaque), its parked prompts and the rewinds standing with what
 * each hid (#260). Held and cached as sent; `projections.session` (#142)
 * folds them with the events after them. A cache document from before #260
 * holds no rewinds, does not read, and is no cache.
 */
export type SessionSnapshotParts = Pick<SessionSnapshot, "runs" | "items" | "parkedPrompts" | "rewinds">;

const NO_SNAPSHOT_PARTS: SessionSnapshotParts = { runs: [], items: [], parkedPrompts: [], rewinds: [] };
/**
 * The snapshot parts as a cache document holds them: `rewinds` required, where
 * the wire defaults it to none for an environment from before #260. A
 * document this runtime wrote always has them; one from before #260 has
 * none, and reading it as none standing would hide a fold the environment
 * holds until the next fresh snapshot, so it does not read.
 */
const StoredSnapshotParts = SessionSnapshot.pick({ runs: true, items: true, parkedPrompts: true }).extend({ rewinds: StandingRewind.array() });

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

/** The sequences of `rewinds` and of every rewind nested in them. */
const rewindSequences = (rewinds: SessionSnapshotParts["rewinds"], into = new Set<number>()): Set<number> => {
  for (const rewind of rewinds) {
    into.add(rewind.sequence);
    rewindSequences(rewind.rewinds, into);
  }
  return into;
};

/**
 * Whether an undo among `events` names a rewind neither they nor `snapshot`
 * hold (#218): then nothing here holds what it hid, and a fresh snapshot,
 * folded past the undo, shows it. Since #260 a snapshot carries every rewind
 * standing with what it hid, so an environment should never send such an
 * undo; the resubscribe is kept as the fallback if one arrives anyway.
 */
export const undoesUnheardRewind = (snapshot: Pick<SessionSnapshotParts, "rewinds">, events: readonly EventEnvelope[]): boolean => {
  const heard = rewindSequences(snapshot.rewinds);
  for (const event of events) {
    if (event.type === "session.rewound") heard.add(event.sequence);
    else if (event.type === "session.rewind-undone" && !heard.has((event.payload as { rewindSequence?: unknown }).rewindSequence as number)) return true;
  }
  return false;
};

const sizeOf = (events: readonly EventEnvelope[]): number => events.reduce((sum, event) => sum + utf8Length(JSON.stringify(event)), 0);

/**
 * The environment's own stream: its status as the snapshot gave it and the
 * notices since changed it, and each Set up step's latest result, from the
 * snapshot's `setup` and each `setup.result-changed` since (#570): what
 * `projections.setup` reads, offline too.
 */
export interface EnvironmentData {
  readonly status: EnvironmentStatus | null;
  /** None from an environment without the `setup` flag, or before it checked anything. */
  readonly setup: readonly StepResult[];
}

/** The fields of a stored or sent object; throws on anything else. */
const fieldsOf = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${what} is not an object.`);
  return value as Record<string, unknown>;
};

const EnvironmentSnapshot = registry["environment.subscribe"].result;
/** The snapshot but its `setup`, whose results are read one by one (`readResults`). */
const SnapshotStatus = EnvironmentSnapshot.pick({ status: true });

/**
 * The results a snapshot's `setup` carries that this build can read: one of
 * a step this build does not register (a newer environment's) is left out,
 * as a notice this client does not know is, and the others still read.
 */
const readResults = (value: unknown): StepResult[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("The snapshot's setup is not a list.");
  return value.flatMap((item) => {
    const result = StepResult.safeParse(item);
    return result.success ? [result.data] : [];
  });
};

/** `results` with `result` in place of its step's, or added when its step had none. */
const withResult = (results: readonly StepResult[], result: StepResult): StepResult[] =>
  results.some((held) => held.step === result.step) ? results.map((held) => (held.step === result.step ? result : held)) : [...results, result];

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
  // Past the bound, or holding an undo of a rewind nothing held says what it hid (#218): a fresh snapshot folds either.
  outgrown: (data) => data.events.length > SESSION_EVENTS_BOUND || data.eventBytes > SESSION_EVENT_BYTES_BOUND || undoesUnheardRewind(data.snapshot, data.events),
  fromSnapshot(payload) {
    const { summary, runs, items, parkedPrompts, rewinds } = SessionSnapshot.parse(payload);
    return { summary, snapshot: { runs, items, parkedPrompts, rewinds }, events: [], eventBytes: 0 };
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
      // A document from before #119 (a `transcript` field, no `snapshot`), or from before #260 (no `rewinds`), does not read: no cache, so the
      // session subscribes from nothing.
      snapshot: StoredSnapshotParts.parse(stored["snapshot"]),
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
 * `environment.updated` (harness versions), `environment.draining`, an
 * update's pending, started, failed and cancelled (#335),
 * `account.updated` (the account store, #134), `signin.updated` and
 * `signin.executable-chosen` (the sign-in director, #135), `prompt.parked`
 * and `prompt.resolved` (the permission broker, #130), `usage.updated` (plan
 * usage, #136), `settings.changed` (#391), `setup.result-changed` (#569), and
 * the status is readiness, activity and `updatesManagedOutside`; so the name
 * comes from discovery and `hello`, and icon and colour stay null until the
 * workspace-picker workstream adds the notice this `apply` then reads.
 *
 * The status follows the notices: `environment.draining` makes it draining,
 * and `environment.started` (the restart after a drain, or any start) makes
 * it ready and idle, since a process that has just started runs nothing.
 * Each `setup.result-changed` replaces its step's result (#570).
 */
export const environmentKind = (): StreamKind<EnvironmentData> => ({
  empty: () => ({ status: null, setup: [] }),
  emptyIsState: true,
  fromSnapshot: (payload) => ({ status: SnapshotStatus.parse(payload).status, setup: readResults(payload["setup"]) }),
  apply(data, event) {
    // A notice this client does not know (a newer environment's) changes nothing it holds.
    const notice = EnvironmentNotice.safeParse(event);
    if (!notice.success) return data;
    // A step's result replaces the one held, whether or not a snapshot gave the status: a replay from the cursor carries no
    // snapshot, and folds every result the environment noticed (#570).
    if (notice.data.type === "setup.result-changed") return { ...data, setup: withResult(data.setup, notice.data.payload) };
    if (data.status === null) return data;
    switch (notice.data.type) {
      case "environment.draining":
        return { ...data, status: { ...data.status, readiness: "draining", activity: { state: "draining", drainingSince: notice.data.payload.drainingSince } } };
      case "environment.started":
        return { ...data, status: { ...data.status, readiness: "ready", activity: { state: "idle" } } };
      // A new version, an account changed (#134), the sign-in moved (#135), or an account's plan usage (#136): the status
      // holds none of them. The request cache refreshes on all but `signin.executable-chosen` (`CACHE_REFRESH_NOTICES` and
      // `QUERY_REFRESH_NOTICES`, #142), and the notices queue says what is news.
      case "environment.updated":
      case "account.updated":
      case "signin.updated":
      case "signin.executable-chosen":
      case "usage.updated":
        return data;
      // An update's steps (#335): the status holds none of them, `updates.status` does (#342), and the notices queue says
      // what is news (#344). The drain an update began is `environment.draining`'s.
      case "environment.update-pending":
      case "environment.update-started":
      case "environment.update-failed":
      case "environment.update-cancelled":
        return data;
      // A prompt's notices change no status: the parked asks (`projections.runs`) and the notices queue read them (#142).
      case "prompt.parked":
      case "prompt.resolved":
        return data;
      // The forge's events (#310) change no status: the request cache refreshes `forge.accounts.list` on them, and the
      // notices queue raises the forge's rows (#320).
      case "forge.account.added":
      case "forge.account.updated":
      case "forge.account.primary-set":
      case "forge.account.verified":
      case "forge.account.capability-learned":
      case "forge.account.git-rejected":
      case "forge.account.removed":
      case "forge.origin-missing":
        return data;
      // The key-manager connections' events (#365, #366) and Move's (#371) change no status: the connections' cache and
      // notices are the key-managers workstream's client-runtime part (#384).
      case "key-manager.connection.added":
      case "key-manager.connection.signed-in":
      case "key-manager.connection.signed-out":
      case "key-manager.connection.updated":
      case "key-manager.connection.policies-set":
      case "key-manager.connection.base-path-set":
      case "key-manager.connection.verified":
      case "key-manager.connection.removed":
      case "key-manager.moved":
      case "key-manager.stored-value-deleted":
        return data;
      // The routines' notices (#519) change no status: the routines list refreshes on routine.updated (#532), and the
      // notices queue raises a delivered result and a failed delivery (#525, #529).
      case "routine.updated":
      case "routine.delivered":
      case "routine.delivery-failed":
      case "routine.endpoint-set":
      case "routine.endpoint-removed":
        return data;
      // A probe changing managed-tool rows (#373) changes no status: tools.list's cache is the key-managers workstream's
      // client-runtime part (#384).
      case "tools.updated":
        return data;
      // Settings changed (#391): the status holds none of them; the request cache fetches settings.get and
      // permissions.settings.get again (`QUERY_REFRESH_NOTICES`).
      case "settings.changed":
        return data;
      // The skill set changing (#494) changes no status: the request cache reads skills.get again.
      case "skills.updated":
        return data;
    }
  },
  encode: (data) => data,
  decode(value) {
    const stored = fieldsOf(value, "The stored environment");
    // A document from before #570 holds no results and does not read: no cache, so the stream subscribes from nothing and
    // hears every result the environment holds, where resuming from its cursor would miss those noticed before it.
    return { status: EnvironmentStatus.nullable().parse(stored["status"]), setup: StepResult.array().parse(stored["setup"]) };
  },
});
