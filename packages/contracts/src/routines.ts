import { z } from "zod";
import { AccountIdentity, RunId } from "./adapter.js";
import { SchemaIssue } from "./errors.js";
import type { EventTypeEntry } from "./event-types.js";
import { ContainmentLevel, ModeResolution } from "./permissions.js";
import { Mode } from "./permissions-modes.js";
import { ClientSessionId, EnvironmentId, setOf, Timestamp } from "./primitives.js";
import { Sha256 } from "./release.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { RoutineSchedule, RoutineTimeZone, WrittenTimeZone } from "./schedule.js";
import { Ceiling } from "./scopes.js";
import { SessionId, Tag, WorkspaceRequest } from "./sessions.js";
import { SkillName } from "./skill-rules.js";
import { ModelUsage } from "./transcript.js";

/**
 * The routine vocabulary (routines spec; ADR 0008): a routine's definition,
 * which YAML carries and a client writes, with its bounds and presets; its
 * state, which is the environment's and never exported; the routine
 * `routines.list` answers with its attention codes. The schedule, its zone
 * and their maths are `schedule.ts`'s; the silence rule, the YAML codec and
 * the webhook signature are the tickets' that first use them.
 */

/** A routine's id: a version 4 UUID the creating client mints, so a create can queue offline. */
export const RoutineId = z.uuidv4().meta({ description: "A routine's id: a version 4 UUID the creating client mints, so a create can queue offline." });
export type RoutineId = z.infer<typeof RoutineId>;

/** A routine's name: the Tag rule, so it is also a valid tag; unique per environment ignoring case. */
export const RoutineName = Tag.meta({
  description:
    "A routine's name: 1 to 40 characters once trimmed, no control or format (zero-width) characters, so it is also a valid tag; stored trimmed, unique per environment ignoring case.",
});
export type RoutineName = z.infer<typeof RoutineName>;

/** What a routine does with due times its environment missed: fire the latest once, within seven days, or skip them. */
export const ROUTINE_IF_MISSED = ["run-once", "skip"] as const;
export const RoutineIfMissed = z.enum(ROUTINE_IF_MISSED).meta({
  description: "What a routine does with due times its environment missed: run-once (the latest fires once when the environment is back, within seven days) or skip (each is skipped missed).",
});
export type RoutineIfMissed = z.infer<typeof RoutineIfMissed>;

/** The longest instructions a routine takes, in characters. */
export const MAX_ROUTINE_INSTRUCTIONS = 100_000;

const RoutineInstructions = z
  .string()
  .min(1)
  .max(MAX_ROUTINE_INSTRUCTIONS)
  .meta({ description: "What a firing's run is asked to do: 1 to 100,000 characters, after the header the environment writes." });

const [DirectoryRequest, WorktreeRequest, ScratchRequest] = WorkspaceRequest.options;

/**
 * Where a routine's firings run (workspace-picker spec): a directory, a
 * worktree or a scratch directory, each firing's own where the kind makes
 * one; never another session's. It carries the repository identity it
 * resolved to when saved, so a move re-resolves it on another environment.
 */
export const RoutineWorkspace = z
  .intersection(
    z.discriminatedUnion("kind", [DirectoryRequest, WorktreeRequest, ScratchRequest]),
    z.object({
      repositoryIdentity: RepositoryIdentity.nullable().meta({
        description:
          "The repository identity the workspace resolved to when the routine was saved, which a move re-resolves it by; null outside a repository, for scratch, or before the environment has resolved it.",
      }),
    }),
  )
  .meta({
    description:
      "Where a routine's firings run: a directory, a worktree made per firing, or a scratch directory made per firing, never another session's; with the repository identity it resolved to when saved.",
  });
export type RoutineWorkspace = z.infer<typeof RoutineWorkspace>;

/** Whether a routine's runs and pre-check get the environment's credential injection: as the environment decides, or overridden either way (ADR 0011, ADR 0020). */
export const ROUTINE_INJECTIONS = ["inherit", "allow", "deny"] as const;
export const RoutineInjection = z.enum(ROUTINE_INJECTIONS).meta({
  description:
    "Whether a firing's runs and pre-check get the environment's credential injection, the forge variables and the credential helper among it: inherit (as the environment's setting says), allow or deny.",
});
export type RoutineInjection = z.infer<typeof RoutineInjection>;

/** The longest a script pre-check may run, in seconds. */
export const MAX_PRE_CHECK_TIMEOUT_SECONDS = 600;

/** A script pre-check's path: relative to the environment's scripts directory, never absolute. */
const PreCheckScriptPath = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?![\\/~]|[A-Za-z]:)/)
  .meta({
    description: "A script's path relative to the environment's scripts directory; it must stay inside that directory once links are followed, which the environment checks at each firing.",
  });

/** An `http` or `https` URL. */
const HttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .regex(/^https?:\/\//)
  .meta({ description: "An http or https URL." });

const scriptPreCheck = <T extends z.ZodType<number, number | undefined>>(timeoutSeconds: T) =>
  z
    .object({ kind: z.literal("script"), path: PreCheckScriptPath, timeoutSeconds })
    .meta({ description: "A script in the environment's scripts directory, run with no arguments; its standard output is the pre-check's output." });

const urlPreCheck = z
  .object({ kind: z.literal("url"), url: HttpUrl.meta({ description: "The URL fetched with a GET; its body is the pre-check's output." }) })
  .meta({ description: "A URL fetched with a GET, up to five redirects; a status other than 2xx is a failure." });

const timeout = z.int().min(1).max(MAX_PRE_CHECK_TIMEOUT_SECONDS);
const timeoutDescription = `How long the script may run before its process tree is killed, 1 to ${MAX_PRE_CHECK_TIMEOUT_SECONDS} seconds`;

/** A routine's pre-check as saved: a script with its timeout, or a URL. */
export const PreCheck = z
  .discriminatedUnion("kind", [scriptPreCheck(timeout.meta({ description: `${timeoutDescription}.` })), urlPreCheck])
  .meta({ description: "What a routine runs before each firing, whose unchanged output skips the model: a script in the scripts directory, or a URL." });
export type PreCheck = z.infer<typeof PreCheck>;

/** When a delivery target takes a result: a success, a failure, or both. */
export const DELIVERY_ONS = ["success", "failure", "both"] as const;
export const DeliveryOn = z.enum(DELIVERY_ONS).meta({
  description: "Which results a delivery target takes: success (a succeeded firing), failure (a failed firing or a failing skip), or both.",
});
export type DeliveryOn = z.infer<typeof DeliveryOn>;

/** A webhook endpoint's name: lower-case letters, digits and hyphens, 1 to 40. */
export const EndpointName = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/)
  .meta({ description: "A webhook endpoint's name on its environment: 1 to 40 lower-case letters, digits and hyphens, unique." });
