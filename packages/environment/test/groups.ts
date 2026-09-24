import { randomUUID } from "node:crypto";
import { GroupPatch, LIST_PATCH_KEY, registry, type EventEnvelope, type Group, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import type { WireClient } from "./wire-client.js";

/**
 * What the group suites share: sending the group commands as a client does,
 * `groups.list`, and the group patch a group event carries.
 */

/** The group commands, by name. */
export type GroupCommand = "groups.create" | "groups.rename" | "groups.reorder" | "groups.delete";

type GroupCommandParams<N extends GroupCommand> = Omit<ParamsOf<N>, "commandId"> & { commandId?: string };

/** Sends a group command with a fresh command id (unless one is given); resolves with what its response carries, checked against its schema. */
export const groupCommand = async <N extends GroupCommand>(client: WireClient, method: N, params: GroupCommandParams<N>): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

type CreateGroupParams = Omit<GroupCommandParams<"groups.create">, "id"> & { id?: string };

/** Sends `groups.create` for a fresh id (or the one given); resolves with the id and what its response carries. */
export const createGroup = async (client: WireClient, params: CreateGroupParams) => {
  const id = params.id ?? randomUUID();
  return { id, ...(await groupCommand(client, "groups.create", { ...params, id })) };
};

/** Every group `groups.list` answers, in its order. */
export const listGroups = async (client: WireClient): Promise<Group[]> => (await client.request("groups.list", {})).groups;

/** The group patch a group event carries in its metadata, checked against the contracts' schema. */
export const groupPatchOf = (event: EventEnvelope) => GroupPatch.parse(event.metadata[LIST_PATCH_KEY]);
