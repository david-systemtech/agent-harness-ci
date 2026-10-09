import { invalidParams, type AttentionTargetInput } from "@agent-harness/contracts";
import type { CommandContext, MethodHandlers } from "../serve/methods.js";
import { attentionStream, type AttentionStore } from "./store.js";
import type { RoutineEndpoints } from "../routines/endpoints.js";
import type { AttentionTransports } from "./targets.js";

/** Own registrations always derive their owner from the authenticated connection. */
export const attentionMethods = (store: AttentionStore, transports: AttentionTransports, configured: () => boolean, endpoints: RoutineEndpoints): MethodHandlers => {
  const set = (target: AttentionTargetInput, context: CommandContext, global: boolean) => {
    const owner = global ? null : context.clientSession.id;
    const existing = store.targets().find(row => row.target.id === target.id);
    if (existing && existing.owner !== owner) return { aggregate: attentionStream, rejected: { code: "forbidden" as const, message: "This target belongs to another registration." } };
    if (global && !context.clientSession.scopes.includes("admin")) return { aggregate: attentionStream, rejected: { code: "forbidden" as const } };
    const problem = transports[target.transport]?.validate(target);
    if (problem) return { aggregate: attentionStream, rejected: invalidParams([{ code: "custom", path: ["target", "configuration"], message: problem }], problem) };
    return { aggregate: attentionStream, result: { id: target.id }, events: [{ type: "attention.target.set", payload: { target, owner } }] };
  };
  const remove = (id: string, context: CommandContext, global: boolean) => {
    const existing = store.targets().find(row => row.target.id === id);
    if (!existing) return { aggregate: attentionStream, result: { id } };
    if (existing.owner !== (global ? null : context.clientSession.id) || (global && !context.clientSession.scopes.includes("admin"))) {
      return { aggregate: attentionStream, rejected: { code: "forbidden" as const, message: "This target belongs to another registration." } };
    }
    const name = existing.target.transport === "webhook" ? existing.target.configuration["endpoint"] : undefined;
    const endpoint = global && typeof name === "string" ? endpoints.removeUnused(name, id, context) : undefined;
    return { aggregate: attentionStream, result: { id, ...(endpoint && { endpoint }) }, events: [{ type: "attention.target.removed", payload: { id } }] };
  };
  const configure = (id: string, enabled: boolean, completion: boolean, context: CommandContext, global: boolean) => {
    const existing = store.targets().find(row => row.target.id === id);
    if (!existing) return { aggregate: attentionStream, rejected: { code: "not_found" as const } };
    return set({ ...existing.target, enabled, completion }, context, global);
  };
  return {
    "attention.targets.list": (_params, context) => ({ targets: store.status(transport => configured() && !!transports[transport]).filter(row => row.owner === null || row.owner === context.clientSession.id).map(({ owner, ...status }) => { void owner; return status; }) }),
    "attention.targets.configure": ({ id, enabled, completion }, context) => configure(id, enabled, completion, context, false),
    "attention.routes.configure": ({ id, enabled, completion }, context) => configure(id, enabled, completion, context, true),
    "attention.targets.set": ({ target }, context) => set(target, context, false),
    "attention.targets.remove": ({ id }, context) => remove(id, context, false),
    "attention.routes.set": ({ target }, context) => set(target, context, true),
    "attention.routes.remove": ({ id }, context) => remove(id, context, true),
  };
};
