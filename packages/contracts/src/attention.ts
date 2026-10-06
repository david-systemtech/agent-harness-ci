import { z } from "zod";

/** Lock-screen delivery contains no session title, prompt, transcript or credentials. */
export const AttentionPayload = z.strictObject({
  message: z.literal("A session needs you"),
  url: z.url().regex(/^https:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::(?!443\/)[1-9][0-9]{0,4})?\/#\/session\/[^/?#]+\/[^/?#]+$/, "Use the canonical HTTPS session link."),
});
export type AttentionPayload = z.infer<typeof AttentionPayload>;

/** Transport-specific data stays in the environment and is never returned in status. */
export const AttentionTargetInput = z.strictObject({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200).optional().meta({ description: "A name for people, shown in place of the id; a push registration names its browser and when it was enabled." }),
  transport: z.enum(["webhook", "push"]).meta({ description: "Closed-client delivery transport: signed webhook or Web Push." }),
  enabled: z.boolean(),
  completion: z.boolean(),
  configuration: z.record(z.string().max(100), z.string().max(4096)).refine(value => Object.keys(value).length <= 16, "At most sixteen configuration fields.").meta({ maxProperties: 16 }),
});
export type AttentionTargetInput = z.infer<typeof AttentionTargetInput>;

export const AttentionTargetStatus = AttentionTargetInput.omit({ configuration: true }).extend({
  global: z.boolean(),
  state: z.enum(["disabled", "ready", "pending", "failed", "unavailable"]).meta({ description: "Disabled by choice, ready, delivery pending, a failed attempt, or a transport/HTTPS origin unavailable." }),
  failure: z.string().nullable(),
});
export type AttentionTargetStatus = z.infer<typeof AttentionTargetStatus>;