export type EndpointName = z.infer<typeof EndpointName>;

/** Where a firing's result goes: a notice on every connected client, or a signed webhook POST to an endpoint named on the environment. */
export const DeliveryTarget = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("client-notice"), on: DeliveryOn }).meta({ description: "routine.delivered on the environment stream, which every connected client raises." }),
    z
      .object({ kind: z.literal("webhook"), target: EndpointName.meta({ description: "The endpoint's name on the routine's environment, which holds its URL and secret." }), on: DeliveryOn })
      .meta({ description: "A signed webhook POST to an endpoint the environment names." }),
  ])
  .meta({ description: "Where a firing's result goes, and which results it takes: a client notice, or a signed webhook to a named endpoint." });
export type DeliveryTarget = z.infer<typeof DeliveryTarget>;

/** The most delivery targets a routine has. */
export const MAX_DELIVERY_TARGETS = 8;

/** The longest silence marker. */
export const MAX_SILENCE_MARKER = 64;

/** The longest a firing may run, in minutes: a day. */
export const MAX_ROUTINE_DURATION_MINUTES = 1440;

/** What a definition takes when a client leaves it out; the zone's preset is the environment's own zone, which the environment applies. */
export const ROUTINE_PRESETS = {
  ifMissed: "run-once",
  injection: "inherit",
  silenceMarker: "[SILENT]",
  maxDurationMinutes: 60,
  timeoutSeconds: 60,
  delivery: [{ kind: "client-notice", on: "both" }],
} as const satisfies {
  ifMissed: RoutineIfMissed;
  injection: RoutineInjection;
  silenceMarker: string;
  maxDurationMinutes: number;
  timeoutSeconds: number;
  delivery: readonly DeliveryTarget[];
};

/** A pre-check as a client writes it: a script's timeout may be left out and takes its preset. */
export const PreCheckInput = z
  .discriminatedUnion("kind", [
    scriptPreCheck(timeout.default(ROUTINE_PRESETS.timeoutSeconds).meta({ description: `${timeoutDescription}; ${ROUTINE_PRESETS.timeoutSeconds} when absent.` })),
    urlPreCheck,
  ])
  .meta({ description: "A pre-check as a client writes it: a script, whose timeout is 60 seconds when absent, or a URL." });
export type PreCheckInput = z.input<typeof PreCheckInput>;

const presetDelivery = (): DeliveryTarget[] => ROUTINE_PRESETS.delivery.map((target) => ({ ...target }));

const silenceMarker = z.string().min(1).max(MAX_SILENCE_MARKER);
const maxDurationMinutes = z.int().min(1).max(MAX_ROUTINE_DURATION_MINUTES);
const delivery = z.array(DeliveryTarget).max(MAX_DELIVERY_TARGETS);

/** The fields of a definition every form of it shares. */
const definitionShape = {
  name: RoutineName,
  schedule: RoutineSchedule,
  timezone: RoutineTimeZone,
  ifMissed: RoutineIfMissed,
  instructions: RoutineInstructions,
  workspace: RoutineWorkspace,
  account: AccountIdentity.nullable().meta({ description: "The account a firing runs on, by identity; null for the environment's default account at each firing." }),
  model: z.string().min(1).nullable().meta({ description: "The model a firing's runs use; null for the strongest of accounts.defaultModelFamily." }),
  effort: z.string().min(1).nullable().meta({ description: "The reasoning effort a firing's runs take; null for accounts.defaultEffort." }),
  mode: Mode.nullable().meta({ description: "The mode a firing's runs ask for, clamped to the ceiling it was saved under; null for permissions.unattended.mode." }),
  containment: ContainmentLevel.nullable().meta({ description: "The containment level of a firing's session; null for permissions.containment.default." }),
  injection: RoutineInjection,
  skills: setOf(SkillName).meta({ description: "Names from the skill set, each once, loaded always-on for a firing's runs." }),
  preCheck: PreCheck.nullable().meta({ description: "What runs before each firing; null for none, so every due time fires." }),
  silenceMarker: silenceMarker.meta({ description: `The final text that delivers nothing: 1 to ${MAX_SILENCE_MARKER} characters.` }),
  maxDurationMinutes: maxDurationMinutes.meta({ description: "How long a firing may run before its live run is interrupted: 1 to 1,440 minutes." }),
  delivery: delivery.meta({ description: `Where a firing's result goes: up to ${MAX_DELIVERY_TARGETS} targets.` }),
  enabled: z.boolean().meta({ description: "Whether the scheduler fires it; run now works either way." }),
};

/**
 * A routine's definition as the environment saves it, events record it and
 * `routines.list` answers it: every field present, the presets applied and
 * the zone filled in. What YAML carries; never an id, the environment, the
 * saved ceiling, history, the baseline, lineage or a secret.
 */
export const RoutineDefinition = z.object(definitionShape).meta({
  description:
    "A routine's definition as saved: its name, schedule and zone, what it does with missed due times, its instructions, workspace, account, model, effort, mode, containment, credential injection, skills, pre-check, silence marker, maximum duration, delivery targets and whether it is enabled.",
});
export type RoutineDefinition = z.infer<typeof RoutineDefinition>;

/**
 * A routine's definition as a client writes it (`routines.create`): what has
 * a preset may be left out and takes it, and the zone left out is the
 * environment's own, which the environment applies.
 */
