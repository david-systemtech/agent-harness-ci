import type { GroupCreatedPayload, GroupRenamedPayload, GroupReorderedPayload, SessionGroupSetPayload } from "@agent-harness/contracts";
import type { EventInput } from "../event-log/event-log.js";
import { groupNotFound, sessionNotFound, type Decision, type Refusal, type SessionState } from "./decider.js";

/**
 * The group aggregate's decider (session-state spec, "Group" and
 * "Commands"), and the one session command that names a group,
 * `sessions.setGroup`: pure, as the session decider is. A group's name is
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

/** A group's name as it is kept: trimmed, every run of white space one space. */
export const normaliseGroupName = (name: string): string => name.trim().replace(/\s+/g, " ");

/** What a group's name is unique on: the kept name, lowercased; the groups table holds it as `name_key`. */
export const groupNameKey = (name: string): string => normaliseGroupName(name).toLowerCase();

/** Facts about the other groups a name depends on: which group holds a name ignoring case. */
export interface NameContext {
  /** The id of the group whose name has the command's name key, or null when none has. */
  readonly nameHeldBy: string | null;
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

/** The refusal of a name another group holds ignoring case. */
const nameTaken = (name: string, heldBy: string): Decision => ({
  rejected: {
    code: "conflict",
    message: `The group ${heldBy} is named ${JSON.stringify(name)} already, ignoring case.`,
    data: { reason: "name_taken", name, groupId: heldBy },
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
  if (context.nameHeldBy !== null && context.nameHeldBy !== command.groupId) return nameTaken(name, context.nameHeldBy);
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

/** `sessions.setGroup`: the group, in lowercase, or null for none. */
export interface SetGroup {
  readonly sessionId: string;
  readonly groupId: string | null;
}

/** Facts about the group `sessions.setGroup` names. */
export interface SetGroupContext {
  /** Whether the group the command names is on this environment (and not deleted). */
  readonly groupExists: boolean;
}

/**
 * Puts the session in the group, or takes it out of any with null. A
 * session not there is not found (kind `session`), then a group not there
 * is not found (kind `group`); the group the session is in already is unchanged.
 */
export const decideSetGroup = (state: SessionState | null, command: SetGroup, context: SetGroupContext): Decision => {
  if (state === null || state.deleted) return { rejected: sessionNotFound(command.sessionId) };
  if (command.groupId !== null && !context.groupExists) return { rejected: groupNotFound(command.groupId) };
  if (state.groupId === command.groupId) return unchanged;
  const payload: SessionGroupSetPayload = { groupId: command.groupId };
  return { events: [{ type: "session.group-set", payload }] };
};
