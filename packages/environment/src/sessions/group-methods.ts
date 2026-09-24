import { GROUP_STREAM_KIND, SESSION_STREAM_KIND, type Group } from "@agent-harness/contracts";
import type { EventInput, EventLog, StreamRef } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, MethodHandlers } from "../serve/methods.js";
import type { Decision, Refusal } from "./decider.js";
import {
  DELETED_GROUP,
  decideCreateGroup,
  decideDeleteGroup,
  decideRenameGroup,
  decideReorderGroup,
  groupNameKey,
  type GroupState,
} from "./group-decider.js";
import { groupWithNameKey, membersOf, readGroup, readGroupState } from "./group-reads.js";
import { listGroups, type Reader } from "./session-reads.js";

/**
 * The group handlers on the method table (session-state spec, "Group" and
 * "Commands"): each group command runs the group decider over the groups
 * table and appends what it decides through the command's transaction;
 * `groups.list` reads the table. `sessions.setGroup`, a session command, is
 * with the session handlers.
 */

export interface GroupMethodsOptions {
  readonly log: EventLog;
  /** The environment's clock, which stamps the group's events; preset: the system's. */
  readonly clock?: () => Date;
}

const groupStream = (id: string): StreamRef => ({ kind: GROUP_STREAM_KIND, id });
const sessionStream = (id: string): StreamRef => ({ kind: SESSION_STREAM_KIND, id });

/** Stamps every event with the command's one instant, so its `occurredAt` and the group's `updatedAt` agree. */
const stamped = (events: readonly EventInput[], at: string): EventInput[] => events.map((event) => ({ ...event, occurredAt: at }));

export const groupMethods = (options: GroupMethodsOptions): MethodHandlers => {
  const { log } = options;
  const clock = options.clock ?? (() => new Date());
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** The group's state for the decider. A group with no row but events on its stream was deleted: its id stays used. */
  const stateOf = (id: string): GroupState | null =>
    readGroupState(reader, id) ?? (log.readStream(groupStream(id), 0, 1).length > 0 ? DELETED_GROUP : null);

  /** The group a command leaves, read after it appended; a command is only answered for a group that is there. */
  const groupAfter = (id: string): Group => {
    const group = readGroup(reader, id);
    if (group === null) throw new Error(`The group ${id} is not in the list after a command applied to it.`);
    return group;
  };

  /**
   * Runs a command on one group: its id in lowercase, the decision over its
   * state, and the events appended with the command's id and actor at one
   * instant, so the projector writes the group and its patch before the
   * answer reads it.
   */
  const onGroup = (
    groupId: string,
    context: CommandContext,
    decide: (state: GroupState | null, id: string) => Decision,
  ): CommandAnswer<{ group: Group }, Refusal["code"]> => {
    const id = groupId.toLowerCase();
    const aggregate = groupStream(id);
    const decision = decide(stateOf(id), id);
    if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
    if (decision.events.length > 0) {
      log.append(aggregate, stamped(decision.events, clock().toISOString()), { tx: context.tx, actor: context.actor, commandId: context.commandId });
    }
    return { aggregate, result: { group: groupAfter(id) } };
  };

  /** Who holds `name` ignoring case, for the name rule. */
  const nameContext = (name: string) => ({ nameHeldBy: groupWithNameKey(reader, groupNameKey(name)) });

  return {
    "groups.create": (params, context) =>
      onGroup(params.id, context, (state, id) =>
        decideCreateGroup(state, { id, name: params.name, orderKey: params.orderKey ?? null }, nameContext(params.name)),
      ),

    "groups.rename": (params, context) =>
      onGroup(params.groupId, context, (state, groupId) => decideRenameGroup(state, { groupId, name: params.name }, nameContext(params.name))),

    "groups.reorder": (params, context) =>
      onGroup(params.groupId, context, (state, groupId) => decideReorderGroup(state, { groupId, orderKey: params.orderKey })),

    /**
     * Deletes the group and ungroups its members in the command's one
     * transaction: `group.deleted` first, then one `session.group-set` per
     * member naming it as their causation, all with the command's id and
     * actor and one instant, so the receipt's sequence covers every one.
     */
    "groups.delete": (params, context) => {
      const id = params.groupId.toLowerCase();
      const aggregate = groupStream(id);
      const decision = decideDeleteGroup(stateOf(id), { groupId: id }, membersOf(reader, id));
      if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
      const at = clock().toISOString();
      const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
      const [deleted] = log.append(aggregate, stamped(decision.events, at), attribution).events;
      if (deleted === undefined) throw new Error(`The deletion of the group ${id} appended no event.`);
      const cause = deleted.eventId;
      for (const { sessionId, event } of decision.ungroupings) {
        log.append(sessionStream(sessionId), stamped([event], at), { ...attribution, causationId: cause });
      }
      return { aggregate, result: { groupId: id } };
    },

    "groups.list": () => ({ groups: listGroups(reader) }),
  };
};