export const RoutineDefinitionInput = z
  .object({
    ...definitionShape,
    timezone: WrittenTimeZone.optional().meta({ description: "An IANA time zone's name the environment's zone data knows; the environment's own zone when absent." }),
    ifMissed: RoutineIfMissed.default(ROUTINE_PRESETS.ifMissed),
    injection: RoutineInjection.default(ROUTINE_PRESETS.injection),
    preCheck: PreCheckInput.nullable().meta({ description: "What runs before each firing, a script's timeout preset when absent; null for none, so every due time fires." }),
    silenceMarker: silenceMarker.default(ROUTINE_PRESETS.silenceMarker).meta({ description: `The final text that delivers nothing: 1 to ${MAX_SILENCE_MARKER} characters; ${ROUTINE_PRESETS.silenceMarker} when absent.` }),
    maxDurationMinutes: maxDurationMinutes.default(ROUTINE_PRESETS.maxDurationMinutes).meta({
      description: `How long a firing may run before its live run is interrupted: 1 to 1,440 minutes; ${ROUTINE_PRESETS.maxDurationMinutes} when absent.`,
    }),
    delivery: delivery.default(presetDelivery).meta({ description: `Where a firing's result goes: up to ${MAX_DELIVERY_TARGETS} targets; one client notice on both when absent.` }),
  })
  .meta({ description: "A routine's definition as a client writes it: what has a preset may be left out and takes it, and a zone left out is the environment's own." });
export type RoutineDefinitionInput = z.input<typeof RoutineDefinitionInput>;

/** A firing's or a skip's id: a UUID the environment mints; a firing's is its session's command id, so a retry makes nothing twice. */
export const RoutineEntryId = z.uuid().meta({
  description: "A history entry's id, a firing's or a skip's: a UUID the environment mints; a firing's is its session's command id, so a retry after a crash makes nothing twice.",
});
export type RoutineEntryId = z.infer<typeof RoutineEntryId>;

/** What made a due time's firing or skip: the schedule, the catch-up of missed due times, or run now. */
export const ROUTINE_TRIGGERS = ["schedule", "catch-up", "run-now"] as const;
export const RoutineTrigger = z.enum(ROUTINE_TRIGGERS).meta({
  description: "What made an entry: schedule (a due time on time), catch-up (the latest of due times missed while the environment was down, fired once) or run-now (routines.runNow).",
});
export type RoutineTrigger = z.infer<typeof RoutineTrigger>;

/** How a firing ended. */
export const FIRING_OUTCOMES = ["succeeded", "silent", "failed", "cancelled"] as const;
export const FiringOutcome = z.enum(FIRING_OUTCOMES).meta({
  description:
    "How a firing ended: succeeded (its run completed with text other than the silence marker, or none), silent (its final text was the silence marker, so nothing was delivered), failed (with its reason) or cancelled (a person interrupted it, or deleted its session or its routine).",
});
export type FiringOutcome = z.infer<typeof FiringOutcome>;

/** Why a firing failed. */
export const FIRING_FAILURE_REASONS = ["run_error", "timed_out", "restart", "drained"] as const;
export const FiringFailureReason = z.enum(FIRING_FAILURE_REASONS).meta({
  description:
    "Why a firing failed: run_error (its run ended in error), timed_out (its maximum duration passed and its run was interrupted), restart (its run was cut by a restart, or let go with its session still there) or drained (a drain cut its run and nothing continued it).",
});
export type FiringFailureReason = z.infer<typeof FiringFailureReason>;

/** Why a due time was skipped rather than fired. */
export const SKIP_REASONS = ["no-change", "pre-check-failed", "cannot-start", "missed", "overlap"] as const;
export const SkipReason = z.enum(SKIP_REASONS).meta({
  description:
    "Why a due time was skipped: no-change (the pre-check's output was the baseline's), pre-check-failed (the pre-check failed; a failure), cannot-start (the firing could not start, with a reason of its own; a failure), missed (missed while the environment was down, and not caught up) or overlap (a firing of the routine was live).",
});
export type SkipReason = z.infer<typeof SkipReason>;

/** Why a firing could not start, a `cannot-start` skip's own reason. */
export const CANNOT_START_REASONS = ["account_missing", "account_signed_out", "model_unavailable", "skill_unknown", "workspace_unusable", "start_refused"] as const;
export const CannotStartReason = z.enum(CANNOT_START_REASONS).meta({
  description:
    "Why a firing could not start: account_missing (no account here has its identity, or none is the default), account_signed_out, model_unavailable (the account does not offer its model), skill_unknown (a skill is not in the skill set), workspace_unusable (the workspace resolver refused its workspace) or start_refused (the run's start was refused, so the whole start rolled back).",
});
export type CannotStartReason = z.infer<typeof CannotStartReason>;

/** The other end of a move: the environment and the routine there, and when the move was made. */
export const RoutineMoveLink = z
  .object({
    environmentId: EnvironmentId,
    routineId: RoutineId,
    at: Timestamp.meta({ description: "When the move was recorded here." }),
  })
  .meta({ description: "The other copy of a moved routine: its environment, its id there, and when the move was recorded here." });
export type RoutineMoveLink = z.infer<typeof RoutineMoveLink>;

/** A firing that has started and not ended. */
export const LiveFiring = z
  .object({
    firingId: RoutineEntryId,
    trigger: RoutineTrigger,
    dueAt: Timestamp.meta({ description: "The due time it fires for; for run now, when it was asked." }),
    startedAt: Timestamp,
    sessionId: SessionId.meta({ description: "The firing's session." }),
    runId: RunId.meta({ description: "The firing's live run: its first, or the one that continues it after an update." }),
  })
  .meta({ description: "A firing that has started and not ended: its id, trigger, due time, start, session and live run." });
export type LiveFiring = z.infer<typeof LiveFiring>;

/** The latest entry's outcome: a firing's, or a skip's reason. */
export const RoutineLastOutcome = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("firing"),
        entryId: RoutineEntryId,
        outcome: FiringOutcome,
        reason: FiringFailureReason.nullable().meta({ description: "Why it failed; null unless it did." }),
        at: Timestamp.meta({ description: "When it ended." }),
      })
      .meta({ description: "The latest entry was a firing that ended: its outcome, and why when it failed." }),
    z
      .object({ kind: z.literal("skip"), entryId: RoutineEntryId, reason: SkipReason, at: Timestamp.meta({ description: "When the skip was recorded." }) })
      .meta({ description: "The latest entry was a skip: why." }),
  ])
  .meta({ description: "How the routine's latest ended entry ended: a firing's outcome, or a skip's reason." });
export type RoutineLastOutcome = z.infer<typeof RoutineLastOutcome>;

/**
 * A routine's state (routines spec, "The routine"): the environment's, never
 * exported. The ceiling and who saved it come from the client session whose
 * create, edit, import or enable last touched it; a disable or a delete
 * records neither.
 */
