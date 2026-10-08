import {
  ENVIRONMENT_STREAM_KIND,
  SKILL_SOURCE_LIMIT,
  SKILLS_STREAM_KIND,
  type SkillSourceFollow,
  type SkillsSourceFollowSetPayload,
  type SkillsSourceSyncedPayload,
} from "@agent-harness/contracts";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { CommandRejection, PreparedCommand } from "../serve/methods.js";
import { noSkills, readSkillSources, syncedPayload, type SkillSources, type SourceFetch, type TrackedSource } from "./sources.js";

/**
 * The syncer (skills spec, "Skill sources", "Pin and remove"; ADR 0029:
 * skills change slowly, so a run never waits on git): when a source that
 * follows a branch syncs, and pinning. Never before a run. Every unpinned
 * source syncs once at start, past the startup gate with the wire open;
 * then every six hours on one timer, the sources staggered across the
 * period by position, the first six hours after start; on Pull now
 * (`skills.sources.pull`); and at once when it is unpinned. A sync is the
 * source store's fetch (`sources.ts`): a depth-one clone of the branch
 * within sixty seconds, the folder exported at its commit into a snapshot
 * and read. It is the environment's own: it appends `skills.source-synced`
 * and `skills.updated` as the syncer, and only when the commit, the members
 * or the outcome change, as of its transaction, so a source removed or
 * whose follow changed while it fetched records nothing. One sync of a
 * source runs at a time: a Pull now, the timer or the start joins one in
 * flight of the same branch, and one of another branch waits for it. A
 * pinned source never syncs, and Pull now on one is refused. A sync the
 * environment's close cuts (a drain for an update) records nothing, so
 * nothing partial becomes current, and the next start syncs it again; the
 * close stops its git and settles once it has ended, so nothing it would
 * clone or export into the data directory outlives the close.
 */

/** How often each unpinned source syncs (ADR 0029). */
const SKILL_SYNC_INTERVAL_MS = 6 * 60 * 60_000;

/** The syncer's one timer's tick: the period over the most sources, so that twenty are each given a tick of their own. */
const SKILL_SYNC_TICK_MS = SKILL_SYNC_INTERVAL_MS / SKILL_SOURCE_LIMIT;

/** The syncs' own actor: the environment, whoever asked. */
const SYNC_ACTOR = formatActor({ kind: "system", id: "skill-sync" });

/** The notice every committed change to the sources is followed by. */
const UPDATED = { type: "skills.updated", payload: {} } as const;

export interface SkillSync {
  /** Syncs the source, or joins its sync in flight; settles when that sync has ended, whatever it came to. */
  sync(sourceId: string): Promise<void>;
  /** `skills.sources.pull`. */
  readonly pull: PreparedCommand<"skills.sources.pull">;
  /** `skills.sources.setFollow`. */
  readonly setFollow: PreparedCommand<"skills.sources.setFollow">;
  /**
   * Syncs every unpinned source now, then on the timer, and each source
   * unpinned at once; answers the stop, after which no sync records
   * anything, which stops the git of each sync in flight and settles once
   * every one has ended.
   */
  start(): () => Promise<void>;
}

export interface SkillSyncOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its skills stream and its own. */
  readonly environmentId: string;
  readonly clock: Clock;
  readonly sources: Pick<SkillSources, "fetch" | "noteAttempt" | "view">;
}

/** Whether `a` and `b` follow the same thing. */
const sameFollow = (a: SkillSourceFollow, b: SkillSourceFollow): boolean =>
  a.kind === "pinned" ? b.kind === "pinned" && a.commit === b.commit : b.kind === "branch" && a.branch === b.branch;

/** `not_found`, kind `source`. */
const notFound = (sourceId: string): CommandRejection<"not_found"> => ({ code: "not_found", message: `No skill source ${sourceId} is on this environment.`, data: { kind: "source", sourceId } });

