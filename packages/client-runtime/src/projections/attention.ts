import type { InterruptCause, PromptKind, RunEndReason } from "@agent-harness/contracts";
import { notifyAll } from "../observable.js";
import type { Notice } from "../notices.js";

/**
 * The attention events (docs/specs/client-runtime.md, "Projections"): what
 * a renderer may want to surface beyond what it draws (a system
 * notification, a badge, a sound, a terminal bell): a run ended, a prompt
 * parked, a notice arrived. The runtime only emits them; it never calls the
 * shell for them (ADR 0004: the shell carries no session state, and whether
 * to notify is the renderer's), so a desktop renderer composes its own
 * title and body for `shell.notifications.show` and the terminal UI rings
 * its bell.
 *
 * Each is an event, not a value: there is nothing to `read`, and a renderer
 * that subscribes late hears only what comes after. They are emitted for
 * news only, as the notices are: a run ended or a prompt parked after the
 * stream synchronized, or replayed onto a cursor it held (while this client
 * was away); never for history replayed onto an empty cache.
 *
 * - `run-ended`: the session list carried a `run.ended`, for any session of
 *   an enabled environment, open or not;
 * - `prompt-parked`: the environment's `prompt.parked` notice;
 * - `notice-arrived`: a notice joined `projections.notices`, from any source.
 */
export type AttentionEvent =
  | {
      readonly kind: "run-ended";
      readonly environmentId: string;
      readonly sessionId: string;
      readonly runId: string;
      readonly reason: RunEndReason;
      readonly cause: InterruptCause | null;
    }
  | {
      readonly kind: "prompt-parked";
      readonly environmentId: string;
      readonly sessionId: string;
      readonly runId: string;
      readonly promptId: string;
      readonly promptKind: PromptKind;
      /** The session's title as the environment sent it with the notice. */
      readonly title: string;
      readonly summary: string;
    }
  | { readonly kind: "notice-arrived"; readonly notice: Notice };

/** A source of events a renderer follows: no current value, only what comes next. */
export interface Attention {
  /** Calls `listener` with each event from now on; returns the unsubscribe. */
  subscribe(listener: (event: AttentionEvent) => void): () => void;
}

export interface AttentionEmitter extends Attention {
  emit(event: AttentionEvent): void;
}

/** An emitter whose listeners' faults go to `report`, never to the emitter's caller. */
export const createAttention = (report: (error: unknown) => void): AttentionEmitter => {
  const listeners = new Set<(event: AttentionEvent) => void>();
  return {
    subscribe(listener) {
      const own = (event: AttentionEvent) => listener(event);
      listeners.add(own);
      return () => void listeners.delete(own);
    },
    emit(event) {
      try {
        notifyAll(listeners, event);
      } catch (error) {
        report(error);
      }
    },
  };
};
