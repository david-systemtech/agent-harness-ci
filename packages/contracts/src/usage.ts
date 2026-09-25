import { z } from "zod";
import { AccountId } from "./accounts.js";
import { AccountIdentity } from "./adapter.js";
import { Timestamp } from "./primitives.js";
import { PLAN_LIMIT_STATUSES } from "./transcript.js";

/**
 * Plan usage and the hand-off recommendation (claude-adapter spec, "Plan
 * usage" and "Wire methods"; ADR 0005, ADR 0018): what `accounts.usage`
 * answers per account, the `usage.updated` notice, and what
 * `accounts.handoff.recommend` answers. A reading carries its account's
 * identity so a client pools the readings of one login on several
 * environments into one gauge (client-runtime spec, `projections.usage`).
 * Utilisation is a fraction throughout: 0 is none of the window used, 1 all
 * of it, and a provider may report beyond 1.
 */

/** A plan window's verdict: the latest rate-limit report a run of the account gave for it. */
export const UsageVerdict = z.enum(PLAN_LIMIT_STATUSES).meta({
  description:
    "The latest rate-limit verdict a run of the account reported for the window (plan.limit): allowed, warning (near the limit) or rejected (refused until the reset, whatever the utilisation reads).",
});
export type UsageVerdict = z.infer<typeof UsageVerdict>;

/** One plan window of an account's reading. */
export const UsageWindow = z
  .object({
    window: z.string().min(1).meta({ description: "The window, in the provider's words: five_hour, seven_day, model_scoped:<model>, extra_usage." }),
    utilisation: z.number().min(0).nullable().meta({ description: "How much of the window is used, 0 to 1 and beyond; null when the provider does not say." }),
    resetsAt: Timestamp.nullable().meta({ description: "When the window rolls over; null when the provider does not say." }),
    verdict: UsageVerdict.nullable().meta({ description: "The latest verdict a run reported for the window, folded in after the read; null when none has been heard since." }),
    observedAt: Timestamp.meta({
      description:
        "When this window's numbers were observed: the reading's readAt, or the instant of a run's report folded into it since, which is never before readAt. What a client pooling two readings of one identity compares per window.",
    }),
  })
  .meta({ description: "One plan window of an account's reading: how much is used, when it resets, and the latest verdict a run reported for it." });
export type UsageWindow = z.infer<typeof UsageWindow>;

/** One account's plan usage, as `accounts.usage` answers it. */
export const AccountUsage = z
  .object({
    accountId: AccountId,
    identity: AccountIdentity.nullable().meta({
      description: "Who the account is signed in as, which a client pools readings by across environments; null when it has never been read.",
    }),
    windows: z.array(UsageWindow).meta({ description: "The plan's windows, in the provider's order; empty when the reading is unavailable." }),
    readAt: Timestamp.meta({
      description:
        "When the provider was read for this reading; when the provider's own stamp was in the future or already six minutes old, when the environment was handed it. A reading is read again once it is six minutes old.",
    }),
    unavailableReason: z
      .string()
      .min(1)
      .nullable()
      .meta({
        description:
          "Why the reading has no windows, when it has none: the adapter reports no plan usage, the account is not signed in, the read failed, or the provider reported no limits (an API-key login). A client shows the reason in place of a gauge. Null on a reading with windows.",
      }),
  })
  .meta({ description: "One account's plan usage: its identity, its windows, when it was read, and why it has no windows when it has none." });
export type AccountUsage = z.infer<typeof AccountUsage>;

/** The `usage.updated` notice's payload. */
export const UsageUpdatedPayload = z
  .object({
    accountId: AccountId,
    identity: AccountIdentity.nullable().meta({ description: "Who the account is signed in as, the gauge a client pools the reading into; null when not known." }),
  })
  .meta({
    description:
      "usage.updated: an account's plan-usage reading changed (its windows, a verdict a run reported, its identity or why it is unavailable); a client refreshes what it caches of accounts.usage and asks accounts.handoff.recommend again.",
  });
