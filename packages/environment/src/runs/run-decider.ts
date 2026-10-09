import {
  ContractError,
  MAX_DRAFT_LENGTH,
  invalidParams,
  lowerMode,
  type AccountIdentity,
  type AttachmentInput,
  type AttachmentRecord,
  type MessageDeliveredPayload,
  type MessageSentPayload,
  type MessageWithdrawnPayload,
  type Mode,
  type QueueHolder,
  type RunBrowserResolution,
  type RunBrowserResolvedPayload,
  type RunOrigin,
  type RunPolicy,
  type RunPolicyResolvedPayload,
  type RunStartedPayload,
  type SendResponse,
  type Workspace,
} from "@agent-harness/contracts";
import type { SlashScope } from "../adapter/slash-resolution.js";
import { requireCapability } from "../adapter/capabilities.js";
import type { AdapterDescriptor, AttachmentData, ModelOption, PromptMessage, RunTarget } from "../adapter/contract.js";
import type { ClientTool, PolicySeam } from "../adapter/seams.js";
import type { BrowserSeam } from "../browser/run-browser.js";
import type { EventInput, JsonObject } from "../event-log/event-log.js";
import type { RunActor } from "../permissions/resolver.js";
import type { QueuedMessage, RunRow, SentMessageRow, SessionFacts } from "./run-reads.js";

/**
 * The run methods' decider (claude-adapter spec, "Wire methods"; ADR 0022):
 * pure, as the session decider is. Facts about the session, its live run
 * and its account, plus a command, give the events to append and what the
 * adapter host is to do once they commit, or a typed refusal. A request the
 * schema let through but this environment cannot take (a model not in the
 * catalogue, an attachment the adapter does not take) is thrown, as
 * `invalid_params`, and stores no receipt.
 */

/** Why a run command is refused: its target is not here, or the session's state does not allow it now. */
export type RunRefusal =
  | { readonly code: "not_found"; readonly message: string; readonly data: JsonObject & { readonly kind: "session" | "run" | "message" } }
  | { readonly code: "conflict"; readonly message: string; readonly data: JsonObject & { readonly reason: string } };

/** An account as a run needs it: whether it is signed in, as whom, and what its adapter offers. */
export interface AccountFacts {
  readonly id: string;
  readonly directory: string | null;
  /** The account's label, handed to the adapter for what a person reads; absent where the caller has none. */
  readonly label?: string;
  /** Whether the directory is the machine's own, adopted in place (ADR 0018): only the provider's own CLI reads and writes it. */
  readonly adopted: boolean;
  readonly signedIn: boolean;
  readonly identity: AccountIdentity | null;
  readonly descriptor: AdapterDescriptor;
  readonly models: readonly ModelOption[];
}

/** The session's live run, when there is one: its id, its adapter's descriptor, and the policy it started with. */
export interface LiveRunFacts {
  readonly runId: string;
  readonly descriptor: AdapterDescriptor;
  readonly policy: RunPolicy;
  /** The browser it resolved at its start, which the browser tools drive at each call (#551). */
  readonly browser: RunBrowserResolution;
}

