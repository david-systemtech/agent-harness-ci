import { z } from "zod";
import {
  AccountIdentity,
  DelegatedWorkRow,
  MessageDelivery,
  MessageId,
  QueueHolder,
  RunId,
} from "./adapter.js";
import type { EventTypeEntry } from "./event-types.js";
import { SessionInstructions } from "./instructions.js";
import { Mode } from "./permissions-modes.js";
import { JsonObject, Sequence, Timestamp } from "./primitives.js";
import { ParkedPrompt, PromptAnsweredPayload, PromptOpenedPayload } from "./prompts.js";
import { Ceiling } from "./scopes.js";
import { SessionId, SessionSummary, SummaryPatch, Workspace } from "./sessions.js";
import { UpdateId } from "./updates.js";

/**
 * The transcript vocabulary (claude-adapter spec, "The transcript event
 * vocabulary"; ADR 0002, ADR 0015, ADR 0022): the events a run leaves on its
 * session's stream (stream kind `session`, stream id the session's id), and
 * the per-session snapshot `sessions.subscribeSession` sends. They live on
 * the session's stream, not a stream per run, so the purge that removes a
 * session's events removes its transcript with them (#118); every event of
 * a run carries the run's id in its payload, and its envelope's
 * `correlationId` is the run's id too.
 *
 * `run.started` and `run.ended` are `list`-flagged: they change the summary's
 * `activity`, `lastActivityAt`, `accountId` and `model`, and carry the patch.
 * Every other transcript type changes nothing a client lists, and is not.
 */

/**
 * Where a run came from: a client's `runs.start` or `runs.send`, a routine's
 * firing, the completions surface, a turn the provider opened itself, or the
 * turn that continues a run an update cut (launcher-update spec, "Interrupted
 * runs and parked prompts").
 */
export const RUN_ORIGINS = ["client", "routine", "completions", "provider", "update"] as const;
export const RunOrigin = z.enum(RUN_ORIGINS).meta({
  description:
    "Where a run came from: client (runs.start or runs.send, or the environment's queue after a client's run), routine, completions, provider (a turn the provider opened itself, adopted as a run), or update (the turn that continues a run an update cut, started as system:updates).",
});
export type RunOrigin = z.infer<typeof RunOrigin>;

/** Why a run ended. */
export const RUN_END_REASONS = ["completed", "error", "interrupted", "disposed", "drained"] as const;
export const RunEndReason = z.enum(RUN_END_REASONS).meta({
  description:
    "Why a run ended: completed, error, interrupted (with its cause), disposed (the environment let the run go: its session was deleted, or the environment closed), drained (cut by a drain's cap).",
});
export type RunEndReason = z.infer<typeof RunEndReason>;

/** What interrupted a run: a person, read-now, a restart, a process parked past the idle time, or a routine's firing past its maximum duration. */
export const INTERRUPT_CAUSES = ["user", "read-now", "restart", "parked", "timeout"] as const;
export const InterruptCause = z.enum(INTERRUPT_CAUSES).meta({
  description:
    "What interrupted a run: user (runs.interrupt), read-now, restart (the recovery sweep after a restart), parked (its process was stopped while parked on a prompt), timeout (a routine's firing ran past its maximum duration).",
});
export type InterruptCause = z.infer<typeof InterruptCause>;

/** The two kinds of attachment a message carries. */
export const ATTACHMENT_KINDS = ["image", "file"] as const;
export const AttachmentKind = z.enum(ATTACHMENT_KINDS).meta({
  description: "What an attachment is: an image (the adapter needs imageInput) or a file (fileInput).",
});
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/** An attachment as the log records it: what it was, never its bytes, which stay on the environment. */
export const AttachmentRecord = z
  .object({
    kind: AttachmentKind,
    name: z.string().min(1),
    mediaType: z.string().min(1).meta({ description: "Its media type: image/png." }),
    size: z.int().nonnegative().meta({ description: "Its size in bytes." }),
  })
  .meta({ description: "An attachment as the log records it: kind, name, media type and size; the bytes are never logged." });
export type AttachmentRecord = z.infer<typeof AttachmentRecord>;

