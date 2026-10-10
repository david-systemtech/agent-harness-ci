import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  SKILL_PROBE_DEPTH,
  SKILL_PROBE_MAX_DIRECTORIES,
  SKILL_PROBE_SKIPPED,
  SKILL_SOURCE_LIMIT,
  SKILLS_STREAM_KIND,
  repositoryIdentityOf,
  type ForgeAccountOrigins,
  type GitCommit,
  type SkillMember,
  type SkillOrigin,
  type SkillProbeProblem,
  type SkillProbeUnreachable,
  type SkillSource,
  type SkillSourceAddConflict,
  type SkillSourceFollow,
  type SkillSourceMember,
  type SkillSourceSync,
  type SkillsSourceAddedPayload,
  type SkillsSourceFollowSetPayload,
  type SkillsSourceRemovedPayload,
  type SkillsSourceSyncedPayload,
  type SkillsViewSource,
} from "@agent-harness/contracts";
import { parseActor } from "../event-log/envelope.js";
import type { EventLog, Projector, StreamRef, Tx } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandler, PreparedCommand } from "../serve/methods.js";
import type { SkillProbes, SourceCheckout, SourceCheckoutRequest } from "./probe.js";
import { occupied } from "./own-directory.js";
import { PROVENANCE_MANIFEST, readProvenanceManifest } from "./provenance.js";
import { findSkillFolders, readSkillFolder, sourceRootNaming, type FoundMember } from "./reader.js";
import { createSnapshots, snapshotPath } from "./snapshots.js";

/**
 * The skill sources (skills spec, "Skill sources"; ADR 0029, ADR 0009): the
 * repositories' folders an environment tracks for skills, on the `skills`
 * stream, one stream whose id is the environment's, and their snapshots
 * under the data directory. `skills.sources.add` reads the folder from a
 * checkout at what the source follows (the probe's when it can, `probe.ts`),
 * refuses one that yields no skill, and exports it at the commit into the
 * source's first snapshot (`snapshots.ts`); `skills.sources.remove` stops
 * tracking it. Every account's set reads each source's members from its
 * current snapshot, so they join the set below the own directory, the
 * earliest added first (`precedence.ts`), and a member's link in a
 * generation points into the snapshot. A provenance manifest in the
 * source's folder, else one level up from it, gives its members their
 * origin, as the own directory's does; the folder's own wins whole, even
 * one naming nothing. A member the manifest does not name comes from
 * the source's repository and folder. At most twenty sources, one per
 * repository identity and folder.
 *
 * A fetch of a source (#499: its add, a sync, a pin at a commit) checks out
 * what it follows, exports the folder at that commit into a snapshot (one
 * already there reused) and reads it: `ok` with its members, `layout_moved`
 * when it yields no valid member (the snapshot removed, the folders found),
 * or `failed` with the probe's problem. What it came to is recorded as
 * `skills.source-synced` only when the commit, the members or the outcome
 * change; when a fetch last ended is the source's status, persisted beside
 * the log and retained by a projection rebuild. The syncer (`sync.ts`) decides when a source syncs.
 */

export const SKILL_SOURCES_PROJECTOR = "skill-sources";

export const SKILL_SOURCES_TABLES = {
  skill_sources: `CREATE TABLE skill_sources (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    identity TEXT NOT NULL,
    folder TEXT NOT NULL,
    follow TEXT NOT NULL,
    position INTEGER NOT NULL,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    snapshot_commit TEXT,
    members TEXT NOT NULL,
    sync TEXT
  ) STRICT`,
} as const;

