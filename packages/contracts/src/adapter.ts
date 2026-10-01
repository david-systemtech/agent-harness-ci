import { z } from "zod";
import { ModeAvailability } from "./permissions-modes.js";
import { Timestamp } from "./primitives.js";
import { NativeSkillRoot } from "./skill-rules.js";

/**
 * The adapter contract's transport-neutral half (claude-adapter spec, "The
 * adapter contract"; ADR 0015): what an adapter declares about itself (its
 * capabilities descriptor and credential spec), the ids a run and a message
 * go by, an account's identity, and three further types (the run suggestion,
 * the send response and the delegated-work row), as schemas any client can
 * read. The live interface an adapter implements is the environment's
 * (`adapter/contract.ts`); it never crosses the wire.
 */

/** A run's id: a version 4 UUID the environment mints when it starts or adopts the run. */
export const RunId = z.uuidv4().meta({ description: "A run's id: a version 4 UUID the environment mints when the run starts or is adopted." });
export type RunId = z.infer<typeof RunId>;

/** A message's id: a version 4 UUID the environment mints when a client sends it; the provider is handed this id. */
export const MessageId = z.uuidv4().meta({
  description: "A user message's id: a version 4 UUID the environment mints when a client sends it, and the id the provider is handed.",
});
export type MessageId = z.infer<typeof MessageId>;

/** A provider's id: which adapter, as the adapter registry keys it (`claude`). */
export const ProviderId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .meta({ description: "A provider's id, as the environment's adapter registry keys it: lowercase letters, digits and hyphens (claude)." });
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * An account's identity (ADR 0018): the provider and the login the account
 * signed in as, its email and its organisation when there is one. Plan usage
 * is pooled by it across environments (ADR 0005).
 */
export const AccountIdentity = z
  .object({
    provider: ProviderId,
    email: z.string().min(1).meta({ description: "The login's email, as the provider's status reports it." }),
    organisation: z.string().min(1).nullable().meta({ description: "The organisation the login belongs to, when the provider reports one." }),
  })
  .meta({ description: "Who an account signed in as: the provider, the email and the organisation when present; one account per identity per environment." });
export type AccountIdentity = z.infer<typeof AccountIdentity>;

/**
 * How an adapter delivers standing instructions and always-on skills to its
 * provider (ADR 0009): Claude's system-prompt append, Codex's developer
 * instructions, a local model's prompt, or no channel at all.
 */
export const INSTRUCTION_CHANNEL_KINDS = ["system-prompt-append", "developer-instructions", "prompt", "none"] as const;
export const InstructionChannelKind = z.enum(INSTRUCTION_CHANNEL_KINDS).meta({
  description:
    "How an adapter delivers standing instructions to its provider: system-prompt-append (Claude), developer-instructions (Codex), prompt (a local model), or none.",
});
export type InstructionChannelKind = z.infer<typeof InstructionChannelKind>;

export const InstructionChannel = z
  .object({
    kind: InstructionChannelKind,
    maxCharacters: z.int().positive().nullable().meta({ description: "The most characters the channel carries; null when it has no cap." }),
  })
  .meta({ description: "An adapter's instruction channel: its kind and its character cap." });
export type InstructionChannel = z.infer<typeof InstructionChannel>;

/**
 * The capability flags, one per optional power of the contract. Every
 * optional method of an adapter pairs with one; the environment refuses a
 * call the flag does not cover.
 */
export const CAPABILITY_FLAGS = [
  "interactivePrompts",
  "partialMessages",
  "providerQueue",
  "withdraw",
  "steering",
  "resume",
  "fork",
  "rewind",
  "sessionListing",
  "subagents",
  "subagentTranscripts",
  "titleRead",
  "titleWrite",
  "transcriptDelete",
  "planUsage",
  "liveModels",
  "commands",
  "imageInput",
  "fileInput",
  "modeChange",
  "containment",
] as const;
export type AdapterCapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
export const AdapterCapabilityFlag = z.enum(CAPABILITY_FLAGS).meta({
  description:
    "One optional power of the adapter contract: interactivePrompts, partialMessages, providerQueue (the provider holds messages sent during a turn), withdraw (it can take back a message its provider holds), steering (it folds one into the running turn), resume, fork, rewind, sessionListing, subagents (delegated work it can stop), subagentTranscripts, titleRead, titleWrite, transcriptDelete, planUsage, liveModels, commands, imageInput, fileInput, modeChange (a live run's mode can be changed), containment (the adapter enforces a run's containment level through its provider's sandbox).",
});

const flag = (description: string) => z.boolean().meta({ description });