/** What starting a run on a session depends on. */
export interface StartFacts {
  readonly sessionId: string;
  readonly session: SessionFacts | null;
  readonly live: LiveRunFacts | null;
  /** The account the run would use: the session's, else the environment's default; null when neither names one. */
  readonly accountId: string | null;
  /** That account as the host holds it; null when it is not on this environment. */
  readonly account: AccountFacts | null;
  /** The messages the environment holds for the session, which the run reads first. */
  readonly queued: readonly QueuedMessage[];
  /**
   * What the run continues from (`sessions/fork-rewind.ts`, `runContinuation`):
   * the provider conversation a run linked, a rewind of it, a fork's source's,
   * or nothing.
   */
  readonly target: RunTarget;
  /** The session the run's session was forked from, on a fork's first run; else null. */
  readonly forkedFrom: string | null;
  /**
   * Who asked (ADR 0006): its kind and its ceiling. The mode is clamped to
   * that ceiling and to the ceiling of every queued message the run reads,
   * so a run is never above the lowest ceiling of whoever sent what it reads.
   */
  readonly actor: RunActor;
  /** The policy resolver (#129): the run's mode clamped to the ceiling and the account's modes. */
  readonly resolvePolicy: PolicySeam;
  /** The browser resolver (#550): the session's browser as the run may drive it, by whether a person is present. */
  readonly resolveBrowser: BrowserSeam;
  /**
   * The Account step's defaults (#134): the family whose strongest model a
   * run takes when neither it nor its session names one, and the effort it
   * takes when it names none and its model takes that effort; null for the
   * catalogue's strongest model and the model's own effort.
   */
  readonly defaults: { readonly modelFamily: string | null; readonly effort: string | null };
  /** The id the run gets. */
  readonly runId: string;
}

/** A message a client sends: its minted id, its text and its attachments as sent. */
export interface SentMessage {
  readonly skill?: MessageSentPayload["skill"];
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly AttachmentInput[];
}

/** Starting a run: where it came from, the message it starts with (none for a run of the queue alone), and what the command asks for. */
export interface StartCommand {
  readonly origin: RunOrigin;
  readonly message: SentMessage | null;
  readonly model?: string | undefined;
  /** The run's effort; null for the model's own, whatever the default; the default's when absent. */
  readonly effort?: string | null | undefined;
  readonly mode?: Mode | undefined;
  /**
   * Text the run's instructions carry after the environment's composed ones,
   * never in their place: a completions request's `systemPrompt` and its
   * system and developer messages (#138). A run the environment starts from
   * the queue after it carries them too (the host's `NextRunBasis`).
   */
  readonly appendedInstructions?: string | undefined;
  readonly alwaysOn?: readonly string[] | undefined;
  /**
   * The tools a completions request declared for the caller to run (#139),
   * which the run's tool servers serve; a run of the queue takes the run
   * before it's, as it takes its instructions.
   */
  readonly clientTools?: readonly ClientTool[] | undefined;
  /**
   * The run starts for the answers kept for the session's next run (#131: a
   * TTL answer whose run had gone), which it reads first: with no message
   * and nothing queued it still has something to read.
   */
  readonly keptAnswers?: boolean;
  /**
   * The run reads its message before the queued ones, which follow it: an
   * update's continuation (#345), whose message tells the run why it goes
   * on before the session's queue does. Preset: the queue first, as it was
   * sent first.
   */
  readonly messageFirst?: boolean;
}

/** Where a run an actor starts comes from: a client session's is `client`, the completions surface's `completions`, a routine's or a bot's `routine` (ADR 0008: bots own routines). */
export const originOfActor = (actor: RunActor): RunOrigin => {
  switch (actor.kind) {
    case "client":
      return "client";
    case "completions":
      return "completions";
    case "routine":
    case "bot":
      return "routine";
  }
};

/**
 * The extra always-on names a run of the queue takes from the run before it
 * (#507): that run's, but a routine's or a bot's skills ride only its own
 * runs, so a run for anyone else, such as a person's read-now, takes none
 * of them (#531).
 */
export const carriedAlwaysOn = (before: { readonly actor: RunActor; readonly alwaysOn?: readonly string[] }, actor: RunActor): readonly string[] =>
  originOfActor(before.actor) === "routine" && originOfActor(actor) !== "routine" ? [] : (before.alwaysOn ?? []);