export const skillSourcesProjector: Projector = {
  name: SKILL_SOURCES_PROJECTOR,
  tables: SKILL_SOURCES_TABLES,
  apply(event, db) {
    if (event.streamKind !== SKILLS_STREAM_KIND) return;
    if (event.type === "skills.source-added") {
      const { id, url, identity, folder, follow, position } = event.payload as SkillsSourceAddedPayload;
      db.run(
        "INSERT INTO skill_sources (id, url, identity, folder, follow, position, added_by, added_at, snapshot_commit, members) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]')",
        id,
        url,
        identity,
        folder,
        JSON.stringify(follow),
        position,
        event.actor,
        event.occurredAt,
      );
    } else if (event.type === "skills.source-synced") {
      const synced = event.payload as SkillsSourceSyncedPayload;
      const since = event.occurredAt;
      if (synced.outcome === "ok") {
        const sync: SkillSourceSync = { outcome: "ok", since };
        db.run("UPDATE skill_sources SET snapshot_commit = ?, members = ?, sync = ? WHERE id = ?", synced.commit, JSON.stringify(synced.members), JSON.stringify(sync), synced.sourceId);
      } else {
        // A failed or moved sync keeps the last good snapshot, and says why.
        const sync: SkillSourceSync =
          synced.outcome === "failed" ? { outcome: "failed", since, problem: synced.problem, line: synced.line } : { outcome: "layout_moved", since, commit: synced.commit, folders: synced.folders };
        db.run("UPDATE skill_sources SET sync = ? WHERE id = ?", JSON.stringify(sync), synced.sourceId);
      }
    } else if (event.type === "skills.source-follow-set") {
      const { sourceId, follow } = event.payload as SkillsSourceFollowSetPayload;
      db.run("UPDATE skill_sources SET follow = ? WHERE id = ?", JSON.stringify(follow), sourceId);
    } else if (event.type === "skills.source-removed") {
      db.run("DELETE FROM skill_sources WHERE id = ?", (event.payload as SkillsSourceRemovedPayload).sourceId);
    }
  },
};

interface SourceRow {
  readonly id: string;
  readonly url: string;
  readonly identity: string;
  readonly folder: string;
  readonly follow: string;
  readonly position: number;
  readonly added_by: string;
  readonly added_at: string;
  readonly snapshot_commit: string;
  readonly members: string;
  readonly sync: string;
}

/** A source as the log holds it: as `skills.get` lists it but for when a fetch of it last ended, with the members its current snapshot yields. */
export interface TrackedSource extends Omit<SkillsViewSource, "attemptedAt"> {
  readonly members: readonly SkillSourceMember[];
}

/** Whether a member the reader read is valid: named, and with no problem. */
const valid = (member: Pick<SkillSourceMember, "name" | "problems">): boolean => member.name !== null && member.problems.length === 0;

const sourceOf = (row: SourceRow): TrackedSource => {
  const members = JSON.parse(row.members) as SkillSourceMember[];
  return {
    id: row.id,
    url: row.url,
    identity: row.identity,
    folder: row.folder,
    follow: JSON.parse(row.follow) as SkillSourceFollow,
    position: row.position,
    addedBy: parseActor(row.added_by),
    addedAt: row.added_at,
    commit: row.snapshot_commit,
    skillCount: members.filter(valid).length,
    sync: JSON.parse(row.sync) as SkillSourceSync,
    members,
  };
};

/**
 * The sources the environment tracks, each with its current snapshot's
 * commit and members and what its last sync came to, earliest added first,
 * as the log's query-only read gives them (inside a command, as of its
 * transaction).
 */
export const readSkillSources = (log: Pick<EventLog, "read">): TrackedSource[] =>
  log.read<SourceRow>("SELECT * FROM skill_sources WHERE snapshot_commit IS NOT NULL ORDER BY position").map(sourceOf);

/** Where a source added now stands: after every source held, from 1. */
const nextPosition = (log: Pick<EventLog, "read">): number => (log.read<{ last: number | null }>("SELECT MAX(position) AS last FROM skill_sources")[0]?.last ?? 0) + 1;

/** The repository identities of the sources tracked, each once: repositories this environment knows (#311). */
export const readSkillSourceIdentities = (log: Pick<EventLog, "read">): string[] =>
  log.read<{ identity: string }>("SELECT identity FROM skill_sources GROUP BY identity ORDER BY MIN(position)").map((row) => row.identity);

/** A folder's segments, from a repository's root; none for the root. */
const segmentsOf = (folder: string): string[] => (folder === "." ? [] : folder.split("/"));

/** The sources' layer as one read found it: the sources, the members their current snapshots yield, and where each member lies. */
export interface SourcesLayer {
  readonly sources: readonly SkillsViewSource[];
  readonly members: readonly SkillMember[];
  /** Where a member of the layer lies: its folder in its source's current snapshot, and that snapshot's commit. */
  place(member: Pick<SkillMember, "layer" | "path">): { readonly target: string; readonly commit: GitCommit };
}

/**
 * What one fetch of a source came to: the folder exported at the commit
 * into a snapshot, with the members it yields; no valid member at the
 * commit, with the folders that would (the snapshot made for it removed);
 * or the repository out of reach, with the probe's problem and its refusal.
 */