export const RoutineState = z
  .object({
    id: RoutineId,
    savedUnderCeiling: Ceiling.meta({ description: "The ceiling of the client session whose create, edit, import or enable last touched it: every firing's mode is clamped to it." }),
    savedBy: ClientSessionId.meta({ description: "The client session whose create, edit, import or enable last touched it." }),
    createdAt: Timestamp,
    editedAt: Timestamp.nullable().meta({ description: "When its definition was last edited or replaced by an import; null until then." }),
    movedFrom: RoutineMoveLink.nullable().meta({ description: "The routine this one is a moved copy of; null for one made here." }),
    movedTo: RoutineMoveLink.nullable().meta({ description: "The copy this one was moved to, which disabled it; null until moved, and cleared when it is enabled." }),
    baseline: z
      .object({ hash: Sha256.meta({ description: "The SHA-256 of the output's exact bytes." }), at: Timestamp.meta({ description: "When that pre-check ran." }) })
      .nullable()
      .meta({ description: "The pre-check output of the latest firing that ended succeeded or silent, by its hash and when it ran; null until one has." }),
    handledThrough: Timestamp.nullable().meta({
      description: "The latest due time handled, as a firing or a skip; moved to the save time when the routine is created, enabled, or its schedule or zone edited, so no earlier due time is owed. Null for a routine with no due time handled or owed.",
    }),
    liveFiring: LiveFiring.nullable().meta({ description: "The firing that has started and not ended; null when none is live." }),
    lastOutcome: RoutineLastOutcome.nullable().meta({ description: "How its latest ended entry ended; null before its first." }),
    failureStreak: z.int().nonnegative().meta({
      description: "Consecutive failed firings and failing skips (pre-check-failed, cannot-start), reset by succeeded, silent or no-change.",
    }),
  })
  .meta({ description: "A routine's state, the environment's and never exported: its id, what it was saved under and by whom, when, its move links, baseline, handledThrough, live firing, last outcome and failure streak." });
export type RoutineState = z.infer<typeof RoutineState>;

/** What needs a person's attention on a routine, which `routines.list` computes from the environment's live state. */
export const ROUTINE_ATTENTION = [
  "account_missing",
  "account_signed_out",
  "model_unavailable",
  "skill_unknown",
  "script_missing",
  "endpoint_missing",
  "endpoint_needs_secret",
  "clamped",
  "failing",
  "delivery_failing",
] as const;
export const RoutineAttention = z.enum(ROUTINE_ATTENTION).meta({
  description:
    "What needs attention on a routine: account_missing (no account here has its identity, or none is the default), account_signed_out, model_unavailable (the account does not offer its model), skill_unknown (a skill is not in the skill set), script_missing (its pre-check's script is not in the scripts directory), endpoint_missing (a webhook target names no endpoint here), endpoint_needs_secret (a target's endpoint has no secret), clamped (its effective mode is below the mode it asks for), failing (its failure streak is not zero) or delivery_failing (the last delivery to a target failed finally).",
});
export type RoutineAttention = z.infer<typeof RoutineAttention>;

/** A routine as `routines.list` answers it. */
export const ListedRoutine = z
  .object({
    definition: RoutineDefinition,
    state: RoutineState,
    nextDueAt: Timestamp.nullable().meta({ description: "When it is next due; null when it never is: disabled, or manual." }),
    mode: ModeResolution.meta({
      description: "Its effective mode: its mode, else permissions.unattended.mode, clamped to the ceiling it was saved under and the account's modes, as the policy resolver clamps a firing's run.",
    }),
    attention: setOf(RoutineAttention).meta({ description: "What needs attention on it, each code once; empty when nothing does." }),
  })
  .meta({ description: "A routine as routines.list answers it: its definition and state, its next due time, its effective mode with the clamp, and what needs attention." });
export type ListedRoutine = z.infer<typeof ListedRoutine>;

/** The longest final text a firing keeps, in characters. */
export const MAX_ROUTINE_TEXT = 16_000;

/** The most of a pre-check's output an entry and the baseline keep, in characters: its first 64 KiB. */
export const MAX_PRE_CHECK_KEPT_OUTPUT = 65_536;

/** The most of a failed pre-check's standard error kept, in characters: its last 8 KiB. */
export const MAX_PRE_CHECK_STDERR = 8192;

/** Why a pre-check failed. */
export const PRE_CHECK_FAILURES = ["script_missing", "script_unusable", "exit_status", "timed_out", "output_too_large", "unreachable", "http_status", "denylisted"] as const;
export const PreCheckFailure = z.enum(PRE_CHECK_FAILURES).meta({
  description:
    "Why a pre-check failed: script_missing (no file at its path in the scripts directory), script_unusable (its path leaves the scripts directory once links are followed, or names no regular executable file), exit_status (the script exited other than 0), timed_out (it ran past its timeout, and its process tree was killed), output_too_large (its output passed 1 MiB), unreachable (the URL did not answer, or redirected more than five times), http_status (the URL answered other than 2xx) or denylisted (a host it reached is on the denylist).",
});
export type PreCheckFailure = z.infer<typeof PreCheckFailure>;

/** What one run of a pre-check found: what an entry records and `routines.testPreCheck` answers. */
export const PreCheckRecord = z
  .object({
    kind: z.enum(["script", "url"]).meta({ description: "Whether a script ran or a URL was fetched." }),
    startedAt: Timestamp,
    durationMs: z.int().nonnegative(),
    exitStatus: z.int().nullable().meta({ description: "The script's exit status; null for a URL, or a script killed at its timeout or once its output passed 1 MiB." }),
    httpStatus: z.int().min(100).max(599).nullable().meta({ description: "The URL's final HTTP status; null for a script, or a URL that did not answer." }),
    bytes: z.int().nonnegative().meta({ description: "The output's size in bytes, as far as it was read." }),
    hash: Sha256.nullable().meta({ description: "The SHA-256 of the output's exact bytes, with no normalisation; null when the pre-check failed." }),
    differs: z.boolean().nullable().meta({ description: "Whether the hash differs from the baseline's; null with no baseline (a first observation) or no hash." }),
    output: z.string().max(MAX_PRE_CHECK_KEPT_OUTPUT).nullable().meta({
      description: "The output, scrubbed, its first 65,536 characters (routines.testPreCheck answers its first 8,000); null where it is not kept, as for a no-change skip, whose output is the baseline's.",
    }),
    stderr: z.string().max(MAX_PRE_CHECK_STDERR).nullable().meta({ description: "The script's standard error, scrubbed, its last 8,192 characters, kept for a failure; else null." }),
    failure: z
      .object({ reason: PreCheckFailure, detail: z.string().min(1).meta({ description: "What failed, for a person: the exit status, the path's problem, the host." }) })
      .nullable()
      .meta({ description: "Why the pre-check failed; null when it did not." }),
  })
  .meta({ description: "What one run of a pre-check found: its kind, when and how long, its exit or HTTP status, the output's size, hash and kept part, whether it differs from the baseline, and why it failed when it did." });
