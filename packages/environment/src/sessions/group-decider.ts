import {
  normaliseGroupName,
  type GroupCreatedPayload,
  type GroupRenamedPayload,
  type GroupReorderedPayload,
  type SessionGroupSetPayload,
} from "@agent-harness/contracts";
import type { EventInput } from "../event-log/event-log.js";
import { groupNotFound, type Decision, type Refusal } from "./decider.js";

/**
 * The group aggregate's decider (session-state spec, "Group" and
 * "Commands"): pure, as the session decider is, which decides
 * `sessions.setGroup`. A group's name is
 * kept trimmed with its white space collapsed and is unique per environment
 * ignoring case; membership is the session's `groupId`, so deleting a group
 * decides one ungrouping per member for the handler to append beside it.
 */

/** A group as the decider needs it: whether it is deleted, and the fields its commands decide on. */
export interface GroupState {
  readonly deleted: boolean;
  /** As the group keeps it: trimmed, white space collapsed. */
  readonly name: string;
  readonly orderKey: string | null;
}

/** A deleted group: its id stays used, so a create with it is a conflict, and every other command is not found. */
export const DELETED_GROUP: GroupState = { deleted: true, name: "", orderKey: null };

/**
 * A group's name as it is kept (trimmed, white space collapsed), and what it
 * is unique on (that, lowercased; the groups table holds it as `name_key`).
 * Both live in contracts, since the client runtime merges headings by the
 * same key; re-exported here for this package's modules.
 */
export { groupNameKey, normaliseGroupName } from "@agent-harness/contracts";

/** Facts about the other groups a name depends on: which group holds a name ignoring case. */
export interface NameContext {
  /** The group whose name has the command's name key, its id and its name as stored; null when none has. */
  readonly nameHeldBy: { readonly id: string; readonly name: string } | null;
}

/** `groups.create` as the decider takes it: the absent key as null. */
export interface CreateGroup {
  readonly id: string;
  readonly name: string;
  readonly orderKey: string | null;
}

/** A command aimed at one group: its id, in lowercase. */
interface OnGroup {
  readonly groupId: string;
}

/** `groups.rename`: the name as sent, normalised here. */
export interface RenameGroup extends OnGroup {
  readonly name: string;
}

/** `groups.reorder`: the new key. */
export interface ReorderGroup extends OnGroup {
  readonly orderKey: string;
}

/** A session a group's deletion takes out of it, with the event that does. */
export interface Ungrouping {
  readonly sessionId: string;
  readonly event: EventInput;
}

/**
 * What `groups.delete` decides: the group's own events and one ungrouping
 * per member, which the handler appends in the same transaction with the
 * group event as their causation; or its refusal.
 */
export type DeleteDecision =
  | { readonly events: readonly EventInput[]; readonly ungroupings: readonly Ungrouping[]; readonly rejected?: undefined }
  | { readonly rejected: Refusal };

const unchanged: Decision = { events: [] };

/** A group command's state, or the refusal when the group is not there: never created, or deleted. */
const present = (state: GroupState | null, groupId: string): GroupState | { readonly rejected: Refusal } =>
  state === null || state.deleted ? { rejected: groupNotFound(groupId) } : state;

/** The refusal of a name another group holds ignoring case: the name asked for, and the holder's as it is stored. */
const nameTaken = (name: string, holder: { readonly id: string; readonly name: string }): Decision => ({
  rejected: {
    code: "conflict",
    message: `The group ${holder.id} is named ${JSON.stringify(holder.name)}, which is ${JSON.stringify(name)} ignoring case.`,
    data: { reason: "name_taken", name, heldName: holder.name, groupId: holder.id },
  },
});

/**
 * Creates a group that has never existed, its name normalised. An id used
 * before, even by a group since deleted, is a conflict (`exists`); a name
 * another group holds ignoring case is a conflict (`name_taken`).
 */
export const decideCreateGroup = (state: GroupState | null, command: CreateGroup, context: NameContext): Decision => {
  if (state !== null) {
    return { rejected: { code: "conflict", message: `A group ${command.id} exists already.`, data: { reason: "exists", groupId: command.id } } };
  }
  const name = normaliseGroupName(command.name);
  if (context.nameHeldBy !== null) return nameTaken(name, context.nameHeldBy);
  const payload: GroupCreatedPayload = { name, orderKey: command.orderKey };
  return { events: [{ type: "group.created", payload }] };
};

/**
 * Renames the group, the name normalised. The name it has is unchanged; one
 * that differs only in case is a rename (its own name is no clash); a name
 * another group holds ignoring case is a conflict (`name_taken`).
 */
export const decideRenameGroup = (state: GroupState | null, command: RenameGroup, context: NameContext): Decision => {
  const group = present(state, command.groupId);
  if ("rejected" in group) return group;
  const name = normaliseGroupName(command.name);
  if (name === group.name) return unchanged;
  if (context.nameHeldBy !== null && context.nameHeldBy.id !== command.groupId) return nameTaken(name, context.nameHeldBy);
  const payload: GroupRenamedPayload = { name };
  return { events: [{ type: "group.renamed", payload }] };
};

/** Gives the group a new key; its own key is unchanged. */
export const decideReorderGroup = (state: GroupState | null, command: ReorderGroup): Decision => {
  const group = present(state, command.groupId);
  if ("rejected" in group) return group;
  if (group.orderKey === command.orderKey) return unchanged;
  const payload: GroupReorderedPayload = { orderKey: command.orderKey };
  return { events: [{ type: "group.reordered", payload }] };
};

/**
 * Deletes the group: `group.deleted`, and a `session.group-set` to null for
 * each of `members`, the sessions whose `groupId` is the group's, so no
 * session is left naming a group that is gone.
 */
export const decideDeleteGroup = (state: GroupState | null, command: OnGroup, members: readonly string[]): DeleteDecision => {
  const group = present(state, command.groupId);
  if ("rejected" in group) return group;
  const ungrouped: SessionGroupSetPayload = { groupId: null };
  return {
    events: [{ type: "group.deleted", payload: {} }],
    ungroupings: members.map((sessionId) => ({ sessionId, event: { type: "session.group-set", payload: ungrouped } })),
  };
};