export type UsageUpdatedPayload = z.infer<typeof UsageUpdatedPayload>;

/** Why `accounts.handoff.recommend` answered as it did. */
export const HANDOFF_REASONS = ["limit-reached", "limit-near", "most-room", "no-target"] as const;
export const HandoffReason = z.enum(HANDOFF_REASONS).meta({
  description:
    "Why the recommendation is what it is: limit-reached (the account handed from has a window the provider is refusing, and accountId has room), limit-near (it has met a hand-off threshold, and accountId has room), most-room (accountId has the most room, and the account handed from, if any, has met no threshold), or no-target (no account with a fresh reading has room to take the work, since a full or refused account is never named; accountId is null).",
});
export type HandoffReason = z.infer<typeof HandoffReason>;

/** What a recommendation could compare accounts on. */
export const HANDOFF_BASES = ["same-plan", "weighted", "percentage"] as const;
export const HandoffBasis = z.enum(HANDOFF_BASES).meta({
  description:
    "What the ranking compared: same-plan (every candidate is on one plan, so the shares describe one ceiling), weighted (the plans differ and each publishes its size against its provider's baseline), or percentage (shares of plans that cannot be compared by size; a client says so rather than claim capacity).",
});
export type HandoffBasis = z.infer<typeof HandoffBasis>;

/** The hand-off threshold the account handed from has met. */
export const HandoffTrigger = z
  .object({
    threshold: z.string().min(1).meta({ description: "The threshold's key: five_hour, seven_day, fable." }),
    label: z.string().min(1).meta({ description: "The window as a sentence names it: 5-hour, weekly, Fable." }),
    at: z.number().min(0).meta({ description: "The utilisation, 0 to 1, at or above which the work should be handed on." }),
    window: z.string().min(1).meta({ description: "The account's window that met it." }),
    utilisation: z.number().min(0).meta({ description: "The window's utilisation, rounded to a whole percent; 1 for a refused window that reported none." }),
    verdict: UsageVerdict.nullable().meta({ description: "The window's verdict: rejected when the provider is refusing, whatever the threshold." }),
  })
  .meta({ description: "The hand-off threshold the account handed from has met: which, on what window, and how full it reads." });
export type HandoffTrigger = z.infer<typeof HandoffTrigger>;

/** What `accounts.handoff.recommend` answers: one offer, the same for every client asking. */
export const HandoffRecommendation = z
  .object({
    accountId: AccountId.nullable().meta({ description: "The account to hand the work to: the one with the most room; null when none can take it." }),
    reason: HandoffReason,
    message: z.string().min(1).meta({ description: "The recommendation in a sentence, the same in every client." }),
    fromAccountId: AccountId.nullable().meta({ description: "The account the work is handed from, as asked; null when the question was only which account has the most room." }),
    trigger: HandoffTrigger.nullable().meta({ description: "The threshold the account handed from has met; null when it has met none, or none was named." }),
    headroom: z.number().nullable().meta({
      description:
        "The recommended account's room in its tightest window: 1 less that window's utilisation, so at most 1, and above 0 for any account recommended (a provider may report utilisation beyond 1, which leaves an account below 0 and never recommended); null with no recommendation.",
    }),
    binding: z.string().min(1).nullable().meta({ description: "The recommended account's tightest window, the one that sets its room; null with no recommendation." }),
    candidates: z.int().nonnegative().meta({ description: "How many accounts the recommendation was chosen from." }),
    basis: HandoffBasis.nullable().meta({ description: "What the ranking compared; null with no recommendation." }),
  })
  .meta({
    description:
      "The hand-off recommendation, answered from the environment's cached readings so every client asking shows the same offer: the account with the most room, or none, why, and the threshold the account handed from has met.",
  });
export type HandoffRecommendation = z.infer<typeof HandoffRecommendation>;
