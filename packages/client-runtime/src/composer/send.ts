import type { AdapterCapabilities, AttachmentInput, QueueHolder } from "@agent-harness/contracts";
import type { CapabilityAnswer } from "../capabilities.js";
import type { RunState, SessionRun } from "../projections/runs.js";
import type { SessionProjection } from "../projections/session.js";
import { liveRun } from "../transcript/rows.js";
import type { Runtime } from "../runtime.js";

/**
 * Sending, steering, queueing and interrupting (docs/specs/tui.md, "The
 * composer"; docs/specs/gui.md, "A session pane"; ADR 0022; the
 * client-runtime spec's `runs:drive`), as every renderer's composer does
 * them. A send is
 * `runs.start` when the session has no live run and `runs.send` during
 * one, both under `runs:drive` and never queued by the outbox: while the
 * environment cannot take them, the send is refused at once with one line
 * and the composer is locked with the same reason (`capability`). During a
 * live run the message is the provider's to steer into the turn when its
 * adapter says it steers, else it waits on the queued line; the environment
 * says which in its answer and in `message.sent`, and a renderer only
 * draws it.
 */

/** Whether the composer can send now; the reason is the runtime's one line when it cannot. */
export type Lock = { readonly locked: false } | { readonly locked: true; readonly reason: string };

/** The lock from the runtime's answer for `runs.send` on the session's environment. */
export const lockOf = (answer: CapabilityAnswer): Lock => (answer.status === "present" ? { locked: false } : { locked: true, reason: answer.message });

/** A run is live on the session as far as a send is concerned: running, parked on a prompt, or starting. */
export const isLive = (state: RunState | undefined): boolean => state === "running" || state === "parked" || state === "starting";

/**
 * The run a send during a run joins and an interrupt stops: the one the
 * session's transcript holds running, else the one its run state names while
 * running or parked; undefined when none is known (a run still starting has
 * no id yet).
 */
export const liveRunIdOf = (view: Pick<SessionProjection, "runs">, run: Pick<SessionRun, "state" | "runId"> | undefined): string | undefined =>
  liveRun(view)?.runId ?? (run?.state === "running" || run?.state === "parked" ? (run.runId ?? undefined) : undefined);

/** A message as the composer hands it over. */
export interface OutgoingMessage {
  readonly text: string;
  readonly attachments: readonly AttachmentInput[];
}

export type SendOutcome =
  | { readonly ok: true; readonly messageId: string; readonly delivery: "prompt" | "queued"; readonly heldBy: QueueHolder | null }
  | { readonly ok: false; readonly line: string };

/**
 * Why the session's provider cannot take `attachments`, when it cannot, in
 * its own words and no more: images need `imageInput`, files `fileInput`
 * (claude-adapter spec). Unknown until `providers.list` has answered, and
 * then not refused here: the environment refuses what the adapter cannot do.
 */
const refusalOf = (attachments: readonly AttachmentInput[], provider: AdapterCapabilities | undefined): string | undefined => {
  if (provider === undefined || attachments.length === 0) return undefined;
  const images = attachments.filter((a) => a.kind === "image").length;
  const files = attachments.length - images;
  if (!provider.imageInput && !provider.fileInput) return `${provider.displayName} takes no attachments`;
  if (images > 0 && !provider.imageInput) return `${provider.displayName} takes no images`;
  if (files > 0 && !provider.fileInput) return `${provider.displayName} takes images but no other files`;
  return undefined;
};

/** Why the session's provider cannot take the message's attachments, when it cannot: the line that says nothing was sent. */
export const attachmentRefusal = (message: OutgoingMessage, provider: AdapterCapabilities | undefined): string | undefined => {
  const why = refusalOf(message.attachments, provider);
  return why === undefined ? undefined : `${why}: nothing was sent.`;
};

/** Why the session's provider cannot take one attachment as it is added, when it cannot: the line that says it was not attached. */
export const attachmentRefused = (attachment: AttachmentInput, provider: AdapterCapabilities | undefined): string | undefined => {
  const why = refusalOf([attachment], provider);
  return why === undefined ? undefined : `${why}: ${attachment.name} was not attached.`;
};

/**
 * Sends `message` to the session: `runs.start` with no run live, with the
 * model and effort `choice` names (`/model`; a null effort is the model's
 * own, which the environment's default effort does not replace, #1950),
 * `runs.send` during one. A start refused because a run went live meanwhile
 * (`conflict`, `run_active`) is sent again as `runs.send`, a new command.
 */
