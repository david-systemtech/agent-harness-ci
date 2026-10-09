import {
  EnvironmentLook,
  EnvironmentNotice,
  EnvironmentStatus,
  EventEnvelope,
  GROUP_STREAM_KIND,
  Group,
  GroupPatch,
  LIST_PATCH_KEY,
  SESSION_STREAM_KIND,
  SessionInstructions,
  SessionListSnapshot,
  SessionSnapshot,
  SessionSummary,
  StandingRewind,
  StepResult,
  StateImportFailure,
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
 * each hid (#260), and the session's own instructions (#506). Held and
 * cached as sent; `projections.session` (#142) folds them with the events
 * after them. A cache document from before #260 holds no rewinds, one from
 * before #506 no instructions: neither reads, and is no cache.
 */
export type SessionSnapshotParts = Pick<SessionSnapshot, "runs" | "items" | "parkedPrompts" | "rewinds" | "instructions" | "suggestion">;

const NO_SNAPSHOT_PARTS: SessionSnapshotParts = { runs: [], items: [], parkedPrompts: [], rewinds: [], instructions: "" };
/**
 * The snapshot parts as a cache document holds them: `rewinds` and
 * `instructions` required, where the wire defaults them to none for an
 * environment from before #260 and #506. A document this runtime wrote
 * always has them; one from before has none, and reading it as none would
 * hide a fold or the instructions the environment holds until the next fresh
 * snapshot, so it does not read.
 */
const StoredSnapshotParts = SessionSnapshot.pick({ runs: true, items: true, parkedPrompts: true, suggestion: true }).extend({ rewinds: StandingRewind.array(), instructions: SessionInstructions });

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
 * The environment's own stream: its status and look as the snapshot gave them
 * and the notices since changed them, and each Set up step's latest result,
 * from the snapshot's `setup` and each `setup.result-changed` since (#570):
 * what `projections.setup` reads, offline too; and the last completed import's
 * failed items, read by `projections.stateImportFailures` (#1935).
 */
export interface EnvironmentData {
  readonly status: EnvironmentStatus | null;
  /**
   * Its name, icon and colour as far as the stream has said them (#323): all
   * three from a snapshot of an environment that sends them, one field per
   * notice since. The connection descriptor follows them (`streams.ts`).
   */
  readonly look: Partial<EnvironmentLook>;
  /** None from an environment without the `setup` flag, or before it checked anything. */
  readonly setup: readonly StepResult[];
  /** The last completed import's failures, retained for every Carry over window (#1935). */
  readonly stateImportFailures: readonly StateImportFailure[];
}

/** The notices that set a field of the environment's look (#323). */
export const ENVIRONMENT_LOOK_NOTICES: ReadonlySet<string> = new Set(["environment.renamed", "environment.icon-set", "environment.colour-set"]);

/** A look as a cache document holds it: any of the three fields; a document from before #323 holds none. */
const StoredLook = EnvironmentLook.partial();

/** The fields of a stored or sent object; throws on anything else. */
const fieldsOf = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${what} is not an object.`);
  return value as Record<string, unknown>;
};

const EnvironmentSnapshot = registry["environment.subscribe"].result;
/** The snapshot but its `setup`, whose results are read one by one (`readResults`). */
const SnapshotStatus = EnvironmentSnapshot.pick({ status: true });
/** The snapshot's look (#323), read apart from its status, so a look this build cannot read costs the snapshot nothing else. */
const SnapshotLook = EnvironmentSnapshot.pick({ environment: true });

/**
 * The results a snapshot's `setup` carries that this build can read. One of
 * a step this build does not register reads, since a result names any step
 * of the milestone-1 order (#672), and one offering a verb or naming a kind
 * of item it does not know reads with that action or target left out
 * (#693); one this build cannot read even so (a step past that order, or
 * another shape) is left out, as a notice this client does not know is,
 * and the others still read.
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
    const { summary, runs, items, parkedPrompts, rewinds, instructions, suggestion } = SessionSnapshot.parse(payload);
    return { summary, snapshot: { runs, items, parkedPrompts, rewinds, instructions, suggestion }, events: [], eventBytes: 0 };
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
      // A document from before #119 (a `transcript` field, no `snapshot`), from before #260 (no `rewinds`) or from before #506 (no
      // `instructions`) does not read: no cache, so the session subscribes from nothing.
      snapshot: StoredSnapshotParts.parse(stored["snapshot"]),
      events,
      eventBytes: sizeOf(events),
    };
  },
});

/**
 * The environment's own stream. Its notices are read here, its name, icon
 * and colour among them: they come from the environment, never the client
 * (ADR 0005), in its snapshot and in `environment.renamed`,
 * `environment.icon-set` and `environment.colour-set` (#323). The other
 * notices are `environment.started`, `environment.updated` (harness
 * versions), `environment.draining`, an update's pending, started, failed
 * and cancelled (#335), a check of the release channel that changed what
 * `updates.status` shows (`environment.channel-checked`, #1795), `account.updated` (the account store, #134),
 * `signin.updated` and `signin.executable-chosen` (the sign-in director,
 * #135), `prompt.parked` and `prompt.resolved` (the permission broker,
 * #130), `usage.updated` (plan usage, #136), `settings.changed` (#391),
 * `setup.result-changed` (#569), and the forge's, the key managers' and the
 * routines' (#519) events.
 *
 * The status follows the notices: `environment.draining` makes it draining,
 * and `environment.started` (the restart after a drain, or any start) makes
 * it ready and idle, since a process that has just started runs nothing.
 * The look takes each field its notice sets, whether or not a snapshot came
 * first. Each `setup.result-changed` replaces its step's result (#570).
 */
export const environmentKind = (): StreamKind<EnvironmentData> => ({
  empty: () => ({ status: null, look: {}, setup: [], stateImportFailures: [] }),
  emptyIsState: true,
  fromSnapshot: (payload) => ({
    status: SnapshotStatus.parse(payload).status,
    // An environment from before #323 sends no look, and a look this build cannot read (a newer environment's icon) is none.
    look: SnapshotLook.safeParse(payload).data?.environment ?? {},
    setup: readResults(payload["setup"]),
    stateImportFailures: StateImportFailure.array().parse(payload["stateImportFailures"] ?? []),
  }),
  apply(data, event) {
    // A notice this client does not know (a newer environment's) changes nothing it holds.
    const notice = EnvironmentNotice.safeParse(event);
    if (!notice.success) return data;
    // A step's result replaces the one held, whether or not a snapshot gave the status: a replay from the cursor carries no
    // snapshot, and folds every result the environment noticed (#570).
    if (notice.data.type === "setup.result-changed") return { ...data, setup: withResult(data.setup, notice.data.payload) };
    const { status } = data;
    switch (notice.data.type) {
      case "environment.draining":
        return status === null ? data : { ...data, status: { ...status, readiness: "draining", activity: { state: "draining", drainingSince: notice.data.payload.drainingSince } } };
      case "environment.started":
        return status === null ? data : { ...data, status: { ...status, readiness: "ready", activity: { state: "idle" } } };
      // The look (#323): each notice sets its one field.
      case "environment.renamed":
        return { ...data, look: { ...data.look, name: notice.data.payload.name } };
      case "environment.icon-set":
        return { ...data, look: { ...data.look, icon: notice.data.payload.icon } };
      case "environment.colour-set":
        return { ...data, look: { ...data.look, colour: notice.data.payload.colour } };
      // The known environments' union changing (#382) changes no status: the request cache reads instructions.preview again.
      case "environment.known-environments-updated":
        return data;
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
      // what is news (#344). The drain an update began is `environment.draining`'s. A check of the release channel that
      // changed what `updates.status` shows (#1795) holds none either: the request cache reads it again.
      case "environment.update-pending":
      case "environment.update-started":
      case "environment.update-failed":
      case "environment.update-cancelled":
      case "environment.channel-checked":
        return data;
      // A prompt's notices change no status: the parked asks (`projections.runs`) and the notices queue read them (#142).
      case "prompt.parked":
      case "prompt.resolved":
        return data;
      // The denylist or the Unattended review changing (#811) changes no status: the request cache reads
      // permissions.denylist.get and permissions.settings.get, or permissions.review.list, again.
      case "denylist.updated":
      case "review.updated":
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
      case "forge.origin-answered":
        return data;
      // A queued memory change (#1030) changes no status; the request cache refreshes `banks.drafts.list`.
      case "bank.draft-queued":
      case "bank.drafts-consumed":
        return data;
      // The BankService's events (#1025) change no status: the request cache refreshes `banks.list` and `banks.get` on them.
      case "bank.added":
      case "bank.updated":
      case "bank.pinned":
      case "bank.forgotten":
      case "bank.synced":
      case "bank.verified":
      case "bank.landed":
      case "bank.landing-failed":
      case "bank.awaiting-review":
      case "bank.review-held":
        return data;
      // The key-manager connections' events (#365, #366) and Move's (#371, #372) change no status: the request cache refreshes
      // keyManagers.list and keyManagers.move.list on them, and the notices queue raises a connection's status rows (#384).
      case "key-manager.connection.added":
      case "key-manager.connection.signed-in":
      case "key-manager.connection.signed-out":
      case "key-manager.connection.updated":
      case "key-manager.connection.policies-set":
      case "key-manager.connection.base-path-set":
      case "key-manager.connection.injected-set":
      case "key-manager.connection.verified":
      case "key-manager.connection.removed":
      case "key-manager.moved":
      case "key-manager.stored-value-deleted":
      case "key-manager.value-copied":
        return data;
      // The routines' notices (#519) change no status: the routines list refreshes on routine.updated (#532), and the
      // notices queue raises a delivered result and a failed delivery (#525, #529).
      case "routine.updated":
      case "routine.delivered":
      case "routine.delivery-failed":
      case "routine.endpoint-set":
      case "routine.endpoint-removed":
        return data;
      // A probe changing managed-tool rows (#373) changes no status: the request cache refreshes tools.list on it (#384). Nor does a
      // tool run's start or end (#376): its terminal streams on its own, and the probe after it is heard as tools.updated.
      case "tools.updated":
      case "tool.run-started":
      case "tool.run-finished":
        return data;
      // Settings changed (#391): the status holds none of them; the request cache fetches settings.get and
      // permissions.settings.get again (`QUERY_REFRESH_NOTICES`).
      case "settings.changed":
      case "web.origins.updated":
        return data;
      // The skill set changing (#494) changes no status: the request cache reads skills.get again.
      case "skills.updated":
        return data;
      // A trust decision recorded or revoked (#500) changes no status: the request cache reads trust.get and trust.list again.
      case "trust.updated":
        return data;
      // An owned instruction changed (#505) changes no status: the request cache reads instructions.list, instructions.preview and instructions.diff (#509) again.
      case "instructions.updated":
        return data;
      // An unpaired extension seen (#547) changes no status: the request cache reads browser.status again.
      case "extension.seen":
        return data;
      // An import of an adopted account's directory ending (#578) changes no status: the request cache reads carryOver.inventory again.
      case "carry-over.imported":
        return data;
      // A memory folder assigned to a repository (#580) changes no status: the request cache reads carryOver.inventory again.
      case "carry-over.memory-assigned":
        return data;
      // Keep the last completed import's failures even when heard as history (#1935).
      case "state-import.finished":
        return { ...data, stateImportFailures: notice.data.payload.failed };
      // A Workspace directory's check command changing (#1187) changes no status: the check view reads checks.get again (#1189).
      case "checks.changed":
      case "checks.failures-reset":
        return data;
      // A worktree kept at its last session's purge (#330) changes no status: the notices queue says it.
      case "workspace.kept":
        return data;
      // A paired Chrome's change (#548) changes no status: the request cache reads browser.chromes.list and browser.status again.
      case "chrome.updated":
        return data;
      // A call addressed to a client session (#554) changes no status: the client-call registry hands it to its handler.
      case "client.call":
        return data;
    }
  },
  encode: (data) => data,
  decode(value) {
    const stored = fieldsOf(value, "The stored environment");
    // A stored document is JSON, which holds no field as undefined: what the partial schema reads is a partial look.
    const look = StoredLook.safeParse(stored["look"]).data as Partial<EnvironmentLook> | undefined;
    // A document from before #570 holds no results and does not read: no cache, so the stream subscribes from nothing and
    // hears every result the environment holds, where resuming from its cursor would miss those noticed before it.
    // A cache from before #1935 missed finished imports: replay from nothing to recover their failures.
    return { status: EnvironmentStatus.nullable().parse(stored["status"]), look: look ?? {}, setup: StepResult.array().parse(stored["setup"]), stateImportFailures: StateImportFailure.array().parse(stored["stateImportFailures"]) };
  },
});
