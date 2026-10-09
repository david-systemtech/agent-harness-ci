import { z } from "zod";
import { AttentionTargetInput, AttentionTargetStatus } from "../attention.js";
import { EndpointName } from "../routines.js";
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
/** Removes the route and its webhook endpoint when no routine or other attention target names it. */
export const attentionRoutesRemove = defineMethod({
  name: "attention.routes.remove", scope: "admin", kind: "command", params: commandParams({ id: z.string().min(1).max(100) }),
  result: z.object({
    id: z.string(),
    endpoint: z.object({
      name: EndpointName,
      state: z.enum(["removed", "retained", "missing"]).meta({ description: "Removed with this route, retained for another user, or already missing." }),
      secretKind: z.enum(["pasted", "reference", "missing"]).optional().meta({ description: "The credential removed with the endpoint: a saved signing secret, an external key-manager reference, or no credential. Absent when the endpoint was retained or already missing." }),
    }).optional()
      .meta({ description: "The webhook endpoint's removal outcome; retained means a routine or another attention target still names it. No secret is returned." }),
  }), errors: [],
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