export const sendMessage = async (
  runtime: Runtime,
  environmentId: string,
  sessionId: string,
  message: OutgoingMessage,
  live: boolean,
  choice?: { readonly model: string; readonly effort: string | null },
): Promise<SendOutcome> => {
  const params = { sessionId, text: message.text, ...(message.attachments.length > 0 && { attachments: [...message.attachments] }) };
  if (!live) {
    // A run started here takes the model and effort `/model` chose for the session; a message queued behind a live run takes the run's.
    const started = await runtime.commands.dispatch(environmentId, "runs.start", {
      ...params,
      ...(choice && { model: choice.model, effort: choice.effort }),
    });
    if (started.ok) return { ok: true, messageId: started.result?.messageId ?? "", delivery: "prompt", heldBy: null };
    if (!(started.error.code === "conflict" && started.error.data?.["reason"] === "run_active")) return { ok: false, line: `Not sent: ${started.error.message}` };
  }
  const sent = await runtime.commands.dispatch(environmentId, "runs.send", params);
  if (!sent.ok) return { ok: false, line: `Not sent: ${sent.error.message}` };
  return { ok: true, messageId: sent.result?.messageId ?? "", delivery: sent.result?.delivery ?? "queued", heldBy: sent.result?.heldBy ?? null };
};

/** Interrupts the live run (`runs.interrupt`); the line to show when it could not. */
export const interruptRun = async (runtime: Runtime, environmentId: string, runId: string): Promise<string | undefined> => {
  const answer = await runtime.commands.dispatch(environmentId, "runs.interrupt", { runId });
  return answer.ok ? undefined : `Not interrupted: ${answer.error.message}`;
};

/**
 * Reads the session's queue now (`runs.readNow`, ADR 0022): the live run is
 * interrupted and the next opens with the queue. The line to show when it
 * was refused.
 */
export const readQueueNow = async (runtime: Runtime, environmentId: string, sessionId: string): Promise<string | undefined> => {
  const answer = await runtime.commands.dispatch(environmentId, "runs.readNow", { sessionId });
  return answer.ok ? undefined : `Not read now: ${answer.error.message}`;
};

/**
 * The environment's `not_found` for a withdraw says why the message is not
 * queued in its message only (`run-decider.ts`'s `decideWithdraw`: "… is on
 * this environment: the provider has read it", or "a run has read it"); the
 * data names the message, not the why. Read that way, the refusal is said as
 * the ticket words it; any other (withdrawn already, by another client, say)
 * is the environment's own message, so a change of its wording falls back to
 * that message rather than to a claim.
 */
const READ_FIRST = /: (the provider|a run) has read it\.$/;

/**
 * Takes a queued message back (`runs.withdraw`, ADR 0022): its text goes to
 * the session's draft, and so into every client's composer. The line to
 * show when it was refused: a message the provider read first is `not_found`,
 * said in one line, and it stays wherever the log says it is, since nothing
 * here moved it. An adapter that cannot withdraw is the environment's
 * refusal too (`invalid_params`, reason `unsupported`), said with its reason
 * and not kept: the environment asks the adapter only for a message the
 * provider holds, so the next withdraw may be one it can take back.
 */
export const withdrawQueued = async (runtime: Runtime, environmentId: string, messageId: string): Promise<string | undefined> => {
  const answer = await runtime.commands.dispatch(environmentId, "runs.withdraw", { messageId });
  if (answer.ok) return undefined;
  const { code, message } = answer.error;
  return code === "not_found" && READ_FIRST.test(message) ? "Not withdrawn: the provider read it first." : `Not withdrawn: ${message}`;
};

/**
 * Stops one running call (`x`, `row.stop`): delegated work the run's ledger
 * names for the call is stopped by `runs.stopTask`; any other call is the
 * run's, since no provider stops one call and leaves the turn going, so it
 * is the interrupt.
 */
export const stopCall = async (runtime: Runtime, environmentId: string, runId: string, taskId: string | undefined): Promise<string | undefined> => {
  if (taskId === undefined) return interruptRun(runtime, environmentId, runId);
  const answer = await runtime.commands.dispatch(environmentId, "runs.stopTask", { runId, taskId });
  return answer.ok ? undefined : `Not stopped: ${answer.error.message}`;
};
