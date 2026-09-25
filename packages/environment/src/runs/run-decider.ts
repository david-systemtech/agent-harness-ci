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
  type RunOrigin,
  type RunPolicy,
  type RunPolicyResolvedPayload,
  type RunStartedPayload,
  type SendResponse,
  type Workspace,
} from "@agent-harness/contracts";
import { requireCapability } from "../adapter/capabilities.js";
import type { AdapterDescriptor, AttachmentData, ModelOption, PromptMessage } from "../adapter/contract.js";
import type { PolicySeam } from "../adapter/seams.js";
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
  /** The provider's session the run resumes, when the adapter can resume and a run linked one. */
  readonly resumeFrom: string | null;
  /**
   * Who asked (ADR 0006): its kind and its ceiling. The mode is clamped to
   * that ceiling and to the ceiling of every queued message the run reads,
   * so a run is never above the lowest ceiling of whoever sent what it reads.
   */
  readonly actor: RunActor;
  /** The policy resolver (#129): the run's mode clamped to the ceiling and the account's modes. */
  readonly resolvePolicy: PolicySeam;
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
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly AttachmentInput[];
}

/** Starting a run: where it came from, the message it starts with (none for a run of the queue alone), and what the command asks for. */
export interface StartCommand {
  readonly origin: RunOrigin;
  readonly message: SentMessage | null;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly mode?: Mode | undefined;
  /**
   * The run starts for the answers kept for the session's next run (#131: a
   * TTL answer whose run had gone), which it reads first: with no message
   * and nothing queued it still has something to read.
   */
  readonly keptAnswers?: boolean;
}

/** A run the host is to start once its events commit. */
export interface PlannedRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly account: AccountFacts;
  readonly model: string;
  readonly effort: string | null;
  /** The run's effective mode: its policy's. */
  readonly mode: Mode;
  readonly workspace: Workspace;
  readonly repositoryIdentity: string | null;
  readonly resumeFrom: string | null;
  /** Who asked: a run started from the queue after this one is resolved for the same actor, under its ceiling as it is then. */
  readonly actor: RunActor;
  /** The run's policy as resolved at its start, recorded as `run.policy.resolved`: fixed for the run, whatever changes after. */
  readonly policy: RunPolicy;
  /**
   * The messages the run starts with, in order: the queued ones, whose
   * attachments' bytes the host holds, then the one sent, with its bytes.
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

/** The one refusal of a run that is not on this environment: never started, or its session purged. */
export const runNotFound = (runId: string): RunRefusal => ({
  code: "not_found",
  message: `No run ${runId} is on this environment.`,
  data: { kind: "run", runId },
});

/** A request the schema let through that this environment cannot take: `invalid_params` at `path`. */
const invalid = (path: string, message: string): ContractError => new ContractError(invalidParams([{ code: "custom", path: [path], message }], message));