/** A run the host is to start once its events commit. */
export interface PlannedRun {
  readonly slash?: SlashScope | undefined;
  /** An initial message sent without slash preparation stays literal; queued messages still resolve for this run. */
  readonly literalPromptId?: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly account: AccountFacts;
  readonly model: string;
  readonly effort: string | null;
  /** The run's effective mode: its policy's. */
  readonly mode: Mode;
  readonly workspace: Workspace;
  readonly repositoryIdentity: string | null;
  /** What the run continues from, handed to its adapter as it is. */
  readonly target: RunTarget;
  /** Who asked: a run started from the queue after this one is resolved for the same actor, under its ceiling as it is then. */
  readonly actor: RunActor;
  /** The run's policy as resolved at its start, recorded as `run.policy.resolved`: fixed for the run, whatever changes after. */
  readonly policy: RunPolicy;
  /** The run's browser as resolved at its start, recorded as `run.browser.resolved`: fixed for the run, whatever the session's field says after. */
  readonly browser: RunBrowserResolution;
  /** What the run's instructions carry after the composed ones (`StartCommand.appendedInstructions`); null for nothing. */
  readonly appendedInstructions: string | null;
  /** Extra always-on names; kept in memory, inherited by runs of the queue. */
  readonly alwaysOn: readonly string[];
  /** The tools the caller runs (`StartCommand.clientTools`); empty for none. */
  readonly clientTools: readonly ClientTool[];
  /**
   * The messages the run starts with, in the order it reads them: the queued
   * ones, whose attachments' bytes the host holds, then the one sent, with
   * its bytes; the one sent first when the command asks (`messageFirst`).
   */
  readonly prompt: readonly PromptMessage[];
}

export type StartDecision =
  | { readonly rejected: RunRefusal; readonly events?: undefined }
  | { readonly events: readonly EventInput[]; readonly run: PlannedRun; readonly rejected?: undefined };

/** The refusal of a session that is not on this environment, as the session commands give it. */
const sessionNotFound = (sessionId: string): RunRefusal => ({
  code: "not_found",
  message: `No session ${sessionId} is on this environment.`,
  data: { kind: "session", sessionId },
});

const conflict = (sessionId: string, reason: string, message: string, data: JsonObject = {}): { readonly rejected: RunRefusal } => ({
  rejected: { code: "conflict", message, data: { reason, sessionId, ...data } },
});

/**
 * The refusal of a run command on a session whose workspace the
 * availability watcher has found gone (#328): nothing can run until
 * `sessions.setWorkspace` gives the session another. Null when the
 * workspace is not marked missing.
 */
const workspaceMissing = (sessionId: string, session: SessionFacts): { readonly rejected: RunRefusal } | null =>
  session.workspaceMissingSince === null
    ? null
    : conflict(
        sessionId,
        "workspace_missing",
        `The workspace ${session.workspace.path} of the session ${sessionId} is gone; give the session another with sessions.setWorkspace.`,
        { path: session.workspace.path },
      );

/** The one refusal of a run that is not on this environment: never started, or its session purged. */
export const runNotFound = (runId: string): RunRefusal => ({
  code: "not_found",
  message: `No run ${runId} is on this environment.`,
  data: { kind: "run", runId },
});

/** A request the schema let through that this environment cannot take: `invalid_params` at `path`. */
const invalid = (path: string, message: string): ContractError => new ContractError(invalidParams([{ code: "custom", path: [path], message }], message));

/**
 * Refuses the first attachment of a kind the adapter does not take,
 * `unsupported` at `attachments.<index>.kind` under `at`: the path a request
 * that carries them elsewhere names them by (the completions surface's
 * `agent-harness`).
 */
export const requireAttachmentKinds = (descriptor: AdapterDescriptor, attachments: readonly AttachmentInput[], at: readonly string[] = []): void => {
  attachments.forEach((attachment, index) => {
    const flag = attachment.kind === "image" ? "imageInput" : "fileInput";
    requireCapability(descriptor, flag, [...at, "attachments", index, "kind"], `take ${attachment.kind} attachments`);
  });
};

