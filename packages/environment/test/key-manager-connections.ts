import { randomUUID } from "node:crypto";
import type { EventEnvelope, EventFrame, KeyManagerConnectionRecord, ParamsOf, ResponseOf, ResultOf } from "@agent-harness/contracts";
import type { WireClient } from "./wire-client.js";

/**
 * What the key-manager connection suites share (#365): the connection
 * methods sent as a client sends them, the credentials a test signs in
 * with, and the key-manager events a client reads. Every secret is an
 * obviously fake string.
 */

export const ROLE_ID = "role-id-for-tests";
export const SECRET_ID = "secret-id-for-tests";
export const OTHER_SECRET_ID = "another-approle-secret-for-tests";
export const PASSWORD = "password-for-tests";
export const PERSON_TOKEN = "person-token-for-tests";
export const ROOT_TOKEN = "root-token-for-tests";

export const approle = (secretId = SECRET_ID) => ({ method: "approle", roleId: ROLE_ID, secretId }) as const;
export const userpass = (password = PASSWORD) => ({ method: "userpass", password }) as const;
export const token = (value = PERSON_TOKEN) => ({ method: "token", token: value }) as const;

export type AddParams = Omit<ParamsOf<"keyManagers.connections.add">, "commandId" | "connectionId" | "provider" | "label"> &
  Partial<Pick<ParamsOf<"keyManagers.connections.add">, "connectionId" | "provider" | "label">>;

/** Sends `keyManagers.connections.add` with a fresh command id and connection id unless given, an OpenBao provider and a label. */
export const add = (client: WireClient, params: AddParams): Promise<ResponseOf<"keyManagers.connections.add">> =>
  client.request("keyManagers.connections.add", { commandId: randomUUID(), connectionId: randomUUID(), provider: "openbao", label: "OpenBao", ...params });

/** The connection an add made; throws unless the add was accepted. */
export const added = async (client: WireClient, params: AddParams): Promise<KeyManagerConnectionRecord> => {
  const answer = await add(client, params);
  if (answer.result === undefined) throw new Error(`keyManagers.connections.add was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.connection;
};

export const signIn = (client: WireClient, params: Omit<ParamsOf<"keyManagers.connections.signIn">, "commandId">): Promise<ResponseOf<"keyManagers.connections.signIn">> =>
  client.request("keyManagers.connections.signIn", { commandId: randomUUID(), ...params });

export const update = (client: WireClient, params: Omit<ParamsOf<"keyManagers.connections.update">, "commandId">): Promise<ResponseOf<"keyManagers.connections.update">> =>
  client.request("keyManagers.connections.update", { commandId: randomUUID(), ...params });

export const signOut = (client: WireClient, connectionId: string): Promise<ResponseOf<"keyManagers.connections.signOut">> =>
  client.request("keyManagers.connections.signOut", { commandId: randomUUID(), connectionId });

export const remove = (client: WireClient, connectionId: string): Promise<ResponseOf<"keyManagers.connections.remove">> =>
  client.request("keyManagers.connections.remove", { commandId: randomUUID(), connectionId });

export const setPolicies = (client: WireClient, connectionId: string, ticks: readonly string[]): Promise<ResponseOf<"keyManagers.connections.setPolicies">> =>
  client.request("keyManagers.connections.setPolicies", { commandId: randomUUID(), connectionId, ticks: [...ticks] });

export const setBasePath = (client: WireClient, connectionId: string, basePath: string): Promise<ResponseOf<"keyManagers.connections.setBasePath">> =>
  client.request("keyManagers.connections.setBasePath", { commandId: randomUUID(), connectionId, basePath });

/** Sends `keyManagers.connections.setInjected` for the connection (#368). */
export const setInjected = (client: WireClient, connectionId: string): Promise<ResponseOf<"keyManagers.connections.setInjected">> =>
  client.request("keyManagers.connections.setInjected", { commandId: randomUUID(), connectionId });

export const list = async (client: WireClient): Promise<KeyManagerConnectionRecord[]> => (await client.request("keyManagers.list", {})).connections;

/** `keyManagers.move.list`: the items holding a stored value, with their targets (#371). */
export const moveList = async (client: WireClient): Promise<ResultOf<"keyManagers.move.list">["items"]> => (await client.request("keyManagers.move.list", {})).items;

/** Sends `keyManagers.move` for `items` (preset all) to the connection, with a fresh command id (#371); with `verifyOnly` (#372) it writes nothing. */
export const move = (client: WireClient, params: Omit<ParamsOf<"keyManagers.move">, "commandId" | "items"> & Partial<Pick<ParamsOf<"keyManagers.move">, "items">>): Promise<ResponseOf<"keyManagers.move">> =>
  client.request("keyManagers.move", { commandId: randomUUID(), items: "all", ...params });

/** Sends `keyManagers.move.copyValue` for one item on the connection, with a fresh command id unless given (#372). */
export const copyValue = (
  client: WireClient,
  params: Omit<ParamsOf<"keyManagers.move.copyValue">, "commandId"> & Partial<Pick<ParamsOf<"keyManagers.move.copyValue">, "commandId">>,
): Promise<ResponseOf<"keyManagers.move.copyValue">> => client.request("keyManagers.move.copyValue", { commandId: randomUUID(), ...params });

/** `keyManagers.connections.verify` of one connection, or every one: the records it answers. */
export const verify = async (client: WireClient, connectionId?: string): Promise<KeyManagerConnectionRecord[]> =>
  (await client.request("keyManagers.connections.verify", connectionId === undefined ? {} : { connectionId })).connections;

/** `keyManagers.certificate.preview` of `address`. */
export const preview = (client: WireClient, address: string): Promise<ResultOf<"keyManagers.certificate.preview">> => client.request("keyManagers.certificate.preview", { address });

/** The key-manager events a client reads on `environment.subscribe` after `afterSequence`, up to where it is synchronized. */
export const keyManagerEvents = async (client: WireClient, afterSequence: number): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  const events: EventEnvelope[] = [];
  for (;;) {
    const frame = await client.next((f) => "subscription" in f && f.subscription === subscription && (f.type === "event" || f.type === "synchronized"));
    if (frame.type === "synchronized") return events.filter((event) => event.type.startsWith("key-manager."));
    events.push((frame as EventFrame).event);
  }
};