/** The bytes of an attachment, and what the log records of it; an attachment the adapter does not take is refused. */
const attachmentsOf = (descriptor: AdapterDescriptor, attachments: readonly AttachmentInput[]): { data: AttachmentData[]; records: AttachmentRecord[] } => {
  const data: AttachmentData[] = [];
  const records: AttachmentRecord[] = [];
  attachments.forEach((attachment, index) => {
    const flag = attachment.kind === "image" ? "imageInput" : "fileInput";
    requireCapability(descriptor, flag, ["attachments", index, "kind"], `take ${attachment.kind} attachments`);
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

/**
 * Starts a run: `run.started`, then its policy (`run.policy.resolved`, the
 * run's one, in the same append, so it precedes every event the provider
 * reports), then a `message.delivered` for each queued message it reads,
 * then `message.sent` for the message it starts with. A session not here is
 * not found; a live run is `run_active` (send is the way in); an account not
 * here, or not signed in, is `account_unavailable`; an account with no mode
 * at or below the ceiling is `mode_unavailable`. A mode above the ceiling,
 * or one the account lacks, is lowered, never refused.
 */
export const decideStart = (facts: StartFacts, command: StartCommand): StartDecision => {
  const { session, sessionId, runId } = facts;
  if (session === null || session.deleted) return { rejected: sessionNotFound(sessionId) };
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
  // The command's effort, which the model must take; else the default (`accounts.defaultEffort`) when the model takes it; else the model's own.
  const asked = command.effort ?? null;
  if (asked !== null && !model.efforts.includes(asked)) throw invalid("effort", `The model ${model.id} does not take the effort ${asked}.`);
  const fallback = facts.defaults.effort;
  const effort = asked ?? (fallback !== null && model.efforts.includes(fallback) ? fallback : null);
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
    resumedFrom: facts.resumeFrom,
    forkedFrom: null,
  };
  const events: EventInput[] = [{ type: "run.started", payload: started }, policyResolvedEvent(runId, policy)];
  for (const messageId of queuedIds) {
    const delivered: MessageDeliveredPayload = { runId, messageId, delivery: "prompt" };
    events.push({ type: "message.delivered", payload: delivered });
  }
  if (command.message !== null) {
    const { messageId, text } = command.message;
    events.push(sentEvent({ runId, messageId, text, attachments: attachments.records, delivery: "prompt", heldBy: null, ceiling: facts.actor.ceiling }));
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
      resumeFrom: facts.resumeFrom,
      actor: facts.actor,
      policy,
      prompt: [
        ...facts.queued.map((queued) => ({ messageId: queued.messageId, text: queued.text, attachments: [] })),
        ...(command.message === null ? [] : [{ messageId: command.message.messageId, text: command.message.text, attachments: attachments.data }]),
      ],
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
 * ends; `message.sent` records which.
 */
export const decideSend = (facts: StartFacts, message: SentMessage): SendDecision => {
  const { session, sessionId, live } = facts;
  if (session === null || session.deleted) return { rejected: sessionNotFound(sessionId) };
  if (live === null) {
    const started = decideStart(facts, { origin: "client", message });
    if (started.rejected !== undefined) return started;
    return { events: started.events, run: started.run, result: { runId: started.run.runId, messageId: message.messageId, delivery: "prompt", heldBy: null } };
  }
  const attachments = attachmentsOf(live.descriptor, message.attachments);
  const heldBy: QueueHolder = live.descriptor.providerQueue ? "provider" : "environment";
  const payload: MessageSentPayload = {
    runId: live.runId,
    messageId: message.messageId,
    text: message.text,
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
  /** The messages the session's provider holds, in the order sent. */
  readonly providerHeld: readonly string[];
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
 * here is not found. With nothing queued, by the provider or the
 * environment, nothing happens. With a run live, it is to be interrupted
 * (the host re-owns what its provider held and starts the next run after
 * the end); with none, the run of the environment's queue starts now, as
 * `decideStart` starts one with no message of its own, clamped to the
 * lowest ceiling among the caller and the queued senders.
 */
export const decideReadNow = (facts: ReadNowFacts): ReadNowDecision => {
  const { start } = facts;
  if (start.session === null || start.session.deleted) return { rejected: sessionNotFound(start.sessionId) };
  if (start.queued.length === 0 && facts.providerHeld.length === 0) return { nothing: true };
  if (facts.liveRunId !== null) return { interrupt: facts.liveRunId };
  // The provider holds messages with no run live to interrupt (a turn it opened waits to be adopted): that turn reads them.
  if (start.queued.length === 0) return { nothing: true };
  const decision = decideStart(start, { origin: "client", message: null });
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
   * message was not the provider's when the command began.
   */
  readonly provider: { readonly withdrawn: boolean } | null;
}

export type WithdrawDecision =
  | { readonly rejected: RunRefusal; readonly events?: undefined }
  | {
      readonly rejected?: undefined;
      readonly events: readonly EventInput[];
      readonly runId: string;
      readonly result: { readonly messageId: string; readonly sessionId: string; readonly heldBy: QueueHolder };
    };

/**
 * The session's draft once a withdrawn message's text is written into it:
 * the text in place of an empty draft, else after the draft on a paragraph
 * of its own, so nothing typed is lost (#228; Artemis takes a queued message
 * back only into an empty composer, which a draft every client shares cannot
 * promise); cut at the draft's limit.
 */
export const draftWithWithdrawn = (draft: string | null, text: string): string => (draft === null ? text : `${draft}\n\n${text}`).slice(0, MAX_DRAFT_LENGTH);

/**
 * Withdraws a queued message: `message.withdrawn`, under the run it was
 * sent during, then `session.draft-set` with its text written into the
 * draft, in one append. A message the environment holds leaves its queue; one the
 * provider holds is withdrawn only when the provider said it cancelled it.
 * An unknown message, one read (steered, delivered or a prompt), one
 * withdrawn already, and one the provider says it has read are `not_found`,
 * kind `message`; a message of a session not here is `not_found`, kind
 * `session`, before its state is looked at.
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
  if (message.heldBy === "provider") {
    // Provider-held from the send on; the provider was asked before the transaction began, unless it was not the provider's then, which no transition allows.
    if (facts.provider === null) {
      throw new ContractError({ code: "internal", message: `The message ${messageId} changed hands while it was being withdrawn; withdraw it again.`, data: {} });
    }
    if (!facts.provider.withdrawn) return gone("the provider has read it");
  }
  const heldBy: QueueHolder = message.heldBy;
  const withdrawn: MessageWithdrawnPayload = { runId: message.runId, messageId, heldBy };
  const events: EventInput[] = [{ type: "message.withdrawn", payload: withdrawn }];
  const draft = draftWithWithdrawn(facts.draft, message.text);
  if (draft !== facts.draft) events.push({ type: "session.draft-set", payload: { draft } });
  return { events, runId: message.runId, result: { messageId, sessionId: message.sessionId, heldBy } };
};
