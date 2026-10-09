import { z } from "zod";
import { MessageId, QueueHolder, RunId, SendResponse } from "../adapter.js";
import { commandParams, defineMethod } from "../method.js";
import { Mode } from "../permissions-modes.js";
import { SessionId } from "../sessions.js";
import { AttachmentKind } from "../transcript.js";

/**
 * The run methods (claude-adapter spec, "Wire methods"; ADR 0022). Every one
 * is a command at `runs:drive`: it takes a `commandId` and answers with its
 * receipt. A run belongs to its session: a command on a session that is not
 * on this environment, deleted or purged, or on a run of one, is rejected
 * `not_found` (data `kind`: `session` or `run`, and `message` for a
 * withdraw of a message this environment does not hold queued). What the session's adapter
 * cannot do is `invalid_params` with data `reason: unsupported` and the
 * capability flag it lacks (the spec's `invalid_request`). Each method's
 * `errors` lists its own codes only (`method.ts`), and these have none: every
 * code they answer (`not_found`, `conflict`, `unavailable`, `invalid_params`,
 * `internal`) is shared, its `data` documented on the method.
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
 * session's (the effort to `accounts.defaultEffort` when the model takes it,
 * else the model's own: a session has none; `effort: null` asks for the
 * model's own whatever the default, #1950); the mode is
 * clamped to the client session's ceiling (and, for a run that reads queued
 * messages, each sender's) and the account's modes, the clamp recorded on
 * `run.started` and the whole policy on `run.policy.resolved`: a mode above
 * them is lowered, not refused. While a run is live it is rejected
 * `conflict` (reason `run_active`: `runs.send` is the way in); an account
 * that is not on this environment or not signed in is rejected `conflict`
 * (reason `account_unavailable`), and one with no mode available at or below
 * the ceiling `conflict` (reason `mode_unavailable`); while the environment
 * drains it is `unavailable`. The environment looks at the session's
 * workspace first (workspace-picker spec, "Missing workspaces"): while it is
 * missing, whether found gone now or marked so before, the start is
 * rejected `conflict` (reason `workspace_missing`, with its `path`) until
 * `sessions.setWorkspace` gives the session another; one found back clears
 * the mark and the run starts.
 */
export const runsStart = defineMethod({
  name: "runs.start",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({
    sessionId: SessionId,
    ...message,
    model: z.string().min(1).optional().meta({ description: "The model for this run; the session's when absent." }),
    effort: z.string().min(1).nullable().optional().meta({ description: "The reasoning effort for this run; null for the model's own; when absent, accounts.defaultEffort when the model takes it, else the model's own." }),
    mode: Mode.optional().meta({ description: "The mode for this run, clamped to the client session's ceiling and the account's modes; the session's when absent." }),
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
 * `message.delivered` when it is steered or read. While the session's
 * workspace is missing it is rejected `conflict` (reason
 * `workspace_missing`, with its `path`), as `runs.start` is.
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

/**
 * Reads the session's queue now (ADR 0022): a live run is interrupted, its
 * end `interrupted` with cause `read-now`; what its provider still held
 * returns to the environment's queue (`message.requeued`); and once the end
 * is recorded the next run starts with the environment's whole queue in the
 * order it was sent, its `run.started` naming the message ids it carries
 * and its mode clamped to the lowest ceiling among the queued messages'
 * senders and the caller. A read-now while an interrupt is under way waits
 * on it; a `runs.interrupt` after a read-now is the last word, and no run of
 * the queue starts. With no live run, the run of the queue starts in this
 * command's own transaction, on the model and effort of the run before it. With nothing queued the command is
 * accepted with no event, and a live run is left alone. It starts a run, so
 * while the environment drains it is `unavailable` when anything is queued;
 * with nothing queued it is the same no-op, accepted, draining or not.
 * While the session's workspace is missing it is rejected `conflict`
 * (reason `workspace_missing`, with its `path`), as `runs.start` is.
 */
export const runsReadNow = defineMethod({
  name: "runs.readNow",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({ sessionId: SessionId }),
  result: z.object({
    sessionId: SessionId,
    interruptedRunId: RunId.nullable().meta({
      description: "The live run interrupted to read the queue; its end and the next run.started follow on the session's stream. Null when no run was live.",
    }),
    runId: RunId.nullable().meta({
      description:
        "Null when a run was live (the run of the queue starts after the interrupted run's end; its run.started names it) and when nothing was queued; when no run was live, the run of the queue this command started in its own transaction.",
    }),
  }),
  errors: [],
});

/**
 * Takes one queued message back before any run reads it (ADR 0022): the
 * provider cancels it by id where it holds it, and the environment takes it
 * back into its queue at once (`message.requeued`), so no failure after the
 * cancel can lose it; then it leaves the environment's queue.
 * `message.withdrawn` is recorded and its text goes to the session's draft
 * (`session.draft-set`) in the same transaction: in place of an empty
 * draft, else after the draft, on a paragraph of its own; a draft with no
 * room for it (past 65,536 characters) is `conflict`, reason `draft_full`,
 * and the message stays queued. A provider with no way to take a message
 * back is `invalid_params`, reason `unsupported`.
 * Any client session with `runs:drive` may withdraw any queued message of a
 * session: the queue is the session's. A message steered, delivered or read
 * by a run, one withdrawn already, one the provider reports it has read,
 * and an unknown id are `not_found` (data `kind: message`).
 */
export const runsWithdraw = defineMethod({
  name: "runs.withdraw",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({ messageId: MessageId }),
  result: z.object({
    messageId: MessageId,
    sessionId: SessionId,
    heldBy: QueueHolder.meta({ description: "Who held the message when the withdraw began: the provider, which cancelled it, or the environment." }),
  }),
  errors: [],
});
