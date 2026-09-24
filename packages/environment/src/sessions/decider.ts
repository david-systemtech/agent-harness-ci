import {
  MAX_TAGS,
  type SessionArchivedPayload,
  type SessionActiveReorderedPayload,
  type SessionCreatedPayload,
  type SessionDeletedPayload,
  type SessionDraftSetPayload,
  type SessionPinReorderedPayload,
  type SessionPinnedPayload,
  type SessionTaggedPayload,
  type SessionTitleSetPayload,
  type SessionUntaggedPayload,
  type Workspace,
} from "@agent-harness/contracts";
import type { EventInput, JsonObject } from "../event-log/event-log.js";

/**
 * The session aggregate's decider (session-state spec, "Modules and
 * ownership"): pure, the state the projection holds plus a command giving
 * the events to append or a typed refusal, as T3 Code's decider does. The
 * handlers read the state and append what it decides; nothing here reads
 * or writes anything.
 */

/**
 * A session as the decider needs it: whether it is deleted (or purged), its
 * user title, and the summary fields the filing commands decide on.
 */
export interface SessionState {
  readonly deleted: boolean;
  /**
   * When a deleted session is purged, as ISO 8601 UTC: set while it is in
   * its grace period, null for a session not deleted and for one purged
   * (deleted with nothing left of it).
   */
  readonly purgeAt: string | null;
  readonly userTitle: string | null;
  readonly archivedAt: string | null;
  readonly pinnedAt: string | null;
  readonly pinOrderKey: string | null;
  readonly activeOrderKey: string | null;
  readonly settledAt: string | null;
  readonly snoozedUntil: string | null;
  /** As the summary holds them: trimmed, one per case-folded key, sorted by it. */
  readonly tags: readonly string[];
  readonly draft: string | null;
}

/** A purged session: its id stays used, so it reads as deleted with nothing left of it. */
export const PURGED_STATE: SessionState = {
  deleted: true,
  purgeAt: null,
  userTitle: null,
  archivedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  settledAt: null,
  snoozedUntil: null,
  tags: [],
  draft: null,
};

/** Why a command is refused: its target is not there, or its state does not allow it. */
export type Refusal =
  | { readonly code: "not_found"; readonly message: string; readonly data: JsonObject & { readonly kind: "session" | "group" } }
  | { readonly code: "conflict"; readonly message: string; readonly data: JsonObject & { readonly reason: string } };

/** What a command decides: the events to append (none for a command that changes nothing), or its refusal. */
export type Decision = { readonly events: readonly EventInput[]; readonly rejected?: undefined } | { readonly rejected: Refusal };

/** `sessions.create` as the decider takes it: the absent optional params filled in. */
export interface CreateSession {
  readonly id: string;
  readonly title: string | null;
  readonly tags: readonly string[];
  readonly groupId: string | null;
  readonly workspace: Workspace;
  readonly account: string | null;
  readonly model: string | null;
  readonly mode: string | null;
}

/** Facts about other aggregates `sessions.create` depends on. */
export interface CreateContext {
  /** Whether the group the command names is on this environment. */
  readonly groupExists: boolean;
}

/** `sessions.rename` as the decider takes it. */
export interface RenameSession {
  readonly sessionId: string;
  readonly title: string | null;
}

/** The one refusal of a session that is not on this environment: a command's rejected receipt and `sessions.get` both carry it. */
export const sessionNotFound = (sessionId: string): Refusal & { readonly code: "not_found" } => ({
  code: "not_found",
  message: `No session ${sessionId} is on this environment.`,
  data: { kind: "session", sessionId },
});

/** A tag's case-folded key: what a session's tags are unique on and sorted by, here and in the session-tags table. */
export const tagKey = (tag: string): string => tag.toLowerCase();

/**
 * Tags as a session keeps them: trimmed, one per spelling ignoring case
 * with the latest casing kept, sorted ignoring case (then by code unit, so
 * the order is the same on every machine).
 */
export const normaliseTags = (tags: readonly string[]): string[] => {
  const byKey = new Map<string, string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    const key = tagKey(trimmed);
    byKey.delete(key);
    byKey.set(key, trimmed);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, tag]) => tag);
};

/** A user title as a session keeps it: trimmed, or null for none. */
const userTitle = (title: string | null): string | null => (title === null ? null : title.trim());

/**
 * Creates a session that has never existed: one `session.created`, with no
 * repository identity until the workspace workstream resolves it. An id
 * that was used before, even by a session since deleted or purged, is a
 * conflict; a group that is not on this environment is not found.
 */
export const decideCreate = (state: SessionState | null, command: CreateSession, context: CreateContext): Decision => {
  if (state !== null) {
    return {
      rejected: { code: "conflict", message: `A session ${command.id} exists already.`, data: { reason: "exists", sessionId: command.id } },
    };
  }
  if (command.groupId !== null && !context.groupExists) {
    return {
      rejected: {
        code: "not_found",
        message: `No group ${command.groupId} is on this environment.`,
        data: { kind: "group", groupId: command.groupId },
      },
    };
  }
  const payload: SessionCreatedPayload = {
    title: userTitle(command.title),
    tags: normaliseTags(command.tags),
    groupId: command.groupId,
    workspace: command.workspace,
    repositoryIdentity: null,
    account: command.account,
    model: command.model,
    mode: command.mode,
  };
  return { events: [{ type: "session.created", payload }] };
};