/** A run's mode: what was asked for, what the run got after the ceiling's clamp, and whether it was clamped (ADR 0006). */
export const RunMode = z
  .object({
    requested: Mode.nullable().meta({ description: "The mode asked for, by the command or the session; null when neither names one, so a default applied." }),
    effective: Mode.meta({ description: "The mode the run got, after the clamp to the client session's ceiling and the account's modes." }),
    clamped: z.boolean().meta({ description: "Whether the clamp lowered the mode asked for; run.policy.resolved says why." }),
  })
  .meta({ description: "A run's mode: requested, effective after the ceiling's clamp, and whether it was clamped; run.policy.resolved has the rest." });
export type RunMode = z.infer<typeof RunMode>;

/** One model's token spend in a run, as the provider reports it. */
export const ModelUsage = z
  .object({
    model: z.string().min(1),
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    cacheReadTokens: z.int().nonnegative(),
    cacheWriteTokens: z.int().nonnegative(),
    costUsd: z.number().nonnegative().nullable().meta({ description: "What the tokens cost in US dollars, when the provider says." }),
    contextWindow: z.int().positive().nullable().meta({ description: "The model's context window in tokens, when the provider says." }),
  })
  .meta({ description: "One model's token spend in a run: input, output, cache reads and writes, cost and context window." });
export type ModelUsage = z.infer<typeof ModelUsage>;

/** An error a run ended with: a message for people and, when the provider gave one, its code. */
export const RunError = z
  .object({
    message: z.string().min(1),
    code: z.string().min(1).nullable().meta({ description: "The provider's or the environment's code for it, when there is one." }),
  })
  .meta({ description: "What went wrong in a run: a message and, when there is one, a code." });
export type RunError = z.infer<typeof RunError>;

const runPart = { runId: RunId };

/** Any JSON value, required where it appears: a tool's output as the provider gives it. */
const JsonValue = z
  .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), JsonObject])
  .meta({ description: "Any JSON value." });

export const RunStartedPayload = z
  .object({
    ...runPart,
    accountId: z.string().min(1).meta({ description: "The account the run is billed and authenticated through." }),
    identity: AccountIdentity.nullable().meta({ description: "Who the account is signed in as, when its status has been read." }),
    model: z.string().min(1),
    effort: z.string().min(1).nullable().meta({ description: "The reasoning effort asked for; null for the model's own." }),
    mode: RunMode,
    workspace: Workspace,
    origin: RunOrigin,
    promptMessageId: MessageId.nullable().meta({ description: "The message the run starts with; null for a run that starts with queued messages only." }),
    queuedMessageIds: z.array(MessageId).meta({
      description: "Queued messages the run reads as its prompt, in order: the environment's queue, or what a provider-opened turn opened with.",
    }),
    resumedFrom: z.string().min(1).nullable().meta({ description: "The provider's session id the run resumes; null for a fresh one." }),
    forkedFrom: SessionId.nullable().meta({ description: "The session the run's session was forked from, on a fork's first run; else null." }),
  })
  .meta({ description: "run.started: a run of the session started; its startedAt is the event's occurredAt." });
export type RunStartedPayload = z.infer<typeof RunStartedPayload>;

export const RunEndedPayload = z
  .object({
    ...runPart,
    reason: RunEndReason,
    cause: InterruptCause.nullable().meta({ description: "What interrupted the run, when its reason is interrupted; else null." }),
    error: RunError.nullable().meta({ description: "What went wrong, when the reason is error; else null." }),
    usage: z.array(ModelUsage).nullable().meta({ description: "The run's token spend per model, when the provider reported it." }),
    durationMs: z.int().nonnegative().meta({ description: "From run.started to run.ended, on the environment's clock." }),
    turnCount: z.int().nonnegative().nullable().meta({ description: "The provider's turns in the run, when it says." }),
    resultText: z.string().nullable().meta({ description: "The run's final answer as the provider reports it, when it does." }),
  })
  .meta({ description: "run.ended: the run ended, once, on every path; its endedAt is the event's occurredAt." });
export type RunEndedPayload = z.infer<typeof RunEndedPayload>;

