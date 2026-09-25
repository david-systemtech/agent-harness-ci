import type { CapabilityAnswer, RunState, Runtime } from "@agent-harness/client-runtime";
import type { AdapterCapabilities, AttachmentInput, QueueHolder } from "@agent-harness/contracts";

/**
 * Sending, steering, queueing and interrupting (docs/specs/tui.md, "The
 * composer"; ADR 0022; the client-runtime spec's `runs:drive`). A send is
 * `runs.start` when the session has no live run and `runs.send` during
 * one, both under `runs:drive` and never queued by the outbox: while the
 * environment cannot take them, the send is refused at once with one line
 * and the composer is locked with the same reason (`capability`). During a
 * live run the message is the provider's to steer into the turn when its
 * adapter says it steers, else it waits on the queued line; the environment
 * says which in its answer and in `message.sent`, and the terminal only
 * draws it.
 */

/** Whether the composer can send now; the reason is the runtime's one line when it cannot. */
export type Lock = { readonly locked: false } | { readonly locked: true; readonly reason: string };

/** The lock from the runtime's answer for `runs.send` on the session's environment. */
export const lockOf = (answer: CapabilityAnswer): Lock => (answer.status === "present" ? { locked: false } : { locked: true, reason: answer.message });

/** A run is live on the session as far as a send is concerned: running, parked on a prompt, or starting. */
export const isLive = (state: RunState | undefined): boolean => state === "running" || state === "parked" || state === "starting";

/** A message as the composer hands it over. */
export interface Message {
  readonly text: string;
  readonly attachments: readonly AttachmentInput[];
}

export type SendOutcome =
  | { readonly ok: true; readonly messageId: string; readonly delivery: "prompt" | "queued"; readonly heldBy: QueueHolder | null }
  | { readonly ok: false; readonly line: string };

/**
 * Why the session's provider cannot take the message's attachments, when it
 * cannot: images need `imageInput`, files `fileInput` (claude-adapter spec).
 * Unknown until `providers.list` has answered, and then not refused here: the
 * environment refuses what the adapter cannot do.
 */
export const attachmentRefusal = (message: Message, provider: AdapterCapabilities | undefined): string | undefined => {
  if (provider === undefined) return undefined;
  const images = message.attachments.filter((a) => a.kind === "image").length;
  const files = message.attachments.length - images;
  if (!provider.imageInput && !provider.fileInput && message.attachments.length > 0) return `${provider.displayName} takes no attachments: nothing was sent.`;
  if (images > 0 && !provider.imageInput) return `${provider.displayName} takes no images: nothing was sent.`;
  if (files > 0 && !provider.fileInput) return `${provider.displayName} takes images but no other files: nothing was sent.`;
  return undefined;
};

/**
 * Sends `message` to the session: `runs.start` with no run live, with the
 * model and effort `choice` names (`/model`), `runs.send` during one. A
 * start refused because a run went live meanwhile (`conflict`,
 * `run_active`) is sent again as `runs.send`, a new command.
 */
export const sendMessage = async (
  runtime: Runtime,
  environmentId: string,
  sessionId: string,
  message: Message,
  live: boolean,
  choice?: { readonly model: string; readonly effort: string | null },
): Promise<SendOutcome> => {
  const params = { sessionId, text: message.text, ...(message.attachments.length > 0 && { attachments: [...message.attachments] }) };
  if (!live) {
    // A run started here takes the model and effort `/model` chose for the session; a message queued behind a live run takes the run's.
    const started = await runtime.commands.dispatch(environmentId, "runs.start", {
      ...params,
      ...(choice && { model: choice.model }),
      ...(choice?.effort != null && { effort: choice.effort }),
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
 * Stops one running call (`x`, `row.stop`): delegated work the run's ledger
 * names for the call is stopped by `runs.stopTask`; any other call is the
 * run's, since no provider stops one call and leaves the turn going, so it
 * is the interrupt (Artemis's rule).
 */
export const stopCall = async (runtime: Runtime, environmentId: string, runId: string, taskId: string | undefined): Promise<string | undefined> => {
  if (taskId === undefined) return interruptRun(runtime, environmentId, runId);
  const answer = await runtime.commands.dispatch(environmentId, "runs.stopTask", { runId, taskId });
  return answer.ok ? undefined : `Not stopped: ${answer.error.message}`;
};
