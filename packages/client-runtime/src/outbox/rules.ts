import { normaliseGroupName, type CommandMethodName, type Group, type SessionSummary } from "@agent-harness/contracts";
import type { ListData } from "../streams/kinds.js";

/**
 * What the outbox knows of each command beyond its schema
 * (docs/specs/client-runtime.md, "The offline outbox, receipts and
 * optimistic application"): the stream it targets, the verb a notice says
 * it with, and its optimistic rule, the change it will make to the session
 * list, which the overlay shows until the environment has said so itself.
 * The rules follow the environment's deciders (the session-state spec,
 * "Commands" and its companion events); a command with no rule (a create,
 * whose summary the environment composes; a restore; the run commands)
 * shows nothing until its events arrive.
 */

/** The session or group a command is about: where its overlay goes and what its notice names. */
export interface Target {
  readonly kind: "session" | "group";
  /** In lowercase, as the environment keeps ids. */
  readonly id: string;
}

/**
 * The change a command will make to the list: fields of its target set to
 * what the command will produce; its target hidden (deleted); or a group
 * added (created with a client-minted id).
 */
export type OverlayChange =
  | { readonly target: Target; readonly op: "set"; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly target: Target; readonly op: "hide" }
  | { readonly target: Target; readonly op: "add"; readonly group: Group };

const text = (params: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
};

/** The session or group `params` name: a session command's `sessionId` first, then a group's, then the id a create mints. */
export const targetOf = (method: string, params: Readonly<Record<string, unknown>>): Target | null => {
  const sessionId = text(params, "sessionId");
  if (sessionId !== undefined) return { kind: "session", id: sessionId.toLowerCase() };
  const groupId = text(params, "groupId");
  if (groupId !== undefined && method.startsWith("groups.")) return { kind: "group", id: groupId.toLowerCase() };
  const id = text(params, "id");
  if (id !== undefined && method === "groups.create") return { kind: "group", id: id.toLowerCase() };
  if (id !== undefined && method === "sessions.create") return { kind: "session", id: id.toLowerCase() };
  return null;
};

/**
 * The routine a routine command names (`routineId`), in lowercase: every
 * routine command's but an import's that makes routines, whose ids are
 * routines still to be made; null for any other command.
 */
export const routineOf = (method: string, params: Readonly<Record<string, unknown>>): string | null =>
  method.startsWith("routines.") ? (text(params, "routineId")?.toLowerCase() ?? null) : null;

/** How a notice names each organisation and routine command; any other is named from its method's last word. */
const VERBS: Readonly<Record<string, string>> = {
  "sessions.create": "Create session",
  "sessions.rename": "Rename",
  "sessions.archive": "Archive",
  "sessions.unarchive": "Unarchive",
  "sessions.pin": "Pin",
  "sessions.unpin": "Unpin",
  "sessions.reorderPinned": "Reorder",
  "sessions.reorderActive": "Reorder",
  "sessions.tag": "Tag",
  "sessions.untag": "Untag",
  "sessions.setDraft": "Save draft",
  "sessions.setGroup": "Move",
  "sessions.settle": "Settle",
  "sessions.unsettle": "Unsettle",
  "sessions.snooze": "Snooze",
  "sessions.unsnooze": "Unsnooze",
  "sessions.delete": "Delete",
  "sessions.restore": "Restore",
  "sessions.purge": "Purge",
  "groups.create": "Create group",
  "groups.rename": "Rename group",
  "groups.reorder": "Reorder group",
  "groups.delete": "Delete group",
  "routines.create": "Create routine",
  "routines.update": "Edit routine",
  "routines.enable": "Enable routine",
  "routines.disable": "Disable routine",
  "routines.delete": "Delete routine",
  "routines.import": "Import routines",
};

/** The verb a notice says a command with: `Archive`, `Rename group`; `Stop task` for `runs.stopTask`. */
export const verbOf = (method: string): string => {
  const named = VERBS[method];
  if (named !== undefined) return named;
  const last = method.slice(method.lastIndexOf(".") + 1).replace(/([A-Z])/g, " $1").toLowerCase();
  return last.charAt(0).toUpperCase() + last.slice(1);
};

/**
 * Why a command was refused, in words: `not_found` as the target gone, or as the other thing the command named gone when
 * the error data's `kind` is not the target's (a session moved into a group deleted meanwhile); a conflict by its own reason.
 */
export const reasonOf = (code: string, data: Readonly<Record<string, unknown>> | undefined, target?: Target | null): string => {
  if (code === "not_found") {
    const kind = typeof data?.["kind"] === "string" ? (data["kind"] as string) : undefined;
    return kind !== undefined && target != null && kind !== target.kind ? `its ${kind.replace(/_/g, " ")} no longer exists` : "it no longer exists";
  }
  const reason = typeof data?.["reason"] === "string" ? (data["reason"] as string) : code;
  return reason.replace(/_/g, " ");
};