export const MessageSentPayload = z
  .object({
    ...runPart,
    messageId: MessageId,
    text: z.string(),
    attachments: z.array(AttachmentRecord),
    delivery: MessageDelivery.exclude(["steered"]).meta({
      description: "prompt: the message starts the run; queued: a run was live, so it waits to be steered or read (message.delivered).",
    }),
    heldBy: QueueHolder.nullable().meta({ description: "Who holds a queued message; null for a prompt." }),
    ceiling: Ceiling.meta({
      description:
        "The ceiling of the client session that sent it (ADR 0006): a run the environment later starts with it is clamped to it, as well as to the ceiling of whoever started that run.",
    }),
  })
  .meta({ description: "message.sent: a client sent the session a message; runId is the run it starts, or the run live when it was queued." });
export type MessageSentPayload = z.infer<typeof MessageSentPayload>;

export const MessageDeliveredPayload = z
  .object({
    ...runPart,
    messageId: MessageId,
    delivery: MessageDelivery.exclude(["queued"]).meta({
      description: "steered: the provider folded it into the running turn; prompt: a turn that opened with it read it.",
    }),
  })
  .meta({ description: "message.delivered: a queued message was read, by the run runId names." });
export type MessageDeliveredPayload = z.infer<typeof MessageDeliveredPayload>;

export const MessageRequeuedPayload = z
  .object({ ...runPart, messageId: MessageId })
  .meta({
    description:
      "message.requeued: a message of the run came back to the environment's queue, which holds it now, in its original order (ADR 0022: nothing is lost): the provider still held it when an interrupt or any end but the adapter's own completion cut the run, the provider refused to take it, the host did not adopt the turn the provider opened with it, or the run's adapter never received it (its creation failed).",
  });
export type MessageRequeuedPayload = z.infer<typeof MessageRequeuedPayload>;

export const MessageWithdrawnPayload = z
  .object({
    ...runPart,
    messageId: MessageId,
    heldBy: QueueHolder.meta({
      description:
        "Who held it when the withdraw began: the provider, which cancelled it by id (the environment then took it back into its queue at once, message.requeued, before this event), or the environment.",
    }),
  })
  .meta({
    description:
      "message.withdrawn: a queued message was taken back before any run read it (runs.withdraw, ADR 0022); runId is the run it was sent during. No run reads it after this; its text went to the session's draft in the same transaction (session.draft-set), and its attachments are dropped.",
  });
export type MessageWithdrawnPayload = z.infer<typeof MessageWithdrawnPayload>;

/** Which stream of the open assistant item a fragment extends. */
export const DELTA_KINDS = ["text", "thinking"] as const;
const DeltaKind = z.enum(DELTA_KINDS).meta({ description: "What a fragment extends: the open item's text, or its thinking." });

export const AssistantDeltaPayload = z
  .object({
    ...runPart,
    itemId: z.string().min(1).meta({ description: "The open item the fragments extend; its assistant.text or assistant.thinking closes it." }),
    fragments: z.array(z.object({ kind: DeltaKind, text: z.string() }).meta({ description: "One fragment of text or thinking." })).min(1),
  })
  .meta({
    description:
      "assistant.delta: a batch of fragments for the open item, flushed every 100 ms or 512 bytes; the snapshot holds settled items only, and a client applies deltas to the open item.",
  });
export type AssistantDeltaPayload = z.infer<typeof AssistantDeltaPayload>;

const settledItem = (type: string, what: string) =>
  z
    .object({
      ...runPart,
      itemId: z.string().min(1),
      text: z.string(),
      aborted: z.boolean().meta({ description: "True when an interrupt cut the item short; its partial text stays (ADR 0022)." }),
    })
    .meta({ description: `${type}: the assistant's ${what} for the item, settled; it closes the open item.` });

export const AssistantTextPayload = settledItem("assistant.text", "text");
export type AssistantTextPayload = z.infer<typeof AssistantTextPayload>;
export const AssistantThinkingPayload = settledItem("assistant.thinking", "thinking");
export type AssistantThinkingPayload = z.infer<typeof AssistantThinkingPayload>;

const toolCallPart = { toolCallId: z.string().min(1).meta({ description: "The provider's id for the tool call." }) };