/** The bytes of an attachment, and what the log records of it; an attachment the adapter does not take is refused. */
const attachmentsOf = (descriptor: AdapterDescriptor, attachments: readonly AttachmentInput[]): { data: AttachmentData[]; records: AttachmentRecord[] } => {
  requireAttachmentKinds(descriptor, attachments);
  const data: AttachmentData[] = [];
  const records: AttachmentRecord[] = [];
  attachments.forEach((attachment) => {
    const bytes = new Uint8Array(Buffer.from(attachment.data, "base64"));
    data.push({ kind: attachment.kind, name: attachment.name, mediaType: attachment.mediaType, data: bytes });
    records.push({ kind: attachment.kind, name: attachment.name, mediaType: attachment.mediaType, size: bytes.byteLength });
  });
  return { data, records };
};

/**
 * The model a run uses: the one asked for, else the session's, else the
 * strongest of the default family (`accounts.defaultModelFamily`) when the
 * catalogue has it, else the catalogue's strongest; refused when the
 * catalogue lacks the one asked for.
 */
const modelOf = (account: AccountFacts, asked: string | null, family: string | null): ModelOption => {
  if (asked === null) {
    const ofFamily = family === null ? [] : account.models.filter((option) => option.family === family);
    const strongest = [...(ofFamily.length > 0 ? ofFamily : account.models)].sort((a, b) => b.tier - a.tier)[0];
    if (strongest === undefined) throw invalid("model", `The account ${account.id} offers no model.`);
    return strongest;
  }
  const model = account.models.find((option) => option.id === asked);
  if (model === undefined) throw invalid("model", `The account ${account.id} does not offer the model ${asked}.`);
  return model;
};

/** `message.sent` for a message a client sent, as the log records it. */
const sentEvent = (payload: MessageSentPayload): EventInput => ({ type: "message.sent", payload });

/** A run's policy as its `run.policy.resolved` records it. */
export const policyResolvedEvent = (runId: string, policy: RunPolicy): EventInput => {
  const payload: RunPolicyResolvedPayload = { runId, ...policy };
  return { type: "run.policy.resolved", payload };
};

/** A run's browser as its `run.browser.resolved` records it. */
export const browserResolvedEvent = (runId: string, browser: RunBrowserResolution): EventInput => {
  const payload: RunBrowserResolvedPayload = { runId, ...browser };
  return { type: "run.browser.resolved", payload };
};

/**
 * Starts a run: `run.started`, then its policy (`run.policy.resolved`, the
 * run's one, in the same append, so it precedes every event the provider
 * reports) and its browser (`run.browser.resolved`, resolved for whether the
 * policy found a person present), then a `message.delivered` for each queued message it reads,
 * then `message.sent` for the message it starts with. A session not here is
 * not found; one whose workspace is missing is `workspace_missing`, with the
 * path; a live run is `run_active` (send is the way in); an account not
 * here, or not signed in, is `account_unavailable`; an account with no mode
 * at or below the ceiling is `mode_unavailable`. A mode above the ceiling,
 * or one the account lacks, is lowered, never refused.
 */
