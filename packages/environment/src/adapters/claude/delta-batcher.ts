import type { AdapterEvent } from "../../adapter/contract.js";
import type { Clock, Timer } from "../../serve/clock.js";

/**
 * The delta batcher (claude-adapter spec, "The transcript event vocabulary"):
 * the provider streams a fragment every few characters, and every fragment
 * as its own event would be a log row per token. So fragments for the open
 * item gather and leave as one `assistant.delta`, 100 milliseconds after the
 * first of them or once they reach 512 bytes (a chosen default), whichever
 * is first. Anything else a run reports sends the batch first, so a settled
 * item, a tool call or the end never overtakes the fragments before it.
 * The mapper stays pure; this sits between it and the run's stream, on the
 * environment's clock.
 */

export const DELTA_FLUSH_MS = 100;
export const DELTA_FLUSH_BYTES = 512;

type Fragment = { kind: "text" | "thinking"; text: string };

export interface DeltaBatcher {
  /** Takes one event: a delta joins the batch, anything else sends the batch and then itself. */
  push(event: AdapterEvent): void;
  /** Sends the batch now, if there is one. */
  flush(): void;
  /** Sends the batch and takes nothing more. */
  close(): void;
}

export const createDeltaBatcher = (clock: Pick<Clock, "setTimeout">, emit: (event: AdapterEvent) => void): DeltaBatcher => {
  let itemId: string | null = null;
  let fragments: Fragment[] = [];
  let bytes = 0;
  let timer: Timer | null = null;
  let closed = false;

  const flush = (): void => {
    timer?.cancel();
    timer = null;
    if (itemId === null || fragments.length === 0) return;
    const batch = { type: "assistant.delta" as const, payload: { itemId, fragments } };
    itemId = null;
    fragments = [];
    bytes = 0;
    emit(batch);
  };

  const add = (id: string, fragment: Fragment): void => {
    if (fragment.text === "") return;
    if (itemId !== null && itemId !== id) flush();
    itemId = id;
    const last = fragments.at(-1);
    if (last !== undefined && last.kind === fragment.kind) last.text += fragment.text;
    else fragments.push({ ...fragment });
    bytes += Buffer.byteLength(fragment.text, "utf8");
    if (bytes >= DELTA_FLUSH_BYTES) flush();
    else timer ??= clock.setTimeout(flush, DELTA_FLUSH_MS);
  };

  return {
    push(event) {
      if (closed) return;
      if (event.type === "assistant.delta") {
        for (const fragment of event.payload.fragments) add(event.payload.itemId, fragment);
        return;
      }
      flush();
      emit(event);
    },
    flush,
    close() {
      flush();
      closed = true;
    },
  };
};