export type PreCheckRecord = z.infer<typeof PreCheckRecord>;

/** What a delivery attempt came to: delivered, failed with a retry to come, or failed finally. */
export const DELIVERY_ATTEMPT_RESULTS = ["delivered", "retrying", "failed"] as const;
export const DeliveryAttemptResult = z.enum(DELIVERY_ATTEMPT_RESULTS).meta({
  description: "What a delivery attempt came to: delivered, retrying (it failed and is retried at retryAt: a network error, a timeout, 408, 429 or 5xx) or failed (finally).",
});
export type DeliveryAttemptResult = z.infer<typeof DeliveryAttemptResult>;

/** One attempt to deliver an entry to a target. */
export const DeliveryAttempt = z
  .object({
    attempt: z.int().positive().meta({ description: "Which attempt, from 1." }),
    at: Timestamp,
    result: DeliveryAttemptResult,
    status: z.int().min(100).max(599).nullable().meta({ description: "The HTTP status a webhook answered; null for a client notice, or when none came." }),
    error: z.string().min(1).nullable().meta({ description: "What went wrong; null when it was delivered." }),
    retryAt: Timestamp.nullable().meta({ description: "When the next attempt is made, when the result is retrying; else null." }),
  })
  .meta({ description: "One attempt to deliver an entry to a target: which, when, what it came to, the status, the error and the retry time." });
export type DeliveryAttempt = z.infer<typeof DeliveryAttempt>;

/** Where an entry's delivery to one target stands: pending while attempts go on, then delivered or failed. */
export const DELIVERY_RESULTS = ["pending", "delivered", "failed"] as const;

/** An entry's delivery to one of its targets, with every attempt. */
export const RoutineDelivery = z
  .object({
    target: DeliveryTarget,
    result: z.enum(DELIVERY_RESULTS).meta({ description: "Where the delivery stands: pending (an attempt is to come), delivered, or failed finally." }),
    attempts: z.array(DeliveryAttempt).meta({ description: "Every attempt, first first." }),
  })
  .meta({ description: "An entry's delivery to one target: where it stands and every attempt." });
export type RoutineDelivery = z.infer<typeof RoutineDelivery>;

const entryPart = {
  id: RoutineEntryId,
  trigger: RoutineTrigger,
  count: z.int().positive().meta({ description: "How many due times it stands for: more than one when missed due times collapsed into it." }),
  preCheck: PreCheckRecord.nullable().meta({ description: "The pre-check it ran; null when none ran." }),
  deliveries: z.array(RoutineDelivery).meta({ description: "Its delivery to each target that took it, in the targets' order." }),
};

/** A firing as the history lists it, live or ended. */
export const FiringEntry = z
  .object({
    kind: z.literal("firing"),
    ...entryPart,
    dueAt: Timestamp.meta({ description: "The due time it fired for; for run now, when it was asked." }),
    startedAt: Timestamp,
    endedAt: Timestamp.nullable().meta({ description: "When it ended; null while it is live." }),
    sessionId: SessionId.meta({ description: "The firing's session, tagged with the routine." }),
    runId: RunId.meta({ description: "Its latest run: the first, or the one that continued it after an update." }),
    requestedBy: ClientSessionId.nullable().meta({ description: "The client session that ran it now; null for the schedule and a catch-up." }),
    targets: z.array(DeliveryTarget).max(MAX_DELIVERY_TARGETS).meta({ description: "The delivery targets it started with, which an edit meanwhile does not change." }),
    outcome: FiringOutcome.nullable().meta({ description: "How it ended; null while it is live." }),
    reason: FiringFailureReason.nullable().meta({ description: "Why it failed; null unless it did." }),
    text: z.string().max(MAX_ROUTINE_TEXT).nullable().meta({
      description: "Its final text, at most 16,000 characters: the last firing run's result text, else its last assistant text; empty when there was none; null while it is live.",
    }),
    usage: z.array(ModelUsage).nullable().meta({ description: "Its runs' token spend per model, when the provider reported it; null while live or when none was." }),
    durationMs: z.int().nonnegative().nullable().meta({ description: "How long it ran, from its start to its end; null while it is live." }),
    baselineAdvanced: z.boolean().nullable().meta({ description: "Whether its pre-check's output became the baseline; null while it is live." }),
  })
  .meta({ description: "A firing: a session tagged with its routine, with its trigger, due time, pre-check, targets, and once it has ended its outcome, text, usage, duration and deliveries." });
export type FiringEntry = z.infer<typeof FiringEntry>;

/** A skipped due time as the history lists it. */
export const SkipEntry = z
  .object({
    kind: z.literal("skip"),
    ...entryPart,
    dueAt: Timestamp.meta({ description: "The due time it skipped: the latest of those it stands for; for run now, when it was asked." }),
    at: Timestamp.meta({ description: "When the skip was recorded." }),
    reason: SkipReason,
    cannotStart: CannotStartReason.nullable().meta({ description: "Why the firing could not start, when the reason is cannot-start; else null." }),
    detail: z.string().min(1).max(MAX_ROUTINE_TEXT).nullable().meta({ description: "What a person should know of a failing skip: the pre-check's failure, why the firing could not start; else null." }),
  })
  .meta({ description: "A skipped due time: no session, with its trigger, due time, reason, the due times it stands for, its detail and pre-check, and the deliveries of a failing skip." });
export type SkipEntry = z.infer<typeof SkipEntry>;

/** One entry of a routine's history: a firing or a skip. */
export const RoutineEntry = z
  .discriminatedUnion("kind", [FiringEntry, SkipEntry])
  .meta({ description: "One entry of a routine's history: a firing, which is a session, or a skip, which has none." });
export type RoutineEntry = z.infer<typeof RoutineEntry>;