export const ToolStartedPayload = z
  .object({
    ...runPart,
    ...toolCallPart,
    name: z.string().min(1),
    input: JsonObject.meta({ description: "The tool's input as the model gave it." }),
    title: z.string().nullable().meta({ description: "A one-line title for the call, when the adapter makes one." }),
    agentId: z.string().min(1).nullable().meta({ description: "The subagent making the call; null for the run's own agent." }),
    parentToolCallId: z.string().min(1).nullable().meta({ description: "The tool call it is nested under; null at the top." }),
  })
  .meta({ description: "tool.started: the model called a tool." });
export type ToolStartedPayload = z.infer<typeof ToolStartedPayload>;

export const ToolUpdatedPayload = z
  .object({ ...runPart, ...toolCallPart, update: JsonObject.meta({ description: "What the call reports while it runs; the latest replaces the one before." }) })
  .meta({ description: "tool.updated: a running tool call reported progress." });
export type ToolUpdatedPayload = z.infer<typeof ToolUpdatedPayload>;

/** How a tool call ended. */
export const TOOL_STATUSES = ["ok", "error", "cancelled"] as const;
export const ToolStatus = z.enum(TOOL_STATUSES).meta({ description: "How a tool call ended: ok, error, or cancelled." });
export type ToolStatus = z.infer<typeof ToolStatus>;

export const ToolEndedPayload = z
  .object({
    ...runPart,
    ...toolCallPart,
    status: ToolStatus,
    output: JsonValue.meta({ description: "The tool's result as the provider reports it, any JSON value." }),
    durationMs: z.int().nonnegative().nullable(),
  })
  .meta({ description: "tool.ended: a tool call finished." });
export type ToolEndedPayload = z.infer<typeof ToolEndedPayload>;

export const CommandRanPayload = z
  .object({
    ...runPart,
    name: z.string().min(1).meta({ description: "The slash command, without its slash." }),
    args: z.string(),
    output: z.string().nullable(),
  })
  .meta({ description: "command.ran: a slash command ran in the run." });
export type CommandRanPayload = z.infer<typeof CommandRanPayload>;

export const TasksChangedPayload = z
  .object({ ...runPart, tasks: z.array(DelegatedWorkRow).meta({ description: "The whole ledger after the change, settled rows included: replace, never merge." }) })
  .meta({ description: "tasks.changed: the run's delegated-work ledger changed." });
export type TasksChangedPayload = z.infer<typeof TasksChangedPayload>;

export const UsageReportedPayload = z
  .object({ ...runPart, models: z.array(ModelUsage).min(1) })
  .meta({ description: "usage.reported: the run's token spend so far, per model." });
export type UsageReportedPayload = z.infer<typeof UsageReportedPayload>;

/** A plan window's verdict, as a rate-limit report gives it. */
export const PLAN_LIMIT_STATUSES = ["allowed", "warning", "rejected"] as const;
const PlanLimitStatus = z.enum(PLAN_LIMIT_STATUSES).meta({
  description: "A plan window's verdict: allowed, warning (near the limit), or rejected (over it until the reset).",
});

export const PlanLimitPayload = z
  .object({
    ...runPart,
    window: z.string().min(1).meta({ description: "The plan window, in the provider's words: five_hour, seven_day." }),
    status: PlanLimitStatus,
    utilisation: z.number().min(0).nullable().meta({ description: "How much of the window is used, 0 to 1 and beyond, when the provider says." }),
    resetsAt: Timestamp.nullable(),
  })
  .meta({ description: "plan.limit: the provider reported a rate-limit verdict for a plan window." });
export type PlanLimitPayload = z.infer<typeof PlanLimitPayload>;

export const SessionProviderLinkedPayload = z
  .object({ ...runPart, providerSessionId: z.string().min(1).meta({ description: "The provider session's own id, which a resume hands back." }) })
  .meta({ description: "session.provider-linked: the provider named its session for this one, on the run's first init." });
export type SessionProviderLinkedPayload = z.infer<typeof SessionProviderLinkedPayload>;

