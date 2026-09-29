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
 *   now, or clears them (`unarchive`, `unpin`, `unsnooze`), whatever the
 *   target held, and the later of two of the same method and target is
 *   refused only where the earlier would be: so the later leaves nothing of
 *   the earlier's effect, and an outbox holding both unsent may keep only the
 *   later and drop the earlier;
 * - an **ordered** command is sent as queued, never replaced: its effect
 *   depends on what the target held (a pin's companions, a tag added to the
 *   set), or it makes or ends the target, or it may be refused for what its
 *   params name where an earlier one of the same method and target is not:
 *   a group's new name another group holds (`name_taken`), a group gone
 *   (`not_found`), a snooze's time out of its window (`out_of_window`). Sent
 *   in order, the earlier applies and the later is refused; the later sent
 *   alone would leave the target as neither had set it.
 *
 * A refusal a setter may meet (`not_pinned`, `not_active`, `not_found` for
 * its target) depends on the target's state alone, which the later command
 * meets the same way, so it does not stop the coalescing.
 */
export type WriteCommandKind =
  | { readonly setter: { readonly target: "session"; readonly fields: readonly (keyof SessionSummary)[] } }
  | { readonly setter: { readonly target: "group"; readonly fields: readonly (keyof Group)[] } }
  | { readonly ordered: string };

/**
 * Every `sessions:write` method as a setter or an ordered command, read from
 * the environment's deciders (verified in #128): a setter's decider writes
 * the fields from its params (or its now, or clears them), answers
 * unchanged only when they already hold those values, and refuses only for
 * the target's state. The contract test fails when a `sessions:write` method
 * is missing here, or a setter names a field its target does not have.
 */
export const SESSION_WRITE_COMMANDS = {
  "sessions.create": { ordered: "Makes the session: a second create with another id is another session." },
  "sessions.setWorkspace": {
    ordered: "Refused workspace_present unless the session's workspace is missing, which an earlier setWorkspace of the session clears; and its request makes a directory or a worktree.",
  },
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
  "sessions.setGroup": { ordered: "Refused not_found for a group gone, which an earlier move of the session may not be." },
  "sessions.settle": { ordered: "Unpins, clears the active key and wakes a snooze as companions, as the session held them." },
  "sessions.unsettle": { ordered: "Holds the session active or clears what settling set, as the session held it." },
  "sessions.snooze": { ordered: "Refused out_of_window for its own time, which an earlier snooze of the session may not be." },
  "sessions.unsnooze": { setter: { target: "session", fields: ["snoozedUntil", "snoozedAt"] } },
  "sessions.delete": { ordered: "Ends the session's life in the list; a restore may follow it." },
  "sessions.restore": { ordered: "Brings a deleted session back; it follows the delete it undoes." },
  "sessions.purge": { ordered: "Ends a deleted session for good." },
  "groups.create": { ordered: "Makes the group, which a queued sessions.setGroup may name." },
  "groups.rename": { ordered: "Refused name_taken for a name another group holds, which an earlier rename of the group may not be." },
  "groups.reorder": { setter: { target: "group", fields: ["orderKey"] } },
  "groups.delete": { ordered: "Ends the group and ungroups its members." },
  "sessions.fork": { ordered: "Makes the fork, a session of its own, which a queued sessions.setGroup may name; it follows the source's own commands (#137)." },
  "permissions.review.seen": { ordered: "Moves the Unattended review's watermark forward to a position, never back (#131); it is about no session or group." },
  "routines.create": { ordered: "Makes the routine, which a queued routines.update may name; refused name_taken for a name another routine holds (#519)." },
  "routines.update": { ordered: "Writes only the fields it names, so a later update of other fields leaves this one's standing; refused name_taken for a name another routine holds." },
  "routines.enable": { ordered: "Records the enabling client session's ceiling and clears movedTo, as the routine held it." },
  "routines.disable": { ordered: "Links the copy a move made, which a later disable may not name; it follows the enable it undoes." },
  "routines.delete": { ordered: "Ends the routine's life in the list." },
  "routines.import": { ordered: "Makes routines or replaces one's definition, all or nothing; refused name_taken for a name another routine holds." },
  "forge.pullRequests.link": { ordered: "Adds one pull request, as the forge answers it when the link is applied, to the set the session holds (#317)." },
  "forge.pullRequests.unlink": { ordered: "Takes one pull request from the set the session holds, and keeps discovery from linking it again; it follows the link it undoes." },
} as const satisfies { readonly [N in SessionWriteMethodName]: WriteCommandKind };