export type SourceFetch =
  | { readonly outcome: "ok"; readonly commit: GitCommit; readonly members: readonly SkillSourceMember[]; readonly snapshot: string }
  | { readonly outcome: "layout_moved"; readonly commit: GitCommit; readonly folders: readonly string[] }
  | { readonly outcome: "failed"; readonly problem: SkillProbeProblem; readonly line: string; readonly refusal: ContractError };

export interface SkillSources {
  /** Reads every source's current snapshot. */
  read(): Promise<SourcesLayer>;
  /** `skills.sources.add`. */
  readonly add: PreparedCommand<"skills.sources.add">;
  /** `skills.sources.remove`. */
  readonly remove: MethodHandler<"skills.sources.remove">;
  /** Fetches what `follow` names of `source` and reads its folder at that commit from a snapshot; its git stops when `signal` aborts. */
  fetch(source: Pick<SkillSource, "id" | "url" | "identity" | "folder">, follow: SkillSourceFollow, signal?: AbortSignal): Promise<SourceFetch>;
  /** Notes that a fetch of the source ended now: its status, kept outside the log. */
  noteAttempt(tx: Tx, sourceId: string): void;
  /** The source as `skills.get` lists it: as the log holds it, with when a fetch of it last ended. */
  view(source: TrackedSource): SkillsViewSource;
  /** Deletes each snapshot no source holds current, no generation links into, and none made or read since the sweep before. */
  sweepSnapshots(): Promise<void>;
}

export interface SkillSourcesOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its skills stream and its own. */
  readonly environmentId: string;
  readonly dataDir: string;
  readonly clock: Clock;
  /** Where a source's folder is read from (`probe.ts`). */
  readonly probes: Pick<SkillProbes, "checkout">;
  /** The forge accounts' canonical origins and verified aliases, which the repository identity reads. */
  readonly forgeAccounts: () => readonly ForgeAccountOrigins[];
}

/**
 * The `skills.source-synced` that records `fetched` for `source`; null when
 * it changes nothing the log holds: neither the commit, nor the members,
 * nor the outcome (a failure's problem, a moved layout's commit).
 */
export const syncedPayload = (source: TrackedSource, fetched: SourceFetch): SkillsSourceSyncedPayload | null => {
  const sourceId = source.id;
  const { sync } = source;
  if (fetched.outcome === "ok") {
    const same = sync.outcome === "ok" && source.commit === fetched.commit && JSON.stringify(source.members) === JSON.stringify(fetched.members);
    return same ? null : { sourceId, outcome: "ok", commit: fetched.commit, members: [...fetched.members] };
  }
  if (fetched.outcome === "failed") {
    return sync.outcome === "failed" && sync.problem === fetched.problem ? null : { sourceId, outcome: "failed", problem: fetched.problem, line: fetched.line };
  }
  return sync.outcome === "layout_moved" && sync.commit === fetched.commit ? null : { sourceId, outcome: "layout_moved", commit: fetched.commit, folders: [...fetched.folders] };
};

/**
 * `conflict`, reason `no_skills`, for a folder that yields no valid member; `folders` the walk found.
 * Its message is plain (setup-copy.md §5.9): the folder, then the folders that have skills, if any.
 */
export const noSkills = (folder: string, folders: readonly string[]): CommandRejection<"conflict"> => {
  const where = folder === "." ? "this repository" : `the folder ${folder}`;
  // The walk lists the folder itself when the skills in it all have problems: the message says so rather than naming it as one that would do.
  const line = folders.includes(folder) ? `The skills in ${where} cannot be used.` : `There are no skills in ${where}.`;
  const others = folders.filter((found) => found !== folder);
  const elsewhere = others.length > 0 ? ` These folders have skills: ${others.join(", ")}.` : "";
  return { code: "conflict", message: `${line}${elsewhere}`, data: { reason: "no_skills", folders: [...folders] } };
};

/** The notice every committed change to the sources is followed by. */
const UPDATED = { type: "skills.updated", payload: {} } as const;

/** `conflict` with the add's `data`. */
const conflict = (message: string, data: Exclude<SkillSourceAddConflict, { reason: "unreachable" }>): CommandRejection<"conflict"> => ({ code: "conflict", message, data: { ...data } });

