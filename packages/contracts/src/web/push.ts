import { z } from "zod";
import { defineMethod } from "../method.js";
/** Only the public application server key crosses to the browser. */
export const attentionPushKey = defineMethod({ name: "attention.push.key", scope: "read", kind: "query", params: z.strictObject({}), result: z.object({ publicKey: z.string().min(1) }), errors: [] });
/** A visible user action sends a generic notification to this client's enabled registration. */
export const attentionPushTest = defineMethod({ name: "attention.push.test", scope: "read", kind: "query", params: z.strictObject({ id: z.string().min(1).max(100), sessionId: z.string().min(1).max(100) }), result: z.object({ status: z.enum(["sent", "retry", "retire"]).meta({ description: "Test delivery accepted by the gateway, failed and can be retried, or an expired registration retired." }) }), errors: [] });
export const webPushMethods = [attentionPushKey, attentionPushTest] as const;