/** Tags as a session keeps them: one per spelling ignoring case, the latest casing kept, sorted ignoring case (the environment's rule). */
const normaliseTags = (tags: readonly string[]): string[] => {
  const byKey = new Map<string, string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    byKey.delete(trimmed.toLowerCase());
    byKey.set(trimmed.toLowerCase(), trimmed);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, tag]) => tag);
};

/** A timestamp as the environment writes one (milliseconds, `Z`); a value that is not one is kept as sent. */
const asTimestamp = (value: string): string => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? value : new Date(at).toISOString();
};

/**
 * The change `method` with `params` will make, reckoned against the list as
 * it shows now (`list`: the confirmed list with the overlay on top) at the
 * environment's time `now`; null when it has no optimistic rule, or its
 * target is not listed where the change depends on what the target holds.
 */
export const overlayOf = (method: CommandMethodName, params: Readonly<Record<string, unknown>>, list: ListData | null, now: string): OverlayChange | null => {
  const target = targetOf(method, params);
  if (target === null) return null;
  const session: SessionSummary | undefined = target.kind === "session" ? list?.sessions.get(target.id) : undefined;
  const set = (fields: Record<string, unknown>): OverlayChange => ({ target, op: "set", fields });
  switch (method) {
    case "sessions.rename": {
      const title = text(params, "title");
      // A title cleared (null) falls back to the generated title, which the summary does not carry: the event says what it is.
      // An empty or blank title never reaches here: `UserTitle` refuses it at dispatch (`invalid_params`).
      return title === undefined ? null : set({ title: title.trim(), titleSource: "user" });
    }
    case "sessions.archive":
      return set({ archivedAt: session?.archivedAt ?? now });
    case "sessions.unarchive":
      return set({ archivedAt: null });
    case "sessions.pin": {
      if (!session) return null;
      const fields: Record<string, unknown> = { pinnedAt: session.pinnedAt ?? now, pinOrderKey: text(params, "orderKey") ?? session.pinOrderKey };
      // A pin unsettles a settled session and wakes a snoozed one (its companions).
      if (session.settledAt !== null) Object.assign(fields, { settledAt: null, settledBy: null, settledOverride: "active", unsettledAt: now });
      if (session.snoozedUntil !== null) Object.assign(fields, { snoozedUntil: null, snoozedAt: null });
      return set(fields);
    }
    case "sessions.unpin":
      return set({ pinnedAt: null, pinOrderKey: null });
    case "sessions.reorderPinned":
      return set({ pinOrderKey: text(params, "orderKey") ?? null });
    case "sessions.reorderActive":
      return set({ activeOrderKey: text(params, "orderKey") ?? null });
    case "sessions.tag": {
      const tag = text(params, "tag");
      return session && tag !== undefined ? set({ tags: normaliseTags([...session.tags, tag]) }) : null;
    }
    case "sessions.untag": {
      const tag = text(params, "tag");
      return session && tag !== undefined ? set({ tags: session.tags.filter((held) => held.toLowerCase() !== tag.trim().toLowerCase()) }) : null;
    }
    case "sessions.setDraft": {
      const draft = text(params, "draft");
      return set({ draft: draft === undefined || draft === "" ? null : draft });
    }
    case "sessions.setGroup":
      return set({ groupId: text(params, "groupId")?.toLowerCase() ?? null });
    case "sessions.settle":
      // Settling unpins, clears the active key and wakes a snooze (its companions).
      return set({
        settledAt: session?.settledAt ?? now,
        settledBy: session?.settledBy ?? "user",
        settledOverride: "settled",
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
      });
    case "sessions.unsettle":
      return set({ settledAt: null, settledBy: null, settledOverride: "active", unsettledAt: now });
    case "sessions.snooze": {
      const until = text(params, "until");
      return until === undefined ? null : set({ snoozedUntil: asTimestamp(until), snoozedAt: now });
    }
    case "sessions.unsnooze":
      return set({ snoozedUntil: null, snoozedAt: null });
    case "sessions.delete":
      return { target, op: "hide" };
    case "groups.create": {
      const name = text(params, "name");
      if (name === undefined) return null;
      return { target, op: "add", group: { id: target.id, name: normaliseGroupName(name), orderKey: text(params, "orderKey") ?? null, createdAt: now, updatedAt: now } };
    }
    case "groups.rename": {
      const name = text(params, "name");
      return name === undefined ? null : set({ name: normaliseGroupName(name) });
    }
    case "groups.reorder":
      return set({ orderKey: text(params, "orderKey") ?? null });
    case "groups.delete":
      return { target, op: "hide" };
    default:
      return null;
  }
};
