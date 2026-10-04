import type { AttentionPayload, AttentionTargetInput } from "@agent-harness/contracts";

export interface AttentionDelivery {
  /** Stable for the event/target pair, including retry after a process restart. */
  readonly id: string;
  readonly payload: AttentionPayload;
  readonly target: AttentionTargetInput;
  readonly signal: AbortSignal;
}
export type AttentionSendResult = { readonly status: "sent" | "retry" | "retire" };
/** Transports own endpoint validation, secrets and network policy; dispatch owns durable work. */
export interface AttentionTransport {
  /** Returns a safe user-facing refusal, or undefined when the target is valid. */
  validate(target: AttentionTargetInput): string | undefined;
  send(delivery: AttentionDelivery): Promise<AttentionSendResult>;
}
export type AttentionTransports = Partial<Readonly<Record<AttentionTargetInput["transport"], AttentionTransport>>>;
