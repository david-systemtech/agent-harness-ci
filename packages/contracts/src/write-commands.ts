import type { MethodName, Registry } from "./registry.js";
import type { Group, SessionSummary } from "./sessions.js";

/** The commands at `sessions:write`: every session field, groups and drafts, which a client's outbox queues while unreachable. */
export type SessionWriteMethodName = {
  readonly [N in MethodName]: Registry[N] extends { readonly scope: "sessions:write"; readonly kind: "command" } ? N : never;
}[MethodName];

/**
 * How a client's outbox may treat a `sessions:write` command (client-runtime
 * spec, "Coalescing"; ADR 0003):
 *
 * - an absolute **setter** writes `fields` of its target (the session or the
 *   group its params name) to values its params give, or the environment's
 *   now, whatever the target held, so a later command of the same method and
 *   target leaves nothing of an earlier one's effect: an outbox holding both
 *   unsent may keep only the later and drop the earlier;
 * - an **ordered** command is sent as queued, never replaced: its effect
 *   depends on what the target held (a pin's companions, a tag added to the
 *   set), or it makes or ends the target.
 *
 * A refusal a setter may meet (`not_pinned`, `not_active`, `name_taken`,
 * `out_of_window`) depends on the target's state too, but the later command
 * would meet it the same way, so it does not stop the coalescing. What an
 * earlier setter sets may matter to a command queued between the two,
 * though: a group's name is unique on its environment, so an outbox keeps a
 * `groups.rename` with a create or another group's rename behind it, which
 * may take the name it gives up.
 */
export type WriteCommandKind =
  | { readonly setter: { readonly target: "session"; readonly fields: readonly (keyof SessionSummary)[] } }
  | { readonly setter: { readonly target: "group"; readonly fields: readonly (keyof Group)[] } }
  | { readonly ordered: string };

/**
 * Every `sessions:write` method as a setter or an ordered command, read from
 * the environment's deciders (verified in #128): a setter's decider writes
 * the fields from its params and answers unchanged only when they already
 * hold those values. The contract test fails when a `sessions:write` method
 * is missing here, or a setter names a field its target does not have.
 */
export const SESSION_WRITE_COMMANDS = {
  "sessions.create": { ordered: "Makes the session: a second create with another id is another session." },
  "sessions.rename": { setter: { target: "session", fields: ["title", "titleSource"] } },
  "sessions.archive": { setter: { target: "session", fields: ["archivedAt"] } },
  "sessions.unarchive": { setter: { target: "session", fields: ["archivedAt"] } },
  "sessions.pin": { ordered: "Unsettles a settled session and wakes a snoozed one as companions, and keeps the pin's key when given none." },
  "sessions.unpin": { setter: { target: "session", fields: ["pinnedAt", "pinOrderKey"] } },
  "sessions.reorderPinned": { setter: { target: "session", fields: ["pinOrderKey"] } },
  "sessions.reorderActive": { setter: { target: "session", fields: ["activeOrderKey"] } },
  "sessions.tag": { ordered: "Adds one tag to the set the session holds." },
  "sessions.untag": { ordered: "Takes one tag from the set the session holds." },
  "sessions.setDraft": { setter: { target: "session", fields: ["draft"] } },
  "sessions.setGroup": { setter: { target: "session", fields: ["groupId"] } },
  "sessions.settle": { ordered: "Unpins, clears the active key and wakes a snooze as companions, as the session held them." },
  "sessions.unsettle": { ordered: "Holds the session active or clears what settling set, as the session held it." },
  "sessions.snooze": { setter: { target: "session", fields: ["snoozedUntil", "snoozedAt"] } },
  "sessions.unsnooze": { setter: { target: "session", fields: ["snoozedUntil", "snoozedAt"] } },
  "sessions.delete": { ordered: "Ends the session's life in the list; a restore may follow it." },
  "sessions.restore": { ordered: "Brings a deleted session back; it follows the delete it undoes." },
  "sessions.purge": { ordered: "Ends a deleted session for good." },
  "groups.create": { ordered: "Makes the group, which a queued sessions.setGroup may name." },
  "groups.rename": { setter: { target: "group", fields: ["name"] } },
  "groups.reorder": { setter: { target: "group", fields: ["orderKey"] } },
  "groups.delete": { ordered: "Ends the group and ungroups its members." },
} as const satisfies { readonly [N in SessionWriteMethodName]: WriteCommandKind };