/**
 * Sets the session's user title, trimmed, or clears it with null; a title
 * the session already has changes nothing. A session that does not exist or
 * is deleted is not found.
 */
export const decideRename = (state: SessionState | null, command: RenameSession): Decision => {
  if (state === null || state.deleted) return { rejected: sessionNotFound(command.sessionId) };
  const next = userTitle(command.title);
  if (next === state.userTitle) return { events: [] };
  const payload: SessionTitleSetPayload = { title: next, source: "user" };
  return { events: [{ type: "session.title-set", payload }] };
};

/** A command aimed at one session: its id, in lowercase. */
interface OnSession {
  readonly sessionId: string;
}

/** `sessions.archive` and `sessions.pin` as the decider takes them: with the time the command runs, which the event records. */
interface AtTime {
  /** The environment's time now, as ISO 8601 UTC. */
  readonly at: string;
}

/** `sessions.pin`: the key in the pinned block, or null for none. */
export interface PinSession extends OnSession, AtTime {
  readonly orderKey: string | null;
}

/** `sessions.reorderPinned` and `sessions.reorderActive`: the new key. */
export interface ReorderSession extends OnSession {
  readonly orderKey: string;
}

/** `sessions.tag` and `sessions.untag`: the tag as sent, trimmed here. */
export interface TagSession extends OnSession {
  readonly tag: string;
}

/** `sessions.setDraft`: the draft that replaces the stored one; null or empty clears it. */
export interface SetDraft extends OnSession {
  readonly draft: string | null;
}

/** A session command's state, or the refusal when the session is not there: never created, deleted or purged. */
const present = (state: SessionState | null, sessionId: string): SessionState | { readonly rejected: Refusal } =>
  state === null || state.deleted ? { rejected: sessionNotFound(sessionId) } : state;

/** A `conflict` naming the session and why its state does not allow the command. */
const conflict = (sessionId: string, reason: string, message: string, data: JsonObject = {}): { readonly rejected: Refusal } => ({
  rejected: { code: "conflict", message, data: { reason, sessionId, ...data } },
});

const unchanged: Decision = { events: [] };

/** Archives the session at `at`; an archived session is unchanged. */
export const decideArchive = (state: SessionState | null, command: OnSession & AtTime): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  if (session.archivedAt !== null) return unchanged;
  const payload: SessionArchivedPayload = { archivedAt: command.at };
  return { events: [{ type: "session.archived", payload }] };
};

/** Takes the session out of the archive; one not archived is unchanged. */
export const decideUnarchive = (state: SessionState | null, command: OnSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  if (session.archivedAt === null) return unchanged;
  return { events: [{ type: "session.unarchived", payload: {} }] };
};

/**
 * Pins the session at `at`, at `orderKey` in the pinned block when given.
 * A pinned session given no key, or its own, is unchanged; given another
 * key it moves in the block (`session.pin-reordered`) and keeps its pin's
 * time, so a pin replayed from an outbox still sets the key it carried.
 *
 * A settled or snoozed session is pinned with `session.pinned` alone for
 * now. The spec's companions, unsettling it (reason `user`) and waking the
 * snooze in the same transaction, arrive with settle and snooze in #117;
 * until then such a session stays on its settled or snoozed shelf, which
 * `shelfOf` ranks above pinned.
 */
export const decidePin = (state: SessionState | null, command: PinSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  if (session.pinnedAt !== null) {
    if (command.orderKey === null || command.orderKey === session.pinOrderKey) return unchanged;
    const payload: SessionPinReorderedPayload = { pinOrderKey: command.orderKey };
    return { events: [{ type: "session.pin-reordered", payload }] };
  }
  const payload: SessionPinnedPayload = { pinnedAt: command.at, pinOrderKey: command.orderKey };
  return { events: [{ type: "session.pinned", payload }] };
};

/** Unpins the session, dropping its key in the pinned block; one not pinned is unchanged. Its active key is kept. */
export const decideUnpin = (state: SessionState | null, command: OnSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  if (session.pinnedAt === null) return unchanged;
  return { events: [{ type: "session.unpinned", payload: {} }] };
};

/**
 * Moves a pinned session in the pinned block; at its own key it is
 * unchanged. A session that is not pinned is a conflict (`not_pinned`), so a
 * reorder that raced an unpin never resurrects the pin.
 */
export const decideReorderPinned = (state: SessionState | null, command: ReorderSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  if (session.pinnedAt === null) {
    return conflict(command.sessionId, "not_pinned", `The session ${command.sessionId} is not pinned, so it has no place in the pinned block.`);
  }
  if (session.pinOrderKey === command.orderKey) return unchanged;
  const payload: SessionPinReorderedPayload = { pinOrderKey: command.orderKey };
  return { events: [{ type: "session.pin-reordered", payload }] };
};