/**
 * What an adapter can do, static for its life (claude-adapter spec, "The
 * adapter contract"; ADR 0022 for the queue): a flag per optional power, its
 * instruction channel, whether it loads a trusted repository's own
 * instructions itself (#500) and which of the repository's skill roots
 * (#495), and the modes it maps. A client degrades absent-with-reason on a
 * flag that is false (ADR 0004).
 */
export const AdapterCapabilities = z
  .object({
    provider: ProviderId,
    displayName: z.string().min(1).meta({ description: "The provider's name as a client shows it: Claude." }),
    interactivePrompts: flag("A run can stop and ask a permission prompt or a question, answered from any client."),
    partialMessages: flag("A run streams assistant.delta fragments; without it only the settled items arrive."),
    providerQueue: flag(
      "The provider holds messages sent during a turn; without it the environment holds them and starts the next run with them when the turn ends.",
    ),
    withdraw: flag("The adapter can take back a queued message its provider holds, by id; messages the environment holds can always be withdrawn."),
    steering: flag("The provider folds a queued message into the running turn at its next boundary; presupposes providerQueue."),
    resume: flag("A session's next run resumes the provider's own session."),
    fork: flag("A session can be forked, from its end or from a user message."),
    rewind: flag("A session can be rewound to a user message."),
    sessionListing: flag("The provider's sessions in an account's directory can be listed, and a listed session's history read."),
    subagents: flag("A run delegates work to subagents and background tasks, reported by tasks.changed and stopped by runs.stopTask."),
    subagentTranscripts: flag("A subagent's own transcript can be read on demand."),
    titleRead: flag("The provider generates a session title the environment can read."),
    titleWrite: flag("A user title can be mirrored into the provider's own title field."),
    transcriptDelete: flag("The provider's transcript of a session can be deleted when the session is purged."),
    planUsage: flag("Plan usage can be read per window, with the account's identity."),
    liveModels: flag("The provider's models are listed live; without it the catalogue is the adapter's static list."),
    commands: flag("The provider's slash commands can be listed for an account and workspace without spending tokens."),
    imageInput: flag("A message can carry image attachments."),
    fileInput: flag("A message can carry file attachments."),
    modeChange: flag("A live run's mode can be changed (permissions.mode.set); without it a new mode applies at the session's next run."),
    containment: flag(
      "The adapter enforces a run's containment level through its provider's sandbox (#133, #140); without it only off is available to the runs of its accounts.",
    ),
    instructionChannel: InstructionChannel,
    nativeProjectInstructions: flag(
      "The provider loads a trusted repository's own instruction files itself (Claude: CLAUDE.md through its project settings); without it the composer hands it the repository's AGENTS.md, else CLAUDE.md, in the project layer.",
    ),
    nativeSkillRoots: z.array(NativeSkillRoot).meta({
      description:
        "The roots of a trusted repository the provider loads skills or commands from itself (Claude: .claude/skills and .claude/commands, through its project settings): a member there is native, left out of the generation and hidden, when switched off, the provider's own way.",
    }),
    modes: z.array(ModeAvailability).meta({
      description:
        "The modes the adapter maps onto its provider (ADR 0006), each available or not with the reason; a run asking for an unavailable or unlisted mode gets the next lower available one.",
    }),
  })
  .meta({
    description:
      "An adapter's capabilities descriptor: its provider, a flag per optional power, its instruction channel, whether it loads a trusted repository's own instructions itself and which of its skill roots, and its modes.",
  });
export type AdapterCapabilities = z.infer<typeof AdapterCapabilities>;

/** A command line, as an argument vector: the executable's arguments, never a shell string. */
const Argv = z.array(z.string()).meta({ description: "A command's arguments, in order; never a shell string." });

/**
 * How an adapter's credential is scoped (ADR 0018): the variable naming an
 * account's config directory, the credential variables stripped from every
 * run and never set, and the sign-in, status and logout command lines. The
 * parser from status output to `AuthStatus` is the live adapter's.
 */
export const CredentialSpec = z
  .object({
    configDirVariable: z.string().min(1).meta({ description: "The environment variable naming an account's config directory: CLAUDE_CONFIG_DIR." }),
    strippedVariables: z.array(z.string().min(1)).meta({
      description: "Credential variables removed from every run's environment and never set, so no stray key bills a subscription account.",
    }),
    signIn: Argv,
    status: Argv,
    logout: Argv,
  })
  .meta({ description: "How an adapter's credential is scoped: the config-directory variable, the stripped variables, and the sign-in, status and logout argv." });
export type CredentialSpec = z.infer<typeof CredentialSpec>;