export const createSkillSources = (options: SkillSourcesOptions): SkillSources => {
  const { log, dataDir, clock } = options;
  const stream: StreamRef = { kind: SKILLS_STREAM_KIND, id: options.environmentId };
  const snapshots = createSnapshots({ dataDir, current: () => readSkillSources(log).map((source) => ({ sourceId: source.id, commit: source.commit })) });
  /** When a fetch of each source last ended, by its id: its status, kept outside the log. */
  const attempts = log.skillSourceAttempts;
  const noteAttempt = (tx: Tx, sourceId: string): void => attempts.write(tx, sourceId, clock.now().toISOString());
  const view = ({ id, url, identity, folder, follow, position, addedBy, addedAt, commit, skillCount, sync }: TrackedSource): SkillsViewSource => ({
    id,
    url,
    identity,
    folder,
    follow,
    position,
    addedBy,
    addedAt,
    commit,
    skillCount,
    sync,
    attemptedAt: attempts.read(id),
  });

  /** Where a source's member lies: its folder from the source's folder, in the source's current snapshot. */
  const placeIn = (source: SkillsViewSource, path: string): string =>
    join(snapshotPath(dataDir, source.id, source.commit), ...segmentsOf(source.folder), ...segmentsOf(path));

  /** The members `source`'s current snapshot yields, in its layer, each with its origin. */
  const membersOf = async (source: SkillsViewSource): Promise<SkillMember[]> => {
    const snapshot = snapshotPath(dataDir, source.id, source.commit);
    snapshots.touch(snapshot);
    const segments = segmentsOf(source.folder);
    const found = await readSkillFolder(join(snapshot, ...segments), sourceRootNaming(source.identity, source.folder));
    // The manifest in the folder when one is there, naming anything or not, else the one a level up from it.
    const beside = join(snapshot, ...segments, PROVENANCE_MANIFEST);
    const manifest = segments.length === 0 || (await occupied(beside)) ? beside : join(snapshot, ...segments.slice(0, -1), PROVENANCE_MANIFEST);
    const origins = await readProvenanceManifest(manifest);
    const originOf = (relative: string): SkillOrigin => {
      const named = origins.get(relative === "." ? (segments.at(-1) ?? ".") : relative);
      if (named !== undefined) return named;
      return { kind: "repository", repository: source.identity, path: [...segments, ...segmentsOf(relative)].join("/") || "." };
    };
    return found.map(({ relative, ...member }: FoundMember): SkillMember => ({ ...member, path: relative, layer: { kind: "source", sourceId: source.id }, origin: originOf(relative) }));
  };

  /** Why a source on `identity` and `folder` cannot be added now: one already tracks them, or twenty do. */
  const refusalFor = (identity: string, folder: string): CommandRejection<"conflict"> | null => {
    const sources = readSkillSources(log);
    const same = sources.find((source) => source.identity === identity && source.folder === folder);
    if (same !== undefined) {
      return conflict("You already follow this collection.", { reason: "duplicate", sourceId: same.id });
    }
    if (sources.length >= SKILL_SOURCE_LIMIT) {
      return conflict(`You can follow up to ${SKILL_SOURCE_LIMIT} collections. Remove one first.`, { reason: "source_limit", limit: SKILL_SOURCE_LIMIT });
    }
    return null;
  };

  /** The folders at the checkout a source would read skills from, the root first when it is one skill. */
  const foldersAt = async (checkout: string): Promise<string[]> => {
    const found = await findSkillFolders(checkout, { depth: SKILL_PROBE_DEPTH, maxDirectories: SKILL_PROBE_MAX_DIRECTORIES, skipped: SKILL_PROBE_SKIPPED });
    return [...(found.rootIsSkill ? ["."] : []), ...found.folders];
  };

  const refusing =
    (rejected: CommandRejection<"conflict">) =>
    (): CommandAnswer<never, "conflict"> => ({ aggregate: stream, rejected });

  const fetch = async (
    { id, url, identity, folder }: Pick<SkillSource, "id" | "url" | "identity" | "folder">,
    follow: SkillSourceFollow,
    using: Pick<SourceCheckoutRequest, "probeId" | "signal"> = {},
  ): Promise<SourceFetch> => {
    let checkout: SourceCheckout;
    try {
      checkout = await options.probes.checkout({ url, follow, ...using });
    } catch (error) {
      if (!(error instanceof ContractError) || error.data["reason"] !== "unreachable") throw error;
      const { problem, line } = error.data as SkillProbeUnreachable;
      return { outcome: "failed", problem, line, refusal: error };
    }
    try {
      const { path, made } = await snapshots.make(id, folder, checkout);
      const members = await readSkillFolder(join(path, ...segmentsOf(folder)), sourceRootNaming(identity, folder));
      if (members.some(valid)) {
        return { outcome: "ok", commit: checkout.commit, members: members.map(({ name, relative, description, invocation, problems }) => ({ name, path: relative, description, invocation, problems })), snapshot: path };
      }
      const folders = await foldersAt(checkout.path);
      if (made) await snapshots.remove(path);
      return { outcome: "layout_moved", commit: checkout.commit, folders };
    } finally {
      checkout.release();
    }
  };

  const add: PreparedCommand<"skills.sources.add"> = {
    async prepare({ url, folder, follow, probeId }, context) {
      const identity = repositoryIdentityOf(url, options.forgeAccounts());
      if (identity === null) throw new Error("A URL the source URL rule takes has an identity.");
      const early = refusalFor(identity, folder);
      if (early !== null) return refusing(early);

      const sourceId = randomUUID();
      const fetched = await fetch({ id: sourceId, url, identity, folder }, follow, probeId === undefined ? {} : { probeId });
      if (fetched.outcome === "failed") throw fetched.refusal;
      if (fetched.outcome === "layout_moved") return refusing(noSkills(folder, fetched.folders));
      const { snapshot } = fetched;
      context.onUndo(() => snapshots.remove(snapshot));
      const synced: SkillsSourceSyncedPayload = { sourceId, outcome: "ok", commit: fetched.commit, members: [...fetched.members] };

      return (_params, command: CommandContext) => {
        // Checked again as of the transaction: another add may have committed since the first check.
        const late = refusalFor(identity, folder);
        if (late !== null) return { aggregate: stream, rejected: late };
        const added: SkillsSourceAddedPayload = { id: sourceId, url, identity, folder, follow, position: nextPosition(log) };
        const attribution = { tx: command.tx, actor: command.actor, commandId: command.commandId };
        const [event] = log.append(
          stream,
          [
            { type: "skills.source-added", payload: added },
            { type: "skills.source-synced", payload: synced },
          ],
          attribution,
        ).events;
        if (event === undefined) throw new Error("skills.source-added was appended as no event.");
        log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [UPDATED], attribution);
        noteAttempt(command.tx, sourceId);
        const source: SkillsViewSource = {
          ...added,
          addedBy: parseActor(event.actor),
          addedAt: event.occurredAt,
          commit: synced.commit,
          skillCount: synced.members.filter(valid).length,
          sync: { outcome: "ok", since: event.occurredAt },
          attemptedAt: attempts.read(sourceId),
        };
        return { aggregate: stream, result: { source } };
      };
    },
  };

  const remove: MethodHandler<"skills.sources.remove"> = ({ sourceId }, context) => {
    const tracked = readSkillSources(log).find((held) => held.id === sourceId);
    const source = tracked === undefined ? undefined : view(tracked);
    if (source === undefined) {
      return { aggregate: stream, rejected: { code: "not_found", message: `No skill source ${sourceId} is on this environment.`, data: { kind: "source", sourceId } } };
    }
    const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
    log.append(stream, [{ type: "skills.source-removed", payload: { sourceId } }], attribution);
    attempts.remove(context.tx, sourceId);
    log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [UPDATED], attribution);
    return { aggregate: stream, result: { source } };
  };

  return {
    async read() {
      const sources = readSkillSources(log).map(view);
      const members = (await Promise.all(sources.map(membersOf))).flat();
      const byId = new Map(sources.map((source) => [source.id, source]));
      return {
        sources,
        members,
        place(member) {
          const source = member.layer.kind === "source" ? byId.get(member.layer.sourceId) : undefined;
          if (source === undefined) throw new Error(`The member ${member.path} is no member of a tracked source.`);
          return { target: placeIn(source, member.path), commit: source.commit };
        },
      };
    },
    add,
    remove,
    fetch: (source, follow, signal) => fetch(source, follow, signal === undefined ? {} : { signal }),
    noteAttempt,
    view,
    sweepSnapshots: () => snapshots.sweep(),
  };
};
