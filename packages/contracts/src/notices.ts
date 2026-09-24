import { z } from "zod";
import { AccountUpdatedPayload } from "./accounts.js";
import { ProtocolVersion } from "./flags.js";
import { DrainStarted } from "./lifecycle.js";

/**
 * The environment's own notices: the events on its `environment` stream,
 * which `environment.subscribe` delivers. The stream's id is the
 * environment's id. Each notice is read from an event's `type` and `payload`;
 * the rest of the envelope is the envelope's.
 */

/** The stream kind of the environment's notices; the stream id is the environment id. */
export const ENVIRONMENT_STREAM_KIND = "environment";

/**
 * The notices there are: the environment finished starting; it was updated
 * from one harness version to another (appended by the launcher ticket); it
 * began to drain (appended by the lifecycle ticket, #112); an account
 * changed (the account store, #134), appended once the change has committed.
 */
export const ENVIRONMENT_NOTICE_TYPES = ["environment.started", "environment.updated", "environment.draining", "account.updated"] as const;
export const EnvironmentNoticeType = z.enum(ENVIRONMENT_NOTICE_TYPES).meta({
  description:
    "An environment notice's event type: environment.started (startup finished), environment.updated (a new harness version now runs), environment.draining (new runs are refused before a restart), account.updated (an account changed; a client refreshes what it caches of the accounts).",
});
export type EnvironmentNoticeType = z.infer<typeof EnvironmentNoticeType>;

const EnvironmentStarted = z
  .object({
    type: z.literal("environment.started"),
    payload: z.object({
      harnessVersion: z.string().min(1).meta({ description: "The harness version that started." }),
      protocolVersion: ProtocolVersion,
    }),
  })
  .meta({ description: "The environment finished starting and accepts work: which version started." });

const EnvironmentUpdated = z
  .object({
    type: z.literal("environment.updated"),
    payload: z.object({
      fromVersion: z.string().min(1).meta({ description: "The harness version that ran before the update." }),
      toVersion: z.string().min(1).meta({ description: "The harness version the environment was updated to." }),
    }),
  })
  .meta({ description: "The environment now runs another harness version: from which, to which." });

const EnvironmentDraining = z
  .object({
    type: z.literal("environment.draining"),
    payload: DrainStarted,
  })
  .meta({ description: "The environment refuses new runs and lets running ones finish before a restart: since when, and what started it." });

const AccountUpdated = z
  .object({
    type: z.literal("account.updated"),
    payload: AccountUpdatedPayload,
  })
  .meta({ description: "An account changed: which, how, and a warning when something is wrong." });

/**
 * One environment notice, as an event's `type` and `payload`. Parsing an
 * event envelope with it reads the notice and leaves the envelope's other
 * fields aside, so a client parses the `event` of an `event` frame directly.
 */
export const EnvironmentNotice = z
  .discriminatedUnion("type", [EnvironmentStarted, EnvironmentUpdated, EnvironmentDraining, AccountUpdated])
  .meta({
    description:
      "An event on the environment stream, as environment.subscribe delivers it: its type and payload, read from the event's envelope.",
  });
export type EnvironmentNotice = z.infer<typeof EnvironmentNotice>;