export const decideStart = (facts: StartFacts, command: StartCommand): StartDecision => {
  const { session, sessionId, runId } = facts;
  if (session === null || session.deleted) return { rejected: sessionNotFound(sessionId) };
  const missing = workspaceMissing(sessionId, session);
  if (missing !== null) return missing;
  if (facts.live !== null) {
    return conflict(sessionId, "run_active", `A run of the session ${sessionId} is live; send the message to it with runs.send.`, { runId: facts.live.runId });
  }
  const account = facts.account;
  if (account === null || !account.signedIn) {
    const which =
      facts.accountId === null
        ? "No account is set for the session or the environment"
        : account === null
          ? `The account ${facts.accountId} is not on this environment`
          : `The account ${facts.accountId} is not signed in on this environment`;
    return conflict(sessionId, "account_unavailable", `${which}, so no run can start.`, { accountId: facts.accountId });
  }
  const { descriptor } = account;
  const attachments = attachmentsOf(descriptor, command.message?.attachments ?? []);
  const model = modelOf(account, command.model ?? session.model, facts.defaults.modelFamily);
  // The command's effort, which the model must take, or its null for the model's own; else the default (`accounts.defaultEffort`) when the model takes it; else the model's own.
  const asked = command.effort;
  if (typeof asked === "string" && !model.efforts.includes(asked)) throw invalid("effort", `The model ${model.id} does not take the effort ${asked}.`);
  const fallback = facts.defaults.effort;
  const effort = asked !== undefined ? asked : fallback !== null && model.efforts.includes(fallback) ? fallback : null;
  const requested = command.mode ?? session.mode;
  // The lowest of the asker's ceiling and each queued sender's (#119), which the policy resolves under (#129).
  const ceiling = [facts.actor.ceiling, ...facts.queued.map((queued) => queued.ceiling)].reduce(lowerMode);
  const policy = facts.resolvePolicy({ actor: { ...facts.actor, ceiling }, requested, accountModes: descriptor.modes, containment: session.containment });
  if ("refused" in policy) return conflict(sessionId, "mode_unavailable", policy.refused, { accountId: account.id, ceiling });

  const queuedIds = facts.queued.map((message) => message.messageId);
  if (command.message === null && queuedIds.length === 0 && command.keptAnswers !== true) throw new Error(`A run of session ${sessionId} was asked to start with nothing to read.`);
  const started: RunStartedPayload = {
    runId,
    accountId: account.id,
    identity: account.identity,
    model: model.id,
    effort,
    mode: { requested, effective: policy.mode.effective, clamped: policy.mode.clamped },
    workspace: session.workspace,
    origin: command.origin,
    promptMessageId: command.message?.messageId ?? null,
    queuedMessageIds: queuedIds,
    resumedFrom: facts.target.kind === "fresh" ? null : facts.target.providerSessionId,
    forkedFrom: facts.forkedFrom,
  };
  const queued: PromptMessage[] = facts.queued.map((message) => ({ messageId: message.messageId, text: message.text, attachments: [] }));
  const sent: PromptMessage[] = command.message === null ? [] : [{ messageId: command.message.messageId, text: command.message.text, attachments: attachments.data }];
  const browser = facts.resolveBrowser({ field: session.browser, attended: policy.attended });
  const events: EventInput[] = [{ type: "run.started", payload: started }, policyResolvedEvent(runId, policy), browserResolvedEvent(runId, browser)];
  for (const messageId of queuedIds) {
    const delivered: MessageDeliveredPayload = { runId, messageId, delivery: "prompt" };
    events.push({ type: "message.delivered", payload: delivered });
  }
  if (command.message !== null) {
    const { messageId, text } = command.message;
    events.push(sentEvent({ runId, messageId, text, ...(command.message.skill !== undefined && { skill: command.message.skill }), attachments: attachments.records, delivery: "prompt", heldBy: null, ceiling: facts.actor.ceiling }));
  }
  return {
    events,
    run: {
      runId,
      sessionId,
      account,
      model: model.id,
      effort,
      mode: policy.mode.effective,
      workspace: session.workspace,
      repositoryIdentity: session.repositoryIdentity,
      target: facts.target,
      actor: facts.actor,
      policy,
      browser,
      appendedInstructions: command.appendedInstructions === undefined || command.appendedInstructions.trim() === "" ? null : command.appendedInstructions,
      alwaysOn: command.alwaysOn ?? [],
      clientTools: command.clientTools ?? [],
      prompt: command.messageFirst === true ? [...sent, ...queued] : [...queued, ...sent],
    },
  };
};

/** A message the host is to hand the live run, or to hold for the next, once its event commits. */
export interface QueuedSend {
  readonly runId: string;
  readonly heldBy: QueueHolder;
  readonly message: PromptMessage;
}

export type SendDecision =
  | { readonly rejected: RunRefusal; readonly events?: undefined }
  | { readonly events: readonly EventInput[]; readonly result: SendResponse; readonly run: PlannedRun; readonly queued?: undefined; readonly rejected?: undefined }
  | { readonly events: readonly EventInput[]; readonly result: SendResponse; readonly queued: QueuedSend; readonly run?: undefined; readonly rejected?: undefined };