/** The stream kind of a routine's events; the stream id is the routine's id. */
export const ROUTINE_STREAM_KIND = "routine";

/** Some of a definition's fields as saved, any subset: what `routine.edited` records. */
export const RoutineFields = RoutineDefinition.partial().meta({
  description: "Some of a routine definition's fields, any subset, each as saved: what an edit changes, the rest left as they are.",
});
export type RoutineFields = z.infer<typeof RoutineFields>;

const savedUnderCeiling = Ceiling.meta({ description: "The ceiling of the client session that saved it: every firing's mode is clamped to it." });

export const RoutineCreatedPayload = z
  .object({
    definition: RoutineDefinition,
    savedUnderCeiling,
    movedFrom: RoutineMoveLink.nullable().meta({ description: "The routine this one is a moved copy of; null for one made here." }),
  })
  .meta({ description: "routine.created: a routine was made, by routines.create or routines.import, with its definition as saved and the ceiling it was saved under." });
export type RoutineCreatedPayload = z.infer<typeof RoutineCreatedPayload>;

export const RoutineEditedPayload = z
  .object({ fields: RoutineFields, savedUnderCeiling })
  .meta({ description: "routine.edited: some of a routine's fields were changed, by routines.update or an import replacing its definition; the rest are as they were." });
export type RoutineEditedPayload = z.infer<typeof RoutineEditedPayload>;

export const RoutineEnabledPayload = z
  .object({ savedUnderCeiling })
  .meta({ description: "routine.enabled: the routine fires on its schedule again, saved under the enabling client session's ceiling; its movedTo is cleared." });
export type RoutineEnabledPayload = z.infer<typeof RoutineEnabledPayload>;

export const RoutineDisabledPayload = z
  .object({ movedTo: RoutineMoveLink.nullable().meta({ description: "The copy it was moved to, when a move disabled it; else null." }) })
  .meta({ description: "routine.disabled: the routine no longer fires on its schedule; it records no ceiling." });
export type RoutineDisabledPayload = z.infer<typeof RoutineDisabledPayload>;

export const RoutineDeletedPayload = z.object({}).meta({ description: "routine.deleted: the routine is gone from the list; its history stays in the log." });
export type RoutineDeletedPayload = z.infer<typeof RoutineDeletedPayload>;

export const RoutineSkippedPayload = z
  .object({
    skipId: RoutineEntryId,
    trigger: RoutineTrigger,
    dueAt: SkipEntry.shape.dueAt,
    reason: SkipReason,
    cannotStart: SkipEntry.shape.cannotStart,
    count: entryPart.count,
    detail: SkipEntry.shape.detail,
    preCheck: entryPart.preCheck,
  })
  .meta({ description: "routine.skipped: a due time, or a run now, was handled with no firing: why, what it stands for, and the pre-check it ran." });
export type RoutineSkippedPayload = z.infer<typeof RoutineSkippedPayload>;

export const RoutineFiringStartedPayload = z
  .object({
    firingId: RoutineEntryId,
    trigger: RoutineTrigger,
    dueAt: FiringEntry.shape.dueAt,
    count: entryPart.count,
    sessionId: FiringEntry.shape.sessionId,
    runId: RunId.meta({ description: "The firing's first run." }),
    requestedBy: FiringEntry.shape.requestedBy,
    preCheck: entryPart.preCheck,
    targets: FiringEntry.shape.targets,
  })
  .meta({ description: "routine.firing-started: a firing's session and first run were made in one transaction, with the targets it delivers to whatever an edit changes meanwhile." });
export type RoutineFiringStartedPayload = z.infer<typeof RoutineFiringStartedPayload>;

export const RoutineFiringContinuedPayload = z
  .object({ firingId: RoutineEntryId, runId: RunId.meta({ description: "The run that continues the firing after an update cut its last." }) })
  .meta({ description: "routine.firing-continued: an update cut the firing's run and the environment continued it; the firing follows the new run." });
export type RoutineFiringContinuedPayload = z.infer<typeof RoutineFiringContinuedPayload>;

export const RoutineFiringEndedPayload = z
  .object({
    firingId: RoutineEntryId,
    outcome: FiringOutcome,
    reason: FiringEntry.shape.reason,
    text: z.string().max(MAX_ROUTINE_TEXT).meta({ description: "Its final text, at most 16,000 characters: the last firing run's result text, else its last assistant text; empty when there was none." }),
    usage: z.array(ModelUsage).nullable().meta({ description: "Its runs' token spend per model, when the provider reported it." }),
    durationMs: z.int().nonnegative().meta({ description: "How long it ran, from its start to its end." }),
    baselineAdvanced: z.boolean().meta({ description: "Whether its pre-check's output became the baseline: only a firing with a pre-check that ended succeeded or silent advances it." }),
  })
  .meta({ description: "routine.firing-ended: a firing ended, read from its runs' run.ended: its outcome, the failure's reason, its final text, usage and duration, and whether the baseline advanced." });
export type RoutineFiringEndedPayload = z.infer<typeof RoutineFiringEndedPayload>;

export const RoutineDeliveryAttemptedPayload = z
  .object({
    entryId: RoutineEntryId.meta({ description: "The firing or skip delivered." }),
    target: DeliveryTarget,
    attempt: DeliveryAttempt.shape.attempt,
    result: DeliveryAttemptResult,
    status: DeliveryAttempt.shape.status,
    error: DeliveryAttempt.shape.error,
    retryAt: DeliveryAttempt.shape.retryAt,
  })
  .meta({ description: "routine.delivery-attempted: one attempt to deliver an entry to a target, and what it came to; a pending retry survives a restart." });
export type RoutineDeliveryAttemptedPayload = z.infer<typeof RoutineDeliveryAttemptedPayload>;

/**
 * The event types of a routine's stream (routines spec, "Events and
 * notices"): none changes the session list. The commands' events are the
 * client session's; the engine's records are the actor `routine:<id>`'s. Not
 * compacted in milestone 1.
 */
