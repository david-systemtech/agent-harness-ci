import { randomUUID } from "node:crypto";
import { GroupPatch, LIST_PATCH_KEY, type EventEnvelope, type Group, type ParamsOf } from "@agent-harness/contracts";
import { command } from "./sessions.js";
import type { WireClient } from "./wire-client.js";

/** What the group suites share: creating a group as a client does, `groups.list`, and the group patch a group event carries. */

type CreateGroupParams = Omit<ParamsOf<"groups.create">, "commandId" | "id"> & { id?: string; commandId?: string };

/** Sends `groups.create` for a fresh id (or the one given); resolves with the id and what its response carries. */
export const createGroup = async (client: WireClient, params: CreateGroupParams) => {
  const id = params.id ?? randomUUID();
  return { id, ...(await command(client, "groups.create", { ...params, id })) };
};

/** Every group `groups.list` answers, in its order. */
export const listGroups = async (client: WireClient): Promise<Group[]> => (await client.request("groups.list", {})).groups;

/** The group patch a group event carries in its metadata, checked against the contracts' schema. */
export const groupPatchOf = (event: EventEnvelope) => GroupPatch.parse(event.metadata[LIST_PATCH_KEY]);