/**
 * Sends the session a message (ADR 0022). With no run live it starts one,
 * as `decideStart` does, the message its prompt. During a live run it is
 * queued: held by the provider when the adapter has a queue of its own,
 * else by the environment, which starts the next run with it when the turn
 * ends; `message.sent` records which. A session whose workspace is missing
 * takes none, live run or not: `workspace_missing`.
 */
export const decideSend = (facts: StartFacts, message: SentMessage, origin: RunOrigin = "client"): SendDecision => {
  const { session, sessionId, live } = facts;
  if (session === null || session.deleted) return { rejected: sessionNotFound(sessionId) };
  const missing = workspaceMissing(sessionId, session);
  if (missing !== null) return missing;
  if (live === null) {
    const started = decideStart(facts, { origin, message });
    if (started.rejected !== undefined) return started;
    return { events: started.events, run: started.run, result: { runId: started.run.runId, messageId: message.messageId, delivery: "prompt", heldBy: null } };
  }
  const attachments = attachmentsOf(live.descriptor, message.attachments);
  const heldBy: QueueHolder = live.descriptor.providerQueue ? "provider" : "environment";
  const payload: MessageSentPayload = {
    runId: live.runId,
    messageId: message.messageId,
    text: message.text,
    ...(message.skill !== undefined && { skill: message.skill }),
    attachments: attachments.records,
    delivery: "queued",
    heldBy,
    ceiling: facts.actor.ceiling,
  };
  return {
    events: [sentEvent(payload)],
    result: { runId: live.runId, messageId: message.messageId, delivery: "queued", heldBy },
    queued: { runId: live.runId, heldBy, message: { messageId: message.messageId, text: message.text, attachments: attachments.data } },
  };
};

/** What interrupting or stopping work on a run depends on: the run, its session, and whether the run is live now. */
export interface RunFacts {
  readonly runId: string;
  readonly run: RunRow | null;
  readonly session: SessionFacts | null;
  /** The live run's adapter's descriptor, when this run is the session's live run; null once it has ended. */
  readonly live: AdapterDescriptor | null;
  /** The descriptor of the adapter the run went through, live or ended; null when its account is no longer here. */
  readonly descriptor?: AdapterDescriptor | null;
}

export type RunCommandDecision = { readonly rejected: RunRefusal } | { readonly rejected?: undefined; readonly ended: boolean };

/** The run a command names, or its refusal: an unknown run, or one whose session is not here. */
const presentRun = (facts: RunFacts): RunRefusal | null => {
  if (facts.run === null) return runNotFound(facts.runId);
  if (facts.session === null || facts.session.deleted) return sessionNotFound(facts.run.sessionId);
  return null;
};

/** Interrupts a live run; a run that has ended is `ended`, and nothing happens: idempotent. */
export const decideInterrupt = (facts: RunFacts): RunCommandDecision => {
  const refusal = presentRun(facts);
  if (refusal !== null) return { rejected: refusal };
  return { ended: facts.live === null };
};

/**
 * Stops one piece of a live run's delegated work, which needs the adapter's
 * `subagents`. A run that has ended, or a task its ledger says has settled,
 * is `ended`, and nothing happens: idempotent.
 */
export const decideStopTask = (facts: RunFacts, taskStatus: string | null): RunCommandDecision => {
  const refusal = presentRun(facts);
  if (refusal !== null) return { rejected: refusal };
  // What the adapter cannot do is refused whether or not the run has ended.
  const descriptor = facts.live ?? facts.descriptor ?? null;
  if (descriptor !== null) requireCapability(descriptor, "subagents", ["taskId"], "stop delegated work");
  if (facts.live === null) return { ended: true };
  return { ended: taskStatus !== null && ["completed", "failed", "stopped"].includes(taskStatus) };
};