/**
 * Arranges the session in the active list; at its own key it is unchanged.
 * A pinned, settled or archived session is a conflict (`not_active`). A
 * snoozed one may be arranged: it keeps its active slot for when it wakes.
 */
export const decideReorderActive = (state: SessionState | null, command: ReorderSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  const elsewhere = session.pinnedAt !== null ? "pinned" : session.settledAt !== null ? "settled" : session.archivedAt !== null ? "archived" : null;
  if (elsewhere !== null) {
    return conflict(command.sessionId, "not_active", `The session ${command.sessionId} is ${elsewhere}, so it has no place in the active list.`);
  }
  if (session.activeOrderKey === command.orderKey) return unchanged;
  const payload: SessionActiveReorderedPayload = { activeOrderKey: command.orderKey };
  return { events: [{ type: "session.active-reordered", payload }] };
};

/**
 * Tags the session with the tag trimmed. A tag held in the same casing is
 * unchanged; in another casing it is tagged again, so the latest casing is
 * kept. A new tag past `MAX_TAGS` is a conflict (`too_many_tags`).
 */
export const decideTag = (state: SessionState | null, command: TagSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  const tag = command.tag.trim();
  const held = session.tags.find((existing) => tagKey(existing) === tagKey(tag));
  if (held === tag) return unchanged;
  if (held === undefined && session.tags.length >= MAX_TAGS) {
    return conflict(command.sessionId, "too_many_tags", `The session ${command.sessionId} has ${MAX_TAGS} tags, the most it holds.`, { limit: MAX_TAGS });
  }
  const payload: SessionTaggedPayload = { tag };
  return { events: [{ type: "session.tagged", payload }] };
};

/** Removes the tag matched ignoring case, the event naming it as the session held it; a tag not held is unchanged. */
export const decideUntag = (state: SessionState | null, command: TagSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  const held = session.tags.find((existing) => tagKey(existing) === tagKey(command.tag.trim()));
  if (held === undefined) return unchanged;
  const payload: SessionUntaggedPayload = { tag: held };
  return { events: [{ type: "session.untagged", payload }] };
};

/**
 * Replaces the session's draft with the one sent, exactly as sent; an empty
 * draft is none. The draft already stored is unchanged.
 */
export const decideSetDraft = (state: SessionState | null, command: SetDraft): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  const draft = command.draft === "" ? null : command.draft;
  if (draft === session.draft) return unchanged;
  const payload: SessionDraftSetPayload = { draft };
  return { events: [{ type: "session.draft-set", payload }] };
};

/** How long a deleted session can be restored before it is purged: thirty days, a constant rather than a setting. */
export const DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** `sessions.delete`: when it runs, and whether the purge is to delete the provider's transcript too. */
export interface DeleteSession extends OnSession, AtTime {
  readonly deleteProviderTranscript: boolean;
}

/**
 * Deletes the session at `at`: one `session.deleted`, purged `DELETION_GRACE_MS`
 * later unless restored, with the transcript flag as asked. A session already
 * deleted is not found, as it is for every command but restore and purge.
 *
 * What deletion obliges elsewhere (stopping the session's provider process,
 * closing its terminals) is the adapter's and the terminal workstreams',
 * triggered by this event on the log; restore touches neither.
 */
export const decideDelete = (state: SessionState | null, command: DeleteSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  const payload: SessionDeletedPayload = {
    deletedAt: command.at,
    purgeAt: new Date(Date.parse(command.at) + DELETION_GRACE_MS).toISOString(),
    deleteProviderTranscript: command.deleteProviderTranscript,
  };
  return { events: [{ type: "session.deleted", payload }] };
};

/**
 * Restores a deleted session before its `purgeAt`: one `session.restored`,
 * which brings it back as it was. Once `purgeAt` has come it is not found,
 * whether or not the sweep has purged it yet; so is one purged or never
 * created. A session that is not deleted is unchanged.
 */
export const decideRestore = (state: SessionState | null, command: OnSession & AtTime): Decision => {
  if (state === null || (state.deleted && (state.purgeAt === null || command.at >= state.purgeAt))) {
    return { rejected: sessionNotFound(command.sessionId) };
  }
  if (!state.deleted) return unchanged;
  return { events: [{ type: "session.restored", payload: {} }] };
};

/**
 * Whether `sessions.purge` may purge the session now: only a deleted one,
 * in its grace period or past it. One not deleted is a conflict
 * (`not_deleted`); one purged or never created is not found. The purge
 * itself (`deletion.ts`) writes the tombstone, since what it records of the
 * provider's transcript is known only once the adapter has been asked.
 */
export const decidePurge = (
  state: SessionState | null,
  command: OnSession,
): { readonly purge: true; readonly rejected?: undefined } | { readonly rejected: Refusal } => {
  if (state === null || (state.deleted && state.purgeAt === null)) return { rejected: sessionNotFound(command.sessionId) };
  if (!state.deleted) return conflict(command.sessionId, "not_deleted", `The session ${command.sessionId} is not deleted, so it cannot be purged.`);
  return { purge: true };
};