export const ROUTINE_EVENT_TYPES = {
  "routine.created": { list: false, payload: RoutineCreatedPayload },
  "routine.edited": { list: false, payload: RoutineEditedPayload },
  "routine.enabled": { list: false, payload: RoutineEnabledPayload },
  "routine.disabled": { list: false, payload: RoutineDisabledPayload },
  "routine.deleted": { list: false, payload: RoutineDeletedPayload },
  "routine.skipped": { list: false, payload: RoutineSkippedPayload },
  "routine.firing-started": { list: false, payload: RoutineFiringStartedPayload },
  "routine.firing-continued": { list: false, payload: RoutineFiringContinuedPayload },
  "routine.firing-ended": { list: false, payload: RoutineFiringEndedPayload },
  "routine.delivery-attempted": { list: false, payload: RoutineDeliveryAttemptedPayload },
} as const satisfies Record<string, EventTypeEntry>;

export type RoutineEventType = keyof typeof ROUTINE_EVENT_TYPES;
export const RoutineEventType = z.enum(Object.keys(ROUTINE_EVENT_TYPES) as [RoutineEventType, ...RoutineEventType[]]).meta({
  description:
    "The event types of a routine's stream: routine.created, routine.edited, routine.enabled, routine.disabled, routine.deleted, routine.skipped, routine.firing-started, routine.firing-continued, routine.firing-ended and routine.delivery-attempted.",
});

export type RoutineEventPayload<T extends RoutineEventType> = z.infer<(typeof ROUTINE_EVENT_TYPES)[T]["payload"]>;

/**
 * What changed on a routine, as the `routine.updated` notice says, so the
 * client runtime refreshes `routines.list`: the kind of record appended, a
 * command's or the engine's. None is raised for a no-change skip or for a
 * delivery attempt that is retried, so frequent routines do not fill the
 * environment stream's replay bound.
 */
export const ROUTINE_CHANGES = ["created", "edited", "enabled", "disabled", "deleted", "skipped", "firing-started", "firing-continued", "firing-ended", "delivery-attempted"] as const;
export const RoutineChange = z.enum(ROUTINE_CHANGES).meta({
  description:
    "What changed on a routine: the record appended to its stream, routine.<change>: created, edited, enabled, disabled, deleted, skipped (not no-change), firing-started, firing-continued, firing-ended or delivery-attempted (a final result, not a retry).",
});
export type RoutineChange = z.infer<typeof RoutineChange>;

export const RoutineUpdatedPayload = z
  .object({ routineId: RoutineId, change: RoutineChange })
  .meta({ description: "routine.updated: a routine changed; the client runtime refreshes routines.list, and nobody sees the notice itself." });
export type RoutineUpdatedPayload = z.infer<typeof RoutineUpdatedPayload>;

/** The longest summary a delivered result has. */
export const MAX_DELIVERY_SUMMARY = 200;

/** The longest body a client notice delivers. */
export const MAX_DELIVERY_BODY = 4000;

/** How a delivered entry ended: only a succeeded firing, a failed firing and a failing skip are delivered. */
export const DELIVERED_OUTCOMES = ["succeeded", "failed"] as const;
export const DeliveredOutcome = z.enum(DELIVERED_OUTCOMES).meta({
  description: "How a delivered entry ended: succeeded (a firing), or failed (a failed firing, or a failing skip: pre-check-failed or cannot-start).",
});
export type DeliveredOutcome = z.infer<typeof DeliveredOutcome>;

/** A delivered result's one-line summary: the text's first non-blank line, or the failure's reason. */
const DeliverySummary = z.string().min(1).max(MAX_DELIVERY_SUMMARY).meta({
  description: `The result in one line, at most ${MAX_DELIVERY_SUMMARY} characters: the text's first non-blank line, or the failure's reason.`,
});

const routineNamed = { routineId: RoutineId, name: RoutineName };

const EntryKind = z.enum(["firing", "skip"]).meta({ description: "Whether the entry is a firing or a skip." });

export const RoutineDeliveredPayload = z
  .object({
    ...routineNamed,
    entryId: RoutineEntryId.meta({ description: "The firing or skip delivered." }),
    entryKind: EntryKind,
    sessionId: SessionId.nullable().meta({ description: "The firing's session, which opening the notice opens; null for a skip." }),
    outcome: DeliveredOutcome,
    summary: DeliverySummary,
    body: z.string().max(MAX_DELIVERY_BODY).meta({ description: `The result, at most 4,000 characters: the final text, "The firing finished without a final message." when it had none, or the failure's detail.` }),
  })
  .meta({ description: "routine.delivered: a routine's result for a client-notice target, once its entry's end committed; every connected client raises it." });
export type RoutineDeliveredPayload = z.infer<typeof RoutineDeliveredPayload>;

export const RoutineDeliveryFailedPayload = z
  .object({
    ...routineNamed,
    entryId: RoutineEntryId.meta({ description: "The firing or skip that could not be delivered." }),
    endpoint: EndpointName.meta({ description: "The endpoint the webhook target names." }),
    error: z.string().min(1).meta({ description: "Why the last attempt failed: the status, the network error, or a missing endpoint or secret." }),
  })
  .meta({ description: "routine.delivery-failed: a webhook delivery failed finally, after its retries or at once; every connected client raises it." });
export type RoutineDeliveryFailedPayload = z.infer<typeof RoutineDeliveryFailedPayload>;

/** Where a webhook endpoint's secret is: pasted into the environment's vault, a key-manager reference, or none. */
export const ENDPOINT_SECRET_KINDS = ["pasted", "reference", "missing"] as const;
export const EndpointSecretKind = z.enum(ENDPOINT_SECRET_KINDS).meta({
  description: "Where a webhook endpoint's secret is, never the secret: pasted (sent once and kept in the environment's vault), reference (a key-manager reference resolved per delivery) or missing (none, so a delivery to it fails).",
});
export type EndpointSecretKind = z.infer<typeof EndpointSecretKind>;

/** A webhook endpoint's URL: whether an `http` one is allowed, and its host, are the endpoint store's to check. */
export const EndpointUrl = HttpUrl.meta({
  description: "Where the endpoint's POSTs go: https, or http only to loopback, localhost, a private or tailnet address or a .ts.net name; with no userinfo, and its host off the denylist.",
});

export const RoutineEndpointSetPayload = z
  .object({ name: EndpointName, url: EndpointUrl, secretKind: EndpointSecretKind })
  .meta({ description: "routine.endpoint-set: a webhook endpoint was made or replaced: its name, URL and where its secret is, never the secret." });
export type RoutineEndpointSetPayload = z.infer<typeof RoutineEndpointSetPayload>;

export const RoutineEndpointRemovedPayload = z
  .object({ name: EndpointName })
  .meta({ description: "routine.endpoint-removed: a webhook endpoint was removed, and its secret with it." });