/** What reading a session's queue now depends on (ADR 0022, #228): the start's facts, and what the provider holds for the session. */
export interface ReadNowFacts {
  readonly start: StartFacts;
  /** The session's live run as the host runs it; null when none is (a turn waiting on a mode change is not one). */
  readonly liveRunId: string | null;
  /**
   * The messages the session's provider holds, in the order sent: the log's
   * record, which is the provider's queue, since every message leaving it is
   * logged (read, taken back at an end or an interrupt, withdrawn), and the
   * queue is the session's, not the live run's (a replaced process hands its
   * queue on, under the runs they were sent during).
   */
  readonly providerHeld: readonly string[];
  /**
   * The run before, whose model and effort the run of the queue takes, and
   * its own instructions, client tools and extra always-on names (a
   * completions request's, #138, #139, #507; never a routine's, #531), as
   * the queue's run after it would; null before the session's first run.
   */
  readonly basis: {
    readonly actor: RunActor;
    readonly model: string;
    readonly effort: string | null;
    readonly appendedInstructions: string | null;
    readonly alwaysOn?: readonly string[];
    readonly clientTools: readonly ClientTool[];
  } | null;
}

export type ReadNowDecision =
  | { readonly rejected: RunRefusal }
  /** Nothing is queued: accepted with no event, and a live run is left alone (the chosen default, #228). */
  | { readonly rejected?: undefined; readonly nothing: true }
  /** A run is live: the host interrupts it with cause `read-now` once the command commits, and starts the queue's run after its end. */
  | { readonly rejected?: undefined; readonly nothing?: undefined; readonly interrupt: string }
  /** No run is live: the queue's run starts in the command's transaction. */
  | { readonly rejected?: undefined; readonly nothing?: undefined; readonly interrupt?: undefined; readonly events: readonly EventInput[]; readonly run: PlannedRun };

/**
 * Reads the session's queue now (ADR 0022: `runs.readNow`). A session not
 * here is not found, and one whose workspace is missing `workspace_missing`,
 * whatever is queued. With nothing queued, by the provider or the
 * environment, nothing happens. With a run live, it is to be interrupted
 * (the host re-owns what its provider held and starts the next run after
 * the end); with none, the run of the environment's queue starts now, as
 * the environment's queue would start it after the run before (its model,
 * effort and own instructions), for the caller, clamped to the lowest
 * ceiling among the caller and the queued senders.
 */
export const decideReadNow = (facts: ReadNowFacts): ReadNowDecision => {
  const { start, basis } = facts;
  if (start.session === null || start.session.deleted) return { rejected: sessionNotFound(start.sessionId) };
  const missing = workspaceMissing(start.sessionId, start.session);
  if (missing !== null) return missing;
  if (start.queued.length === 0 && facts.providerHeld.length === 0) return { nothing: true };
  if (facts.liveRunId !== null) return { interrupt: facts.liveRunId };
  // The provider holds messages with no run live to interrupt (a turn it opened waits to be adopted): that turn reads them.
  if (start.queued.length === 0) return { nothing: true };
  const decision = decideStart(start, {
    origin: "client",
    message: null,
    ...(basis !== null && { model: basis.model }),
    ...(basis?.effort !== null && basis?.effort !== undefined && { effort: basis.effort }),
    ...(basis !== null && basis.appendedInstructions !== null && { appendedInstructions: basis.appendedInstructions }),
    ...(basis !== null && { clientTools: basis.clientTools, alwaysOn: carriedAlwaysOn(basis, start.actor) }),
  });
  if (decision.rejected !== undefined) return { rejected: decision.rejected };
  return { events: decision.events, run: decision.run };
};

/** What withdrawing a queued message depends on (ADR 0022: `runs.withdraw`, #228). */
export interface WithdrawFacts {
  readonly messageId: string;
  readonly message: SentMessageRow | null;
  /** The message's session; null when it has none here. */
  readonly session: SessionFacts | null;
  /** The session's draft as it stands. */
  readonly draft: string | null;
  /**
   * What the provider answered when it was asked to take the message back,
   * before the command's transaction; null when it was not asked, since the
   * message was not the provider's when the command began. A message it gave
   * up is the environment's by the time the command decides (the host takes
   * it back at once).
   */
  readonly provider: { readonly withdrawn: boolean } | null;
}