export const SessionForkedPayload = z
  .object({
    fromSessionId: SessionId,
    atMessageId: MessageId.nullable().meta({
      description:
        "The user message the fork was taken before, or null for a fork of the whole session, except in two cases. A source no run of which had linked a provider session but which carried one in as a fork itself: what its own session.forked named (a message, or null), whichever message the fork was taken before, since nothing the source was sent reached the provider; the text of the message it was taken before is still the fork's draft. A fork of the whole of a source that had linked one and holds a rewind not yet continued from: the rewind's message, since that provider session still holds what the rewind hid.",
    }),
    fromProviderSessionId: z
      .string()
      .min(1)
      .nullable()
      .meta({
        description:
          "The provider session the fork's first run continues: the one the source had linked when forked; or, for a source no run of which had linked one, the one its own session.forked named when it was itself a fork, whichever message the fork was taken before, since nothing the source was sent reached the provider. Null when the source had neither, or when the fork was taken before the first message of a source that had linked one but carried none in as a fork itself, since nothing of the provider's precedes that message; the fork then starts fresh.",
      }),
  })
  .meta({ description: "session.forked: the session was forked from another; on the new session's stream." });
export type SessionForkedPayload = z.infer<typeof SessionForkedPayload>;

export const SessionRewoundPayload = z
  .object({ toMessageId: MessageId.meta({ description: "The user message the session was rewound to; it and every item after it are hidden." }) })
  .meta({ description: "session.rewound: the session was rewound; later items stay in the log and the snapshot hides them until a session.rewind-undone names this rewind." });
export type SessionRewoundPayload = z.infer<typeof SessionRewoundPayload>;

export const SessionRewindUndonePayload = z
  .object({
    toMessageId: MessageId.meta({ description: "The user message the undone rewind went back to; it and the items the rewind hid are shown again." }),
    rewindSequence: Sequence.meta({ description: "The sequence of the session.rewound this undoes: the session's latest rewind not already undone." }),
  })
  .meta({
    description:
      "session.rewind-undone: a rewind was taken back (sessions.undoRewind, ADR 0022) before any run started on the session after it; the items it hid are shown again, and the next run continues the provider session as it was before the rewind, or from an earlier rewind still standing.",
  });
export type SessionRewindUndonePayload = z.infer<typeof SessionRewindUndonePayload>;

/**
 * What became of a run an update cut (launcher-update spec, "Interrupted runs
 * and parked prompts"): one run continued it, a prompt of its session is
 * still parked (answering it resumes the session; continuation never answers
 * a prompt), or it waits for the session's next message.
 */
export const UPDATE_INTERRUPT_OUTCOMES = ["continued", "waiting-on-prompt", "next-message"] as const;
export const UpdateInterruptOutcome = z.enum(UPDATE_INTERRUPT_OUTCOMES).meta({
  description:
    "What became of a run an update cut: continued (one run, origin update, resumed it), waiting-on-prompt (a prompt of the session is still parked, and answering it resumes the session) or next-message (it goes on when the session is next sent a message, for the reason given).",
});
export type UpdateInterruptOutcome = z.infer<typeof UpdateInterruptOutcome>;

/** Why a run an update cut was not continued on its own, and waits for the session's next message. */
export const UPDATE_INTERRUPT_REASONS = ["no-resume", "account", "mode", "workspace", "deleted", "completions"] as const;
export const UpdateInterruptReason = z.enum(UPDATE_INTERRUPT_REASONS).meta({
  description:
    "Why a run an update cut was not continued on its own: no-resume (its adapter cannot resume, or no provider session was linked), account (the session's account is another now, or signed out), mode (the mode resolved now differs from the run's), workspace (the workspace is gone), deleted (the session is deleted) or completions (the caller was answered 503 drained and owns the retry).",
});
export type UpdateInterruptReason = z.infer<typeof UpdateInterruptReason>;

const interruptedPart = {
  ...runPart,
  updateId: UpdateId,
  toVersion: z.string().min(1).meta({ description: "The version the update that cut the run went to." }),
};

export const RunUpdateInterruptedPayload = z
  .discriminatedUnion("outcome", [
    z
      .object({
        ...interruptedPart,
        outcome: z.literal("continued"),
        reason: z.null(),
        continuationRunId: RunId.meta({ description: "The run that continued it, as system:updates with the origin update." }),
      })
      .meta({ description: "The run was continued by one run of its own session, which resumed its provider session." }),
    z
      .object({ ...interruptedPart, outcome: z.literal("waiting-on-prompt"), reason: z.null(), continuationRunId: z.null() })
      .meta({ description: "A prompt of the session is still parked: answering it resumes the session." }),
    z
      .object({ ...interruptedPart, outcome: z.literal("next-message"), reason: UpdateInterruptReason, continuationRunId: z.null() })
      .meta({ description: "The run goes on when the session is next sent a message: why it did not on its own." }),
  ])
  .meta({
    description:
      "run.update-interrupted: an update cut the run (it ended drained after the update began); which update, the version it went to, and what became of the run, once per run whatever the update's outcome.",
  });