export const createSkillSync = (options: SkillSyncOptions): SkillSync => {
  const { log, sources } = options;
  const stream: StreamRef = { kind: SKILLS_STREAM_KIND, id: options.environmentId };
  const environmentStream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  /** Each source's sync in flight, with the branch it fetches. */
  const inFlight = new Map<string, { readonly follow: SkillSourceFollow; readonly done: Promise<void> }>();
  /** Aborted by the stop: what stops the git of every sync in flight. */
  const stopping = new AbortController();
  const stopped = (): boolean => stopping.signal.aborted;

  const tracked = (sourceId: string): TrackedSource | undefined => readSkillSources(log).find((source) => source.id === sourceId);

  /** Records what a sync of `follow` found, as the syncer, unless the source went or follows something else now. */
  const record = (sourceId: string, follow: SkillSourceFollow, fetched: SourceFetch): void => {
    log.atomically((tx) => {
      const source = tracked(sourceId);
      if (source === undefined || !sameFollow(source.follow, follow)) return;
      sources.noteAttempt(tx, sourceId);
      const synced = syncedPayload(source, fetched);
      if (synced === null) return;
      log.append(stream, [{ type: "skills.source-synced", payload: synced }], { tx, actor: SYNC_ACTOR });
      log.append(environmentStream, [UPDATED], { tx, actor: SYNC_ACTOR });
    });
  };

  /** One sync of the source, of what it follows as it begins; nothing for a pinned or untracked one, or once stopped. */
  const syncNow = async (sourceId: string): Promise<void> => {
    const source = tracked(sourceId);
    if (stopped() || source === undefined || source.follow.kind === "pinned") return;
    const fetched = await sources.fetch(source, source.follow, stopping.signal);
    // Cut by the close: nothing is recorded, and the next start syncs it again.
    if (stopped()) return;
    record(sourceId, source.follow, fetched);
  };

  const sync = (sourceId: string): Promise<void> => {
    const follow = tracked(sourceId)?.follow;
    if (follow === undefined) return Promise.resolve();
    const running = inFlight.get(sourceId);
    if (running !== undefined && sameFollow(running.follow, follow)) return running.done;
    const done: Promise<void> = (running?.done.catch(() => undefined) ?? Promise.resolve())
      .then(() => syncNow(sourceId))
      .finally(() => {
        if (inFlight.get(sourceId)?.done === done) inFlight.delete(sourceId);
      });
    inFlight.set(sourceId, { follow, done });
    return done;
  };

  /** A sync the environment started, whose failure is logged. */
  const background = (sourceId: string): void =>
    void sync(sourceId).catch((error: unknown) => console.error(`Syncing the skill source ${sourceId} failed; it syncs again at its next turn:`, error));

  const pull: PreparedCommand<"skills.sources.pull"> = {
    async prepare({ sourceId }) {
      const source = tracked(sourceId);
      if (source === undefined) return () => ({ aggregate: stream, rejected: notFound(sourceId) });
      if (source.follow.kind === "pinned") {
        const { commit } = source.follow;
        return () => ({
          aggregate: stream,
          rejected: { code: "conflict", message: `The source is pinned at ${commit.slice(0, 7)}, so it never syncs: follow a branch again to pull it.`, data: { reason: "pinned", commit } },
        });
      }
      await sync(sourceId);
      return () => {
        const after = tracked(sourceId);
        return after === undefined ? { aggregate: stream, rejected: notFound(sourceId) } : { aggregate: stream, result: { source: sources.view(after) } };
      };
    },
  };

  const setFollow: PreparedCommand<"skills.sources.setFollow"> = {
    async prepare({ sourceId, follow }) {
      const before = tracked(sourceId);
      if (before === undefined) return () => ({ aggregate: stream, rejected: notFound(sourceId) });
      // A pin at another commit than the current snapshot's fetches it, and refuses one that cannot be fetched or yields nothing.
      let fetched: Extract<SourceFetch, { outcome: "ok" }> | null = null;
      if (follow.kind === "pinned" && follow.commit !== before.commit) {
        const found = await sources.fetch(before, follow);
        if (found.outcome === "failed") throw found.refusal;
        if (found.outcome === "layout_moved") return () => ({ aggregate: stream, rejected: noSkills(before.folder, found.folders) });
        fetched = found;
      }

      return (_params, command) => {
        const source = tracked(sourceId);
        if (source === undefined) return { aggregate: stream, rejected: notFound(sourceId) };
        if (sameFollow(source.follow, follow)) return { aggregate: stream, result: { source: sources.view(source) } };
        const attribution = { tx: command.tx, actor: command.actor, commandId: command.commandId };
        const synced: SkillsSourceSyncedPayload | null = fetched === null ? null : syncedPayload(source, fetched);
        log.append(stream, [{ type: "skills.source-follow-set", payload: { sourceId, follow } }, ...(synced === null ? [] : [{ type: "skills.source-synced", payload: synced }])], attribution);
        log.append(environmentStream, [UPDATED], attribution);
        if (fetched !== null) sources.noteAttempt(command.tx, sourceId);
        const after = tracked(sourceId);
        if (after === undefined) throw new Error("A source whose follow was set is tracked.");
        return { aggregate: stream, result: { source: sources.view(after) } };
      };
    },
  };

  return {
    sync,
    pull,
    setFollow,
    start() {
      for (const source of readSkillSources(log)) if (source.follow.kind === "branch") background(source.id);
      // One timer: each tick is one position's turn, the first six hours after start.
      let tick = 0;
      const timer = options.clock.setInterval(() => {
        tick += 1;
        if (tick < SKILL_SOURCE_LIMIT) return;
        const turn = tick % SKILL_SOURCE_LIMIT;
        for (const source of readSkillSources(log)) if (source.follow.kind === "branch" && (source.position - 1) % SKILL_SOURCE_LIMIT === turn) background(source.id);
      }, SKILL_SYNC_TICK_MS);
      // A source unpinned syncs at once, once the command that unpinned it has committed.
      const unsubscribe = log.subscribe((event) => {
        if (event.streamKind !== SKILLS_STREAM_KIND || event.type !== "skills.source-follow-set") return;
        const { sourceId, follow } = event.payload as SkillsSourceFollowSetPayload;
        if (follow.kind === "branch") background(sourceId);
      });
      return async () => {
        stopping.abort();
        timer.cancel();
        unsubscribe();
        await Promise.all([...inFlight.values()].map(({ done }) => done.catch(() => undefined)));
      };
    },
  };
};