export type WithdrawDecision =
  | { readonly rejected: RunRefusal }
  | {
      readonly rejected?: undefined;
      /** `message.withdrawn`, correlated to the run the message was sent during. */
      readonly withdrawn: EventInput;
      /** `session.draft-set` with the text written in: the session's own field, correlated to no run. */
      readonly draft: EventInput;
      readonly runId: string;
      readonly result: { readonly messageId: string; readonly sessionId: string; readonly heldBy: QueueHolder };
    };

/**
 * The session's draft once a withdrawn message's text is written into it:
 * the text in place of an empty draft, else after the draft on a paragraph
 * of its own, so nothing typed is lost (#228: taking a queued message back
 * only into an empty composer is not possible here, since the draft is
 * shared by every client). Null when the result would pass the draft's
 * limit: nothing is cut, and the withdraw is refused `draft_full`.
 */
export const draftWithWithdrawn = (draft: string | null, text: string): string | null => {
  const written = draft === null ? text : `${draft}\n\n${text}`;
  return written.length > MAX_DRAFT_LENGTH ? null : written;
};

/**
 * Withdraws a queued message: `message.withdrawn`, under the run it was
 * sent during, and `session.draft-set` with its text written into the
 * draft, in one transaction. An environment-held message leaves the queue:
 * one the environment held all along, or one the provider gave up for this
 * withdraw (`heldBy` then says `provider`). An unknown message, one read
 * (steered, delivered or a prompt), one withdrawn already, and one the
 * provider says it no longer holds (it read it) are `not_found`, kind
 * `message`; a message of a session not here is `not_found`, kind
 * `session`, before its state is looked at; a draft with no room for the
 * text is `conflict`, reason `draft_full`, and the message stays queued,
 * checked after the provider's word, so a message it read is `not_found`
 * whatever the draft holds.
 */
export const decideWithdraw = (facts: WithdrawFacts): WithdrawDecision => {
  const { message, messageId } = facts;
  const gone = (why: string): { readonly rejected: RunRefusal } => ({
    rejected: { code: "not_found", message: `No queued message ${messageId} is on this environment: ${why}.`, data: { kind: "message", messageId } },
  });
  if (message === null) return gone("it was never sent here, or its session was purged");
  if (facts.session === null || facts.session.deleted) return { rejected: sessionNotFound(message.sessionId) };
  if (message.heldBy === "read") return gone("a run has read it");
  if (message.heldBy === "withdrawn") return gone("it was withdrawn already");
  // Read by the provider while the withdraw waited on its answer: gone whatever the draft holds, so no refusal promises a retry.
  if (message.heldBy === "provider" && facts.provider?.withdrawn === false) return gone("the provider has read it");
  const draft = draftWithWithdrawn(facts.draft, message.text);
  if (draft === null) {
    return conflict(message.sessionId, "draft_full", `The session's draft has no room for the text of message ${messageId}; clear or shorten the draft, then withdraw it again.`, {
      messageId,
      limit: MAX_DRAFT_LENGTH,
    });
  }
  // Still the provider's and it was not asked, which no transition allows (a draft with no room was refused above, unasked).
  if (message.heldBy === "provider" && facts.provider === null) {
    throw new ContractError({ code: "internal", message: `The message ${messageId} changed hands while it was being withdrawn; withdraw it again.`, data: {} });
  }
  const heldBy: QueueHolder = facts.provider?.withdrawn === true ? "provider" : message.heldBy;
  const withdrawn: MessageWithdrawnPayload = { runId: message.runId, messageId, heldBy };
  return {
    withdrawn: { type: "message.withdrawn", payload: withdrawn },
    draft: { type: "session.draft-set", payload: { draft } },
    runId: message.runId,
    result: { messageId, sessionId: message.sessionId, heldBy },
  };
};