export type RunUpdateInterruptedPayload = z.infer<typeof RunUpdateInterruptedPayload>;

const unlisted = <const P extends z.ZodType>(payload: P) => ({ list: false, payload }) as const;

/**
 * The transcript types of the `session` stream, each with its payload. The
 * run's start and end are `list`-flagged with the summary patch; the rest
 * are not. The event-type table joins them to the session types
 * (`event-types.ts`).
 */
export const TRANSCRIPT_EVENT_TYPES = {
  "run.started": { list: true, payload: RunStartedPayload, patch: SummaryPatch },
  "message.sent": unlisted(MessageSentPayload),
  "message.delivered": unlisted(MessageDeliveredPayload),
  "message.requeued": unlisted(MessageRequeuedPayload),
  "message.withdrawn": unlisted(MessageWithdrawnPayload),
  "assistant.delta": unlisted(AssistantDeltaPayload),
  "assistant.text": unlisted(AssistantTextPayload),
  "assistant.thinking": unlisted(AssistantThinkingPayload),
  "tool.started": unlisted(ToolStartedPayload),
  "tool.updated": unlisted(ToolUpdatedPayload),
  "tool.ended": unlisted(ToolEndedPayload),
  "command.ran": unlisted(CommandRanPayload),
  "tasks.changed": unlisted(TasksChangedPayload),
  "usage.reported": unlisted(UsageReportedPayload),
  "plan.limit": unlisted(PlanLimitPayload),
  "session.provider-linked": unlisted(SessionProviderLinkedPayload),
  "session.forked": unlisted(SessionForkedPayload),
  "session.rewound": unlisted(SessionRewoundPayload),
  "session.rewind-undone": unlisted(SessionRewindUndonePayload),
  "run.ended": { list: true, payload: RunEndedPayload, patch: SummaryPatch },
  // The settle after an update marks each run the update cut (#335; the launcher-update spec), on the run's session.
  "run.update-interrupted": unlisted(RunUpdateInterruptedPayload),
} as const satisfies Record<string, EventTypeEntry>;

export type TranscriptEventType = keyof typeof TRANSCRIPT_EVENT_TYPES;

/** The transcript types, in the table's order: what compaction (#123) folds, and nothing of the organisation types. */
export const TRANSCRIPT_EVENT_TYPE_NAMES = Object.keys(TRANSCRIPT_EVENT_TYPES) as readonly TranscriptEventType[];

/** The payload of each transcript type, for code that appends or reads one. */
export type TranscriptPayload<T extends TranscriptEventType> = z.infer<(typeof TRANSCRIPT_EVENT_TYPES)[T]["payload"]>;

// The per-session snapshot.

/** Where a run is: running, or ended. */
export const RUN_STATES = ["running", "ended"] as const;
export const RunState = z.enum(RUN_STATES).meta({ description: "Where a run is: running (started, not ended) or ended." });

/** One run of a session, as the snapshot folds its run.started, usage.reported and run.ended. */
export const RunSummary = z
  .object({
    runId: RunId,
    state: RunState,
    origin: RunOrigin,
    accountId: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1).nullable(),
    mode: RunMode,
    promptMessageId: MessageId.nullable(),
    queuedMessageIds: z.array(MessageId),
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
    reason: RunEndReason.nullable(),
    cause: InterruptCause.nullable(),
    error: RunError.nullable(),
    usage: z.array(ModelUsage).nullable().meta({ description: "The latest token spend per model: run.ended's, else the last usage.reported." }),
    durationMs: z.int().nonnegative().nullable(),
  })
  .meta({ description: "One run of a session: its state, where it came from, its account, model, effort and mode, and how it ended." });
export type RunSummary = z.infer<typeof RunSummary>;

const itemPart = { sequence: Sequence.min(1).meta({ description: "The sequence of the event that opened the item." }) };

