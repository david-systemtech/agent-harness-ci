import {
  GROUP_STREAM_KIND,
  LIST_PATCH_KEY,
  SESSION_STREAM_KIND,
  isListEvent,
  type Group,
  type GroupPatch,
  type SessionActiveReorderedPayload,
  type SessionArchivedPayload,
  type SessionBrowserSetPayload,
  type SessionCreatedPayload,
  type SessionDeletedPayload,
  type SessionDraftSetPayload,
  type SessionGroupSetPayload,
  type SessionModelSetPayload,
  type SessionModeSetPayload,
  type SessionPinReorderedPayload,
  type SessionPinnedPayload,
  type SessionRepositoryIdentifiedPayload,
  type SessionSummary,
  type SessionTaggedPayload,
  type SessionTitleGeneratedPayload,
  type SessionTitleSetPayload,
  type SessionUntaggedPayload,
  type SessionWorkspaceSetPayload,
  type SessionWorkspaceStatusChangedPayload,
  type SummaryPatch,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb, Projector, SqlValue } from "../event-log/event-log.js";
import { tagKey } from "./decider.js";
import { projectGroupEvent } from "./group-list.js";
import { readGroup } from "./group-reads.js";
import { readSummary } from "./session-reads.js";
import { SESSION_LIST_TABLES, runChoiceColumn, titleOf, type SessionRow } from "./session-tables.js";
import { shelfProjections } from "./shelf-list.js";
import { systemProjections } from "./system-list.js";

/**
 * The session-list projector (session-state spec, "The list stream and the
 * summary patch"): it writes the session-list tables in the transaction of
 * the events, and for every `list`-flagged event it applies it reads the
 * summary before and after (with the reads `sessions.get` and the snapshot
 * use) and attaches the difference to the event's metadata under
 * `LIST_PATCH_KEY`, so the patch a client applies cannot disagree with them.
 */

export const SESSION_LIST_PROJECTOR = "session-list";

/** The fields of `after` but its id that differ from `before`, compared as JSON. */
const changedFields = <T extends { id: string }>(before: T, after: T): Partial<Omit<T, "id">> => {
  const fields: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (key !== "id" && JSON.stringify(before[key]) !== JSON.stringify(after[key])) fields[key] = after[key];
  }
  return fields;
};

/** The patch taking the list from a session's `before` to its `after`: added, its changed fields set, or removed. */
export const summaryPatch = (id: string, before: SessionSummary | null, after: SessionSummary | null): SummaryPatch => {
  if (after === null) return { op: "remove", sessionId: id };
  if (before === null) return { op: "add", summary: after };
  return { op: "set", sessionId: id, fields: changedFields(before, after) };
};

/** The patch taking the groups from a group's `before` to its `after`: added, its changed fields set, or removed. */
export const groupPatch = (id: string, before: Group | null, after: Group | null): GroupPatch => {
  if (after === null) return { op: "remove", groupId: id };
  if (before === null) return { op: "add", group: after };
  return { op: "set", groupId: id, fields: changedFields(before, after) };
};

/** How one `list`-flagged session event type changes the tables; each ticket that appends a type adds its projection. */
type Projection = (event: EventEnvelope, db: ProjectionDb) => void;

const insertTags = (db: ProjectionDb, sessionId: string, tags: readonly string[]): void => {
  for (const tag of tags) db.run("INSERT INTO session_tags (session_id, tag, tag_key) VALUES (?, ?, ?)", sessionId, tag, tagKey(tag));
};

/** Sets columns of the event's session and nothing else; the column names are this module's own, never input. */
const setColumns = (event: EventEnvelope, db: ProjectionDb, columns: Readonly<Record<string, SqlValue>>): void => {
  const names = Object.keys(columns);
  db.run(`UPDATE sessions SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE id = ?`, ...Object.values(columns), event.streamId);
};

/**
 * Sets columns of the event's session and moves its `updatedAt` to the
 * event's time: the projection of an organisation change.
 */
const organise = (event: EventEnvelope, db: ProjectionDb, columns: Readonly<Record<string, SqlValue>>): void =>
  setColumns(event, db, { ...columns, updated_at: event.occurredAt });

