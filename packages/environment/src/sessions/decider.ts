import type { SessionCreatedPayload, SessionTitleSetPayload, Workspace } from "@agent-harness/contracts";
import type { EventInput, JsonObject } from "../event-log/event-log.js";

/**
 * The session aggregate's decider (session-state spec, "Modules and
 * ownership"): pure, the state the projection holds plus a command giving
 * the events to append or a typed refusal, as T3 Code's decider does. The
 * handlers read the state and append what it decides; nothing here reads
 * or writes anything.
 */

/** A session as the decider needs it: whether it is deleted (or purged), and its user title. */
export interface SessionState {
  readonly deleted: boolean;
  readonly userTitle: string | null;
}

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
