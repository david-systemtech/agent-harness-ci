import { z } from "zod";
import { ErrorCode, WireError } from "./errors.js";
import { Sequence } from "./primitives.js";

/**
 * What the environment answers a command with, beside its result: the
 * receipt it stored under the calling actor and the command's id, in the
 * same transaction as the command's events. A retry with the same id gets
 * the same receipt back and applies nothing; the client's outbox retires a
 * command on it, accepted or rejected.
 */
export const CommandReceipt = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("accepted"),
      sequence: Sequence.meta({
        description: "The log's head once the command committed: its last event, or the head it saw when it appended none.",
      }),
      changed: z.boolean().meta({ description: "False for a command that was accepted and changed nothing, so appended no event." }),
    }),
    z.object({
      status: z.literal("rejected"),
      sequence: Sequence.meta({ description: "The log's head when the command was rejected." }),
      changed: z.literal(false),
      reason: ErrorCode.meta({ description: "Why the command was rejected: not_found when its target does not exist." }),
      error: WireError.meta({ description: "The rejection as an error: a code, a message for people and structured data." }),
    }),
  ])
  .meta({
    description:
      "A command's receipt: accepted (with the head sequence after it and whether it changed anything) or rejected (with the reason and the error). A retry with the same commandId answers the same receipt.",
  });
export type CommandReceipt = z.infer<typeof CommandReceipt>;

/**
 * What a command's `response` carries as its `result`: the receipt, and the
 * method's own result when this request applied the command. A retry answered
 * from the stored receipt, and a rejection, carry the receipt alone, since
 * results are not stored (a pairing code never is).
 */
export const commandResponse = <const R extends z.ZodObject>(result: R) =>
  z.object({
    receipt: CommandReceipt,
    result: result.optional().meta({
      description: "The method's result, present when this request applied the command; absent on a retry and on a rejection.",
    }),
  });

/** The schema of a command's response, for its result schema `R`. */
export type CommandResponseSchema<R extends z.ZodObject> = ReturnType<typeof commandResponse<R>>;