const SESSION_PROJECTIONS: Partial<Record<string, Projection>> = {
  // The shelf (#117), and the fields the run, prompt and pull-request events write, which auto-settle reads.
  ...shelfProjections(organise),
  ...systemProjections(setColumns),
  // An imported session (#578) began, and was last active, when its provider session did, as the import read them; it is
  // idle since then. Its origin is kept for the import's deduplication by provider session id.
  "session.created": (event, db) => {
    const payload = event.payload as SessionCreatedPayload;
    const { title, source } = titleOf(payload.title, null);
    const imported = payload.origin?.kind === "import" ? payload.origin : null;
    db.run(
      `INSERT INTO sessions (id, created_at, updated_at, last_activity_at, title, title_source, user_title, group_id, workspace,
                             repository_identity, activity, mode, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.streamId,
      imported?.createdAt ?? event.occurredAt,
      event.occurredAt,
      imported?.lastActivityAt ?? null,
      title,
      source,
      payload.title,
      payload.groupId,
      JSON.stringify(payload.workspace),
      payload.repositoryIdentity,
      JSON.stringify({ state: "idle", since: imported?.lastActivityAt ?? event.occurredAt }),
      payload.mode,
      payload.origin === undefined ? null : JSON.stringify(payload.origin),
    );
    insertTags(db, event.streamId, payload.tags);
  },
  // The availability watcher's mark (workspace-picker spec, "Missing workspaces"): since when the workspace is gone, cleared when
  // it is back. The system's finding, not an organisation change, so `updatedAt` stays.
  "session.workspace-status-changed": (event, db) =>
    setColumns(event, db, {
      workspace_missing_since: (event.payload as SessionWorkspaceStatusChangedPayload).status === "missing" ? event.occurredAt : null,
    }),
  // A missing session given another workspace (#328): its place and identity, the mark cleared; the user's organisation change.
  "session.workspace-set": (event, db) => {
    const payload = event.payload as SessionWorkspaceSetPayload;
    organise(event, db, { workspace: JSON.stringify(payload.workspace), repository_identity: payload.repositoryIdentity, workspace_missing_since: null });
  },
  // An identity pass's finding (#329): the identity resolved again, or moved to a forge account's canonical host. The
  // system's, not an organisation change, so `updatedAt` stays.
  "session.repository-identified": (event, db) =>
    setColumns(event, db, { repository_identity: (event.payload as SessionRepositoryIdentifiedPayload).repositoryIdentity }),
  // The mode the permissions workstream gave the session (#129, #179); not an organisation change, so `updatedAt` stays.
  "session.mode.set": (event, db) => setColumns(event, db, { mode: (event.payload as SessionModeSetPayload).mode.effective }),
  // The browser the session's next run resolves (#550): like the mode, what its runs may do, so `updatedAt` stays.
  "session.browser.set": (event, db) => {
    const { browser } = event.payload as SessionBrowserSetPayload;
    setColumns(event, db, { browser: browser === null ? null : JSON.stringify(browser) });
  },
  // The model and effort the session's next run goes out on (#1961): like the browser, what its runs do, so `updatedAt` stays.
  "session.model-set": (event, db) => setColumns(event, db, { run_choice: runChoiceColumn(event.payload as SessionModelSetPayload) }),
  "session.title-set": (event, db) => {
    const payload = event.payload as SessionTitleSetPayload;
    const [row] = db.all<Pick<SessionRow, "generated_title">>("SELECT generated_title FROM sessions WHERE id = ?", event.streamId);
    const { title, source } = titleOf(payload.title, row?.generated_title ?? null);
    db.run(
      "UPDATE sessions SET user_title = ?, title = ?, title_source = ?, updated_at = ? WHERE id = ?",
      payload.title,
      title,
      source,
      event.occurredAt,
      event.streamId,
    );
  },
  // The fallback under the user's title (#122): what the session shows when the user has set none. Generated, not
  // organised by anyone, so it leaves updatedAt where it was; under a user title its patch changes no field shown.
  "session.title-generated": (event, db) => {
    const payload = event.payload as SessionTitleGeneratedPayload;
    const [row] = db.all<Pick<SessionRow, "user_title">>("SELECT user_title FROM sessions WHERE id = ?", event.streamId);
    const { title, source } = titleOf(row?.user_title ?? null, payload.title);
    setColumns(event, db, { generated_title: payload.title, title, title_source: source });
  },
  "session.archived": (event, db) => organise(event, db, { archived_at: (event.payload as SessionArchivedPayload).archivedAt }),
  "session.unarchived": (event, db) => organise(event, db, { archived_at: null }),
  "session.pinned": (event, db) => {
    const payload = event.payload as SessionPinnedPayload;
    organise(event, db, { pinned_at: payload.pinnedAt, pin_order_key: payload.pinOrderKey });
  },
  "session.unpinned": (event, db) => organise(event, db, { pinned_at: null, pin_order_key: null }),
  "session.pin-reordered": (event, db) => organise(event, db, { pin_order_key: (event.payload as SessionPinReorderedPayload).pinOrderKey }),
  "session.active-reordered": (event, db) =>
    organise(event, db, { active_order_key: (event.payload as SessionActiveReorderedPayload).activeOrderKey }),
  "session.tagged": (event, db) => {
    const { tag } = event.payload as SessionTaggedPayload;
    // A tag held in another casing takes this one: one row per case-folded key.
    db.run(
      `INSERT INTO session_tags (session_id, tag, tag_key) VALUES (?, ?, ?)
       ON CONFLICT (session_id, tag_key) DO UPDATE SET tag = excluded.tag`,
      event.streamId,
      tag,
      tagKey(tag),
    );
    organise(event, db, {});
  },
  "session.untagged": (event, db) => {
    const { tag } = event.payload as SessionUntaggedPayload;
    db.run("DELETE FROM session_tags WHERE session_id = ? AND tag_key = ?", event.streamId, tagKey(tag));
    organise(event, db, {});
  },
  // The draft is not an organisation change, so it leaves updatedAt where it was.
  "session.draft-set": (event, db) => setColumns(event, db, { draft: (event.payload as SessionDraftSetPayload).draft }),
  // Delete and restore leave updatedAt where it was too, so a restored session comes back unchanged.
  // Its summary leaves the list (`remove`) and comes back whole (`add`), since the list reads only sessions not deleted.
  "session.deleted": (event, db) => {
    const payload = event.payload as SessionDeletedPayload;
    setColumns(event, db, {
      deleted_at: payload.deletedAt,
      purge_at: payload.purgeAt,
      delete_provider_transcript: payload.deleteProviderTranscript ? 1 : 0,
    });
  },
  "session.restored": (event, db) => setColumns(event, db, { deleted_at: null, purge_at: null, delete_provider_transcript: 0 }),
  // The tombstone: the session's rows and tags go. Its patch is a removal, whatever the list held, so a client
  // replaying from before the deletion drops the id; one that saw the deletion removes it again, which changes nothing.
  // Replayed on a rebuild, with the session's other events gone, it finds nothing to delete.
  "session.purged": (event, db) => {
    db.run("DELETE FROM session_tags WHERE session_id = ?", event.streamId);
    db.run("DELETE FROM sessions WHERE id = ?", event.streamId);
  },
  // Membership lives on the session; a group's deletion ungroups each member with one of these.
  "session.group-set": (event, db) => organise(event, db, { group_id: (event.payload as SessionGroupSetPayload).groupId }),
};

/** The session event types the projector projects: every `list`-flagged type of the session stream, which its test holds it to. */
export const PROJECTED_SESSION_EVENT_TYPES: readonly string[] = Object.keys(SESSION_PROJECTIONS);

/**
 * The projector. Every `list`-flagged session event is projected and its
 * summary patch attached, every group event and its group patch. A flagged
 * event it has no projection for fails its append, so no flagged event
 * reaches a client without its patch when it changes the list: a type
 * flagged later comes with its projection. A flagged session event that
 * leaves its session out of the list before and after carries no patch, and
 * a client skips it: a deleted session ungrouped when its group is deleted,
 * and the `run.ended` (`disposed`) of a run the session's deletion let go.
 * Other events are not the list's.
 */
export const sessionListProjector: Projector = {
  name: SESSION_LIST_PROJECTOR,
  tables: SESSION_LIST_TABLES,
  apply(event, db, context) {
    if (!isListEvent(event.streamKind, event.type)) return;
    if (event.streamKind === GROUP_STREAM_KIND) {
      const before = readGroup(db, event.streamId);
      projectGroupEvent(event, db);
      context.attachMetadata({ [LIST_PATCH_KEY]: groupPatch(event.streamId, before, readGroup(db, event.streamId)) });
      return;
    }
    const projection = event.streamKind === SESSION_STREAM_KIND ? SESSION_PROJECTIONS[event.type] : undefined;
    if (projection === undefined) throw new Error(`The session list does not project ${event.type} events yet.`);
    const before = readSummary(db, event.streamId);
    projection(event, db);
    const after = readSummary(db, event.streamId);
    // A session in the list neither before nor after (a deleted one ungrouped with its group) changes nothing a client lists,
    // except the tombstone, whose removal a client replaying from before the deletion needs to drop the id.
    if (before === null && after === null && event.type !== "session.purged") return;
    context.attachMetadata({ [LIST_PATCH_KEY]: summaryPatch(event.streamId, before, after) });
  },
};
