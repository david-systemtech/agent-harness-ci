import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
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
  type SkillSourceAddConflict,
  type SkillSourceFollow,
  type SkillSourceMember,
  type SkillsSourceAddedPayload,
  type SkillsSourceRemovedPayload,
  type SkillsSourceSyncedPayload,
  type SkillsViewSource,
} from "@agent-harness/contracts";
import { parseActor } from "../event-log/envelope.js";
import type { EventLog, Projector, StreamRef } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandler, PreparedCommand } from "../serve/methods.js";
import type { SkillProbes } from "./probe.js";
import { PROVENANCE_MANIFEST, readProvenanceManifest } from "./provenance.js";
import { findSkillFolders, readSkillFolder, sourceRootNaming, type FoundMember } from "./reader.js";
import { exportSnapshot, removeSnapshot, snapshotPath } from "./snapshots.js";

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
 * origin, as the own directory's does; a member it does not name comes from
 * the source's repository and folder. At most twenty sources, one per
 * repository identity and folder.
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
    members TEXT NOT NULL
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
      const { sourceId, commit, members } = event.payload as SkillsSourceSyncedPayload;
      db.run("UPDATE skill_sources SET snapshot_commit = ?, members = ? WHERE id = ?", commit, JSON.stringify(members), sourceId);
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
}

/** Whether a member the reader read is valid: named, and with no problem. */
const valid = (member: Pick<SkillSourceMember, "name" | "problems">): boolean => member.name !== null && member.problems.length === 0;

const sourceOf = (row: SourceRow): SkillsViewSource => ({
  id: row.id,
  url: row.url,
  identity: row.identity,
  folder: row.folder,
  follow: JSON.parse(row.follow) as SkillSourceFollow,
  position: row.position,
  addedBy: parseActor(row.added_by),
  addedAt: row.added_at,
  commit: row.snapshot_commit,
  skillCount: (JSON.parse(row.members) as SkillSourceMember[]).filter(valid).length,
});

/**
 * The sources the environment tracks, each with its current snapshot's
 * commit and skill count, earliest added first, as the log's query-only
 * read gives them (inside a command, as of its transaction).
 */
export const readSkillSources = (log: Pick<EventLog, "read">): SkillsViewSource[] =>
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

export interface SkillSources {
  /** Reads every source's current snapshot. */
  read(): Promise<SourcesLayer>;
  /** `skills.sources.add`. */
  readonly add: PreparedCommand<"skills.sources.add">;
  /** `skills.sources.remove`. */
  readonly remove: MethodHandler<"skills.sources.remove">;
}

export interface SkillSourcesOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its skills stream and its own. */
  readonly environmentId: string;
  readonly dataDir: string;
  /** Where a source's folder is read from (`probe.ts`). */
  readonly probes: Pick<SkillProbes, "checkout">;
  /** The forge accounts' canonical origins and verified aliases, which the repository identity reads. */
  readonly forgeAccounts: () => readonly ForgeAccountOrigins[];
}

/** The notice every committed change to the sources is followed by. */
const UPDATED = { type: "skills.updated", payload: {} } as const;

/** `conflict` with the add's `data`. */
const conflict = (message: string, data: Exclude<SkillSourceAddConflict, { reason: "unreachable" }>): CommandRejection<"conflict"> => ({ code: "conflict", message, data: { ...data } });

export const createSkillSources = (options: SkillSourcesOptions): SkillSources => {
  const { log, dataDir } = options;
  const stream: StreamRef = { kind: SKILLS_STREAM_KIND, id: options.environmentId };

  /** Where a source's member lies: its folder from the source's folder, in the source's current snapshot. */
  const placeIn = (source: SkillsViewSource, path: string): string =>
    join(snapshotPath(dataDir, source.id, source.commit), ...segmentsOf(source.folder), ...segmentsOf(path));

  /** The members `source`'s current snapshot yields, in its layer, each with its origin. */
  const membersOf = async (source: SkillsViewSource): Promise<SkillMember[]> => {
    const snapshot = snapshotPath(dataDir, source.id, source.commit);
    const segments = segmentsOf(source.folder);
    const found = await readSkillFolder(join(snapshot, ...segments), sourceRootNaming(source.identity, source.folder));
    // The manifest in the folder, else the one a level up from it.
    const beside = await readProvenanceManifest(join(snapshot, ...segments, PROVENANCE_MANIFEST));
    const origins = beside.size > 0 || segments.length === 0 ? beside : await readProvenanceManifest(join(snapshot, ...segments.slice(0, -1), PROVENANCE_MANIFEST));
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
      return conflict(`The environment already tracks ${folder === "." ? "the root" : `the folder ${folder}`} of ${identity} as a source.`, { reason: "duplicate", sourceId: same.id });
    }
    if (sources.length >= SKILL_SOURCE_LIMIT) {
      return conflict(`The environment already tracks ${SKILL_SOURCE_LIMIT} skill sources, the most it may: remove one first.`, { reason: "source_limit", limit: SKILL_SOURCE_LIMIT });
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

  const add: PreparedCommand<"skills.sources.add"> = {
    async prepare({ url, folder, follow, probeId }, context) {
      const identity = repositoryIdentityOf(url, options.forgeAccounts());
      if (identity === null) throw new Error("A URL the source URL rule takes has an identity.");
      const early = refusalFor(identity, folder);
      if (early !== null) return refusing(early);

      const checkout = await options.probes.checkout({ url, follow, ...(probeId !== undefined && { probeId }) });
      const sourceId = randomUUID();
      const snapshot = snapshotPath(dataDir, sourceId, checkout.commit);
      let members: FoundMember[];
      let folders: string[] = [];
      try {
        await exportSnapshot(checkout.path, folder, snapshot);
        context.onUndo(() => removeSnapshot(snapshot));
        members = await readSkillFolder(join(snapshot, ...segmentsOf(folder)), sourceRootNaming(identity, folder));
        if (!members.some(valid)) folders = await foldersAt(checkout.path);
      } finally {
        checkout.release();
      }
      if (!members.some(valid)) {
        const where = folder === "." ? "The repository's root" : `The folder ${folder}`;
        const elsewhere = folders.length === 0 ? "No folder in the repository does." : `These folders do: ${folders.join(", ")}.`;
        return refusing(conflict(`${where} holds no skill at ${checkout.commit.slice(0, 7)}. ${elsewhere}`, { reason: "no_skills", folders }));
      }
      const synced: SkillsSourceSyncedPayload = {
        sourceId,
        outcome: "ok",
        commit: checkout.commit,
        members: members.map(({ name, relative, description, invocation, problems }) => ({ name, path: relative, description, invocation, problems })),
      };

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
        const source: SkillsViewSource = { ...added, addedBy: parseActor(event.actor), addedAt: event.occurredAt, commit: synced.commit, skillCount: members.filter(valid).length };
        return { aggregate: stream, result: { source } };
      };
    },
  };

  const remove: MethodHandler<"skills.sources.remove"> = ({ sourceId }, context) => {
    const source = readSkillSources(log).find((tracked) => tracked.id === sourceId);
    if (source === undefined) {
      return { aggregate: stream, rejected: { code: "not_found", message: `No skill source ${sourceId} is on this environment.`, data: { kind: "source", sourceId } } };
    }
    const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
    log.append(stream, [{ type: "skills.source-removed", payload: { sourceId } }], attribution);
    log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [UPDATED], attribution);
    return { aggregate: stream, result: { source } };
  };

  return {
    async read() {
      const sources = readSkillSources(log);
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
  };
};