export type RoutineEndpointRemovedPayload = z.infer<typeof RoutineEndpointRemovedPayload>;

/** A webhook endpoint as `routines.endpoints.list` answers it: never its secret. */
export const WebhookEndpoint = z
  .object({
    name: EndpointName,
    url: EndpointUrl,
    secretKind: EndpointSecretKind,
    lastResult: z
      .object({ at: Timestamp, result: DeliveryAttemptResult, status: DeliveryAttempt.shape.status, error: DeliveryAttempt.shape.error })
      .nullable()
      .meta({ description: "What the latest POST to it came to, a delivery's or a test's; null before the first." }),
  })
  .meta({ description: "A webhook endpoint the environment names for routines to deliver to: its name, URL, where its secret is, and its last result; never the secret." });
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

/** The webhook payload's version, which a later payload raises only for a change a receiver must understand. */
export const ROUTINE_WEBHOOK_VERSION = 1;

/**
 * The Standard Webhooks headers every POST carries: the delivery's id (the
 * entry and the target, the same on every retry, so a receiver relays each
 * result once), the time it was sent, and the `v1` HMAC-SHA256 signature
 * over the id, the time and the body, keyed by the endpoint's secret.
 */
export const WEBHOOK_HEADERS = { id: "webhook-id", timestamp: "webhook-timestamp", signature: "webhook-signature" } as const;

const webhookPart = {
  version: z.literal(ROUTINE_WEBHOOK_VERSION).meta({ description: "The payload's version." }),
  environment: z
    .object({ id: EnvironmentId, name: z.string().min(1).meta({ description: "The environment's name." }) })
    .meta({ description: "The environment that sent it: its id and name." }),
  summary: DeliverySummary,
  text: z.string().max(MAX_ROUTINE_TEXT),
};

/** The failing skips a webhook delivers, by their reason. */
const FailingSkipReason = z.enum(["pre-check-failed", "cannot-start"]).meta({ description: "Why a delivered skip failed: its pre-check failed, or its firing could not start." });

/** A delivered entry as a webhook carries it. */
export const WebhookEntry = z
  .object({
    id: RoutineEntryId,
    kind: EntryKind,
    trigger: RoutineTrigger,
    dueAt: Timestamp,
    startedAt: Timestamp.meta({ description: "When the firing started; for a skip, when it was recorded." }),
    endedAt: Timestamp.meta({ description: "When the firing ended; for a skip, when it was recorded." }),
    outcome: DeliveredOutcome,
    reason: z.union([FiringFailureReason, FailingSkipReason]).nullable().meta({ description: "Why it failed: a firing's failure reason, or the failing skip's; null when it succeeded." }),
    sessionId: SessionId.nullable().meta({ description: "The firing's session; null for a skip." }),
  })
  .meta({ description: "The entry a webhook delivers: its id, kind, trigger, due time, start and end, outcome, reason and session." });
export type WebhookEntry = z.infer<typeof WebhookEntry>;

/**
 * What a webhook target POSTs as JSON (routines spec, "Delivery targets"):
 * `routine.result` for a delivered entry, or `routine.test` for
 * `routines.endpoints.test`, which names no routine or entry. Signed with
 * the `WEBHOOK_HEADERS`.
 */
export const WebhookPayload = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("routine.result"),
        ...webhookPart,
        routine: z.object({ id: RoutineId, name: RoutineName }).meta({ description: "The routine: its id and name." }),
        entry: WebhookEntry,
        text: webhookPart.text.meta({
          description: "The result, at most 16,000 characters: the firing's final text, empty when it had none, or a failing skip's detail.",
        }),
      })
      .meta({ description: "A routine's result: the environment, the routine, the entry, its summary and its text." }),
    z
      .object({
        type: z.literal("routine.test"),
        ...webhookPart,
        routine: z.null().meta({ description: "A test names no routine." }),
        entry: z.null().meta({ description: "A test names no entry." }),
        text: webhookPart.text.meta({ description: "What the test says, for a person reading where the receiver relays it." }),
      })
      .meta({ description: "An endpoint's test, from routines.endpoints.test: the environment, a summary and a text, and no routine or entry." }),
  ])
  .meta({ description: "What a webhook target POSTs as JSON, version 1: a routine's result, or an endpoint's test." });
export type WebhookPayload = z.infer<typeof WebhookPayload>;

/** Why a routine method is refused in `conflict` (its `data.reason`). */
export const ROUTINE_CONFLICT_REASONS = ["name_taken", "exists", "firing_running"] as const;
export const RoutineConflictReason = z.enum(ROUTINE_CONFLICT_REASONS).meta({
  description:
    "Why a routine method was refused in conflict: name_taken (another routine on the environment has the name, ignoring case), exists (a routine was made under the id on the environment already, deleted since or not) or firing_running (routines.runNow while a firing of the routine is live).",
});
export type RoutineConflictReason = z.infer<typeof RoutineConflictReason>;

/** What an import would leave a person to know: what this environment lacks, and the workspace as re-resolved here. */
export const RoutineImportWarnings = z
  .object({
    attention: setOf(RoutineAttention).meta({ description: "What the routine would need attention for here: an account, model, skill, script or endpoint this environment lacks." }),
    workspace: RoutineWorkspace.nullable().meta({
      description: "The workspace as re-resolved here, when the document's path is not usable on this environment: the most recently used checkout with its repository identity, else scratch; null when it is used as written.",
    }),
  })
  .meta({ description: "What importing a routine document would leave a person to know: the attention it would show here, and its workspace as re-resolved." });
export type RoutineImportWarnings = z.infer<typeof RoutineImportWarnings>;

/** One YAML document as `routines.checkImport` reads it. */
export const RoutineImportCheck = z
  .object({
    index: z.int().nonnegative().meta({ description: "The document's place in the file, from 0." }),
    definition: RoutineDefinition.nullable().meta({ description: "The definition as it would be saved; null when an issue refuses it." }),
    issues: z.array(SchemaIssue).meta({ description: "What is wrong in the document, each at its path; empty when nothing is." }),
    warnings: RoutineImportWarnings,
  })
  .meta({ description: "One routine document as an import would read it: the definition as it would be saved, the issues with their paths, and the warnings." });
export type RoutineImportCheck = z.infer<typeof RoutineImportCheck>;
