import { randomUUID } from "node:crypto";
import type { ParamsOf } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { MoveSource } from "../key-managers/moves.js";
import { runInProcess } from "../serve/in-process.js";
import type { PreparedCommand } from "../serve/methods.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import { listStoredEndpoints, storedEndpoint } from "./endpoint-store.js";

/** Endpoints own this Move source (#536): swap through their set command, then delete only an entry no pasted endpoint holds. */
export const createEndpointMoveSource = ({ log, reader, vault, set }: {
  readonly log: EventLog;
  readonly reader: Reader;
  readonly vault: Vault;
  readonly set: PreparedCommand<"routines.endpoints.set">;
}): MoveSource => ({
  kind: "endpoint",
  key: "secret",
  items: () => listStoredEndpoints(reader)
    .filter((endpoint) => endpoint.secretKind === "pasted")
    .map((endpoint) => ({
      id: endpoint.name,
      name: endpoint.name,
      entry: `endpoint-${endpoint.name}`,
      service: new URL(endpoint.url).host,
      note: `The signing secret of webhook endpoint ${endpoint.name}, moved here by agent-harness, which reads it for each delivery and test. To rotate it, replace this value and the receiver's secret together.`,
    })),
  async read(id) {
    if (storedEndpoint(reader, id)?.secretKind !== "pasted") return null;
    const storedAt = `endpoint:${id}`;
    const value = await vault.get(storedAt);
    return value === undefined ? null : { value, storedAt };
  },
  async swap(id, reference, caller) {
    const endpoint = storedEndpoint(reader, id);
    if (endpoint === null || endpoint.secretKind !== "pasted") return {
      outcome: "refused", error: { code: "not_found", message: `The webhook endpoint ${id} holds no pasted secret to move now.`, data: { kind: "endpoint", name: id } },
    };
    const params: ParamsOf<"routines.endpoints.set"> = { commandId: randomUUID(), name: id, url: endpoint.url, secret: { kind: "reference", reference } };
    const answer = await runInProcess(log, { caller, commandId: params.commandId }, async (context) => {
      const handler = await set.prepare(params, context);
      return (command) => handler(params, command);
    });
    return answer.outcome === "accepted" ? { outcome: "swapped" } : { outcome: "refused", error: answer.error };
  },
  async delete(id, storedAt) {
    if (storedAt !== `endpoint:${id}`) throw new Error(`${storedAt} is not a vault entry of webhook endpoint ${id}.`);
    if (storedEndpoint(reader, id)?.secretKind === "pasted") return;
    await vault.delete(storedAt);
  },
});