const UserMessageItem = z
  .object({
    kind: z.literal("user-message"),
    ...itemPart,
    runId: RunId,
    messageId: MessageId,
    text: z.string(),
    attachments: z.array(AttachmentRecord),
    delivery: MessageDelivery,
    heldBy: QueueHolder.nullable().meta({ description: "Who holds it while it is queued; null once it is read." }),
    sentAt: Timestamp,
  })
  .meta({ description: "A message a client sent: its text, attachments and where it went." });

const assistantItem = <const K extends string>(kind: K, what: string) =>
  z
    .object({ kind: z.literal(kind), ...itemPart, runId: RunId, itemId: z.string().min(1), text: z.string(), aborted: z.boolean() })
    .meta({ description: `The assistant's ${what}, settled.` });

const ToolCallItem = z
  .object({
    kind: z.literal("tool-call"),
    ...itemPart,
    runId: RunId,
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    input: JsonObject,
    title: z.string().nullable(),
    agentId: z.string().min(1).nullable(),
    parentToolCallId: z.string().min(1).nullable(),
    status: z.enum(["running", ...TOOL_STATUSES]).meta({ description: "running until tool.ended, then how it ended: ok, error or cancelled." }),
    update: JsonObject.nullable().meta({ description: "The latest tool.updated, folded in; null before any." }),
    output: JsonValue.meta({ description: "The tool's result once it ended; null before." }),
    durationMs: z.int().nonnegative().nullable(),
  })
  .meta({ description: "A tool call with its updates folded in and, once it ended, its status and output." });

const CommandItem = z
  .object({ kind: z.literal("command"), ...itemPart, runId: RunId, name: z.string().min(1), args: z.string(), output: z.string().nullable() })
  .meta({ description: "A slash command that ran." });

const TasksItem = z
  .object({ kind: z.literal("tasks"), ...itemPart, runId: RunId, tasks: z.array(DelegatedWorkRow) })
  .meta({ description: "A run's delegated-work ledger as it stands, at the place its first tasks.changed came." });

const PromptItem = z
  .object({
    kind: z.literal("prompt"),
    ...itemPart,
    runId: RunId,
    promptId: z.string().min(1),
    prompt: PromptOpenedPayload,
    answer: PromptAnsweredPayload.nullable().meta({ description: "Its prompt.answered once it has one; null while it is parked." }),
  })
  .meta({ description: "A prompt, where it was asked: what it asked and, once answered, its answer and who gave it." });

/** The item kinds this version of the contracts knows; an item of one of them is held to its schema, never kept opaque. */
export const KNOWN_ITEM_KINDS = ["user-message", "assistant-text", "assistant-thinking", "tool-call", "command", "tasks", "prompt"] as const;

/**
 * An item of a kind this version of the contracts does not know (ADR 0001):
 * a client keeps it as it is and shows it opaque, never failing on it. The
 * environment folds an event of a type it does not know into one of kind
 * `opaque`, naming the type.
 */
const OpaqueItem = z
  .looseObject({
    kind: z
      .string()
      .regex(new RegExp(`^(?!(?:${KNOWN_ITEM_KINDS.join("|")})$).+$`))
      .meta({ description: `Any kind but the known ones (${KNOWN_ITEM_KINDS.join(", ")}), which must match their own schema.` }),
    sequence: Sequence.min(1),
  })
  .meta({ description: "An item of a kind the reader does not know: kept as it is and shown opaque (ADR 0001); kind opaque names an unknown event type." });

/** One settled item of a session's transcript, in the order it came; unknown kinds are opaque. */
export const TranscriptItem = z
  .union([
    UserMessageItem,
    assistantItem("assistant-text", "text"),
    assistantItem("assistant-thinking", "thinking"),
    ToolCallItem,
    CommandItem,
    TasksItem,
    PromptItem,
    OpaqueItem,
  ])
  .meta({
    description:
      "One settled item of a transcript: a user message, assistant text or thinking, a tool call, a command, a run's delegated work, a prompt with its answer, or an item of a kind the reader does not know, kept opaque.",
  });
export type TranscriptItem = z.infer<typeof TranscriptItem>;