/** An account's sign-in state, as an adapter's credential spec parses its status output. */
export const AuthStatus = z
  .object({
    signedIn: z.boolean(),
    authMethod: z.string().min(1).nullable().meta({ description: "How the account signed in, in the provider's words; null when signed out." }),
    email: z.string().min(1).nullable(),
    orgName: z.string().min(1).nullable(),
    subscriptionType: z.string().min(1).nullable().meta({ description: "The plan the login is on, in the provider's words." }),
    error: z.string().min(1).nullable().meta({ description: "Why the status could not be read, when it could not." }),
    expired: z
      .boolean()
      .optional()
      .meta({
        description:
          "True when the provider says the login has lapsed and must be signed in again; absent when it cannot tell. Claude's status command cannot, so its adapter says so only once the refresh of an expired login has failed.",
      }),
  })
  .meta({ description: "An account's sign-in state: signed in or not, how, as whom, on which plan, or why it could not be read." });
export type AuthStatus = z.infer<typeof AuthStatus>;

/** Where a message sent to a session went: the prompt of a run, steered into a running turn, or queued to be read later. */
export const MESSAGE_DELIVERIES = ["prompt", "steered", "queued"] as const;
export const MessageDelivery = z.enum(MESSAGE_DELIVERIES).meta({
  description:
    "Where a message went: prompt (a run starts with it, or a queued turn opened with it), steered (the provider folded it into the running turn), or queued (held until a turn reads it).",
});
export type MessageDelivery = z.infer<typeof MessageDelivery>;

/** Who holds a queued message (ADR 0022): the provider's own queue, or the environment's. */
export const QUEUE_HOLDERS = ["provider", "environment"] as const;
export const QueueHolder = z.enum(QUEUE_HOLDERS).meta({
  description: "Who holds a queued message: the provider's queue (it may steer it into the running turn), or the environment's (the next run starts with it).",
});
export type QueueHolder = z.infer<typeof QueueHolder>;

/**
 * What `runs.send` answers (the send response, reshaped by ADR 0022): the
 * message's id, the run it went to or was sent during, and whether it
 * started that run or was queued, and by whom. Whether a queued message is
 * later steered or read is reported by `message.delivered`, never here.
 */
export const SendResponse = z
  .object({
    runId: RunId.meta({ description: "The run the message started, or the run live when it was queued." }),
    messageId: MessageId,
    delivery: MessageDelivery.exclude(["steered"]).meta({
      description: "prompt: no run was live, so the message started one; queued: a run was live, so the message waits to be steered or read.",
    }),
    heldBy: QueueHolder.nullable().meta({ description: "Who holds a queued message: the provider or the environment; null for a prompt." }),
  })
  .meta({ description: "What runs.send answers: the message started a run, or it was queued during the live run, and who holds it." });
export type SendResponse = z.infer<typeof SendResponse>;

/** Where a piece of delegated work has got to; pending, running and paused are live. */
export const DELEGATED_WORK_STATUSES = ["pending", "running", "paused", "completed", "failed", "stopped"] as const;
export const DelegatedWorkStatus = z.enum(DELEGATED_WORK_STATUSES).meta({
  description: "Where a piece of delegated work has got to: pending, running or paused (live), completed, failed or stopped (settled).",
});
export type DelegatedWorkStatus = z.infer<typeof DelegatedWorkStatus>;

/**
 * One row of a run's delegated-work ledger: a subagent, a background shell,
 * a workflow. `tasks.changed` carries the whole ledger after each change,
 * settled rows included.
 */
export const DelegatedWorkRow = z
  .object({
    taskId: z.string().min(1).meta({ description: "The provider's task id, stable for the task's life; runs.stopTask names it." }),
    kind: z.string().min(1).meta({ description: "The provider's own word for the kind of work (local_bash, local_agent); an open set." }),
    description: z.string().meta({ description: "The provider's one-line description of the task." }),
    status: DelegatedWorkStatus,
    startedAt: Timestamp.meta({ description: "When the environment first heard of the task." }),
    endedAt: Timestamp.nullable().meta({ description: "When it settled; null while it is live." }),
    subagentType: z.string().min(1).nullable().meta({ description: "The agent type of a subagent (Explore, Plan), else null." }),
    toolCallId: z.string().min(1).nullable().meta({ description: "The tool call that started it, when the provider says." }),
    error: z.string().nullable().meta({ description: "Why it failed, when it did." }),
  })
  .meta({ description: "One piece of delegated work a run holds: a subagent or a background task, with its status." });
export type DelegatedWorkRow = z.infer<typeof DelegatedWorkRow>;

/**
 * A provider's prediction of the user's next message after a run (the run
 * suggestion): editable text for the composer, never sent on its own.
 */
export const RunSuggestion = z
  .object({
    runId: RunId,
    suggestion: z.string().min(1).meta({ description: "The predicted next message, verbatim; a client offers it as editable text and never sends it itself." }),
  })
  .meta({ description: "A provider's prediction of the user's next message after a run, for the composer." });
export type RunSuggestion = z.infer<typeof RunSuggestion>;
