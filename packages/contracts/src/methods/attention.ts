import { z } from "zod";
import { AttentionTargetInput, AttentionTargetStatus } from "../attention.js";
import { commandParams, defineMethod } from "../method.js";

export const attentionTargetsList = defineMethod({
  name: "attention.targets.list", scope: "read", kind: "query", params: z.strictObject({}),
  result: z.object({ targets: z.array(AttentionTargetStatus) }), errors: [],
});
export const attentionTargetsSet = defineMethod({
  name: "attention.targets.set", scope: "read", kind: "command", params: commandParams({ target: AttentionTargetInput }),
  result: z.object({ id: z.string() }), errors: [],
});
export const attentionTargetsRemove = defineMethod({
  name: "attention.targets.remove", scope: "read", kind: "command", params: commandParams({ id: z.string().min(1).max(100) }),
  result: z.object({ id: z.string() }), errors: [],
});
export const attentionRoutesSet = defineMethod({
  name: "attention.routes.set", scope: "admin", kind: "command", params: commandParams({ target: AttentionTargetInput }),
  result: z.object({ id: z.string() }), errors: [],
});
export const attentionRoutesRemove = defineMethod({
  name: "attention.routes.remove", scope: "admin", kind: "command", params: commandParams({ id: z.string().min(1).max(100) }),
  result: z.object({ id: z.string() }), errors: [],
});
/** Change delivery preferences without exposing or overwriting transport registration data. */
export const attentionTargetsConfigure = defineMethod({
  name: "attention.targets.configure", scope: "read", kind: "command", params: commandParams({ id: z.string().min(1).max(100), enabled: z.boolean(), completion: z.boolean() }),
  result: z.object({ id: z.string() }), errors: [],
});
export const attentionRoutesConfigure = defineMethod({
  name: "attention.routes.configure", scope: "admin", kind: "command", params: commandParams({ id: z.string().min(1).max(100), enabled: z.boolean(), completion: z.boolean() }),
  result: z.object({ id: z.string() }), errors: [],
});