/**
 * A rewind still standing on a session (ADR 0022; #260): not undone, whether
 * or not a run has started since. It carries what it hid, the message rewound
 * to and every item after it at the time, so a client that opens from a
 * snapshot draws the rewound fold, the strip and the undo as one that heard
 * `session.rewound` does. A rewind stacked before it (standing, not undone)
 * whose hidden part it cut with the rest is nested in its `rewinds`; each
 * hidden item is in exactly one rewind's `items`, the innermost that hid it.
 * In a rewind's `items` and `rewinds` together, as in the snapshot's own,
 * the order is by sequence: an item's is where it was opened, a rewind's is
 * its `session.rewound`'s, where the branch was cut.
 */
export interface StandingRewind {
  sequence: number;
  toMessageId: string;
  text: string;
  undoable: boolean;
  items: TranscriptItem[];
  rewinds: StandingRewind[];
}
export const StandingRewind = z
  .object({
    sequence: Sequence.min(1).meta({ description: "The sequence of its session.rewound: where the branch was cut, and what session.rewind-undone names." }),
    toMessageId: MessageId.meta({ description: "The user message rewound to: the first item it hid." }),
    text: z.string().meta({ description: "That message's text, which the rewind put in the draft." }),
    undoable: z.boolean().meta({
      description: "No run has started on the session since the rewind, so sessions.undoRewind can still bring back what it hid; only the latest rewind standing is undone, then the one before it.",
    }),
    items: z.array(TranscriptItem).meta({ description: "The settled items it hid, in order, as they stand now; those a rewind nested in it hid are that rewind's." }),
    get rewinds(): z.ZodArray<z.ZodType<StandingRewind>> {
      return z.array(StandingRewind).meta({ description: "The rewinds standing before it whose hidden part it cut with the rest, oldest first: rewinds stacked with no undo between them nest, the latest outermost." });
    },
  })
  .meta({
    // The recursion needs a named definition: the id makes the JSON Schema export write it once under `$defs` and `$ref` it.
    id: "StandingRewind",
    description:
      "A rewind standing on a session, not undone: its sequence, the message rewound to and its text, whether it can still be undone, and what it hid, a rewind before it that it cut nested in it.",
  });

/**
 * What `sessions.subscribeSession` sends when replay from the cursor is out
 * of bounds, or when the cursor is older than the session's compaction
 * (#123), whose fold it then stands in for: the session at `sequence`, its
 * summary, its runs, the settled items of its transcript (deltas are
 * applied by the client to the open item), the prompts parked on it, and
 * the rewinds standing on it with what each hid (#260).
 */
export const SessionSnapshot = z
  .object({
    sequence: Sequence.meta({
      description:
        "Where the snapshot stands: the log's head it was read at; or, for a compacted session replayed from a cursor older than its compaction, the sequence of the last event the compaction folded, the events after it replayed next. The summary is always read at the head.",
    }),
    summary: SessionSummary,
    runs: z.array(RunSummary).meta({ description: "Every run of the session, oldest first." }),
    items: z.array(TranscriptItem).meta({ description: "The settled items of the transcript, in order; items a rewind hid are left out, carried by that rewind in rewinds until it is undone." }),
    parkedPrompts: z.array(ParkedPrompt).meta({ description: "The prompts parked on the session, oldest first." }),
    // Defaults to none: an environment from before #260 sends no rewinds, and its snapshot reads as one with no rewind standing,
    // which is what it showed then, rather than failing to open the session (claude-adapter spec, #260's notes).
    rewinds: z
      .array(StandingRewind)
      .default([])
      .meta({
        description:
          "The rewinds standing on the session (not undone) that no later rewind cut, oldest first, each with what it hid; one a later rewind cut is nested in it. Each sits among items at its own sequence, where its branch was cut; the latest standing is the one sessions.undoRewind undoes. Absent from an environment older than the field, read as none.",
      }),
    // Defaults to none: an environment from before #506 has no session instructions to send.
    instructions: SessionInstructions.default("").meta({
      description:
        "The session's own instructions (sessions.setInstructions), read at the head as the summary is; empty when it has none. Its next runs are handed them. Absent from an environment older than the field, read as none.",
    }),
  })
  .meta({ description: "One session at a sequence: its summary, its runs, the settled items of its transcript, its parked prompts, the rewinds standing on it, and its own instructions." });
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;
