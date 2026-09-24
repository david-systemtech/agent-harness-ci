import { z } from "zod";
import { MessageId, RunId, SendResponse } from "../adapter.js";
import { commandParams, defineMethod } from "../method.js";
import { SessionId } from "../sessions.js";
import { AttachmentKind } from "../transcript.js";

/**
 * The run methods (claude-adapter spec, "Wire methods"; ADR 0022). Every one
 * is a command at `runs:drive`: it takes a `commandId` and answers with its
 * receipt. A run belongs to its session: a command on a session that is not
 * on this environment, deleted or purged, or on a run of one, is rejected
 * `not_found` (data `kind`: `session` or `run`). What the session's adapter
 * cannot do is `invalid_params` with data `reason: unsupported` and the
 * capability flag it lacks (the spec's `invalid_request`).
 */

/** The largest attachment a message carries, in bytes before encoding. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** How many bytes a padded base64 string decodes to. */
const decodedLength = (data: string): number => (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/**
 * An attachment as a client sends it: what it is, and its bytes in base64.
 * The environment keeps the bytes for the run and logs only the kind, name,
 * media type and size.
 */
export const AttachmentInput = z
  .object({
    kind: AttachmentKind,
    name: z.string().min(1).max(255),
    mediaType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/i).meta({ description: "Its media type: image/png." }),
    // Standard base64 with its padding: whole groups of four, the last ending in = or == when the bytes do not fill it.
    // The export publishes that grammar as one pattern; zod checks it as a flat pattern and the length rule, since the
    // grammar's repeated group overflows a backtracking engine's stack on a 20 MiB string.
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
      .refine((data) => data.length % 4 === 0, { message: "Base64 comes in whole groups of four characters, padded with =." })
      .refine((data) => decodedLength(data) <= MAX_ATTACHMENT_BYTES, { message: `An attachment is at most ${MAX_ATTACHMENT_BYTES} bytes.` })
      .meta({
        pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
        description: `Its bytes, in standard padded base64, at most ${MAX_ATTACHMENT_BYTES} bytes decoded (the maxLength bounds it within two bytes; the environment checks the decoded size); the log never holds them.`,
      }),
  })
  .meta({ description: "An attachment as a client sends it: kind, name, media type and its bytes in base64." });
export type AttachmentInput = z.infer<typeof AttachmentInput>;

/** A message as a client sends it: its text and any attachments. */
const message = {
  text: z.string().min(1).meta({ description: "The message's text." }),
  attachments: z.array(AttachmentInput).max(20).optional().meta({ description: "Images or files sent with the text; none when absent." }),
};

/**
 * Starts a run on the session with `text` as its prompt. The account and
 * workspace are the session's, and the model and mode default to the
 * session's (the effort to the model's own: a session has none); the mode is clamped to the connection's ceiling and the clamp
 * recorded on `run.started`. While a run is live it is rejected `conflict`
 * (reason `run_active`: `runs.send` is the way in); an account that is not on
 * this environment or not signed in is rejected `conflict` (reason
 * `account_unavailable`); while the environment drains it is `unavailable`.
 */
export const runsStart = defineMethod({
  name: "runs.start",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({
    sessionId: SessionId,
    ...message,
    model: z.string().min(1).optional().meta({ description: "The model for this run; the session's when absent." }),
    effort: z.string().min(1).optional().meta({ description: "The reasoning effort for this run; the model's own when absent." }),
    mode: z.string().min(1).optional().meta({ description: "The mode for this run, clamped to the connection's ceiling; the session's when absent." }),
  }),
  result: z.object({ runId: RunId, messageId: MessageId }),
  errors: [],
});

/**
 * Sends the session a message. With no run live it starts one, as
 * `runs.start` would, and says `prompt`; during a live run it is queued and
 * the answer says who holds it: the provider, which steers it into the turn
 * if it can, or the environment, which starts the next run with it when the
 * turn ends (ADR 0022). `message.sent` records it either way, and
 * `message.delivered` when it is steered or read.
 */
export const runsSend = defineMethod({
  name: "runs.send",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({ sessionId: SessionId, ...message }),
  result: SendResponse,
  errors: [],
});

/**
 * Interrupts a live run: its end, `interrupted` with cause `user`, follows
 * on the session's stream, and any message the provider still held returns
 * to the environment's queue (`message.requeued`). On a run that has ended it
 * changes nothing and answers `ended: true`.
 */
export const runsInterrupt = defineMethod({
  name: "runs.interrupt",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({ runId: RunId }),
  result: z.object({
    runId: RunId,
    ended: z.boolean().meta({ description: "True when the run had ended already, so nothing was interrupted." }),
    unrecorded: z
      .literal(true)
      .optional()
      .meta({ description: "Present when the run ended here but its run.ended could not be appended; the recovery sweep at the next start records it." }),
  }),
  errors: [],
});

/**
 * Stops one piece of a live run's delegated work (`tasks.changed` names its
 * `taskId`); needs the adapter's `subagents` capability. On a run that has
 * ended, or a task that has settled, it changes nothing and answers
 * `ended: true`.
 */
export const runsStopTask = defineMethod({
  name: "runs.stopTask",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({ runId: RunId, taskId: z.string().min(1) }),
  result: z.object({
    runId: RunId,
    taskId: z.string().min(1),
    ended: z.boolean().meta({ description: "True when the run or the task had ended already, so nothing was stopped." }),
  }),
  errors: [],
});
