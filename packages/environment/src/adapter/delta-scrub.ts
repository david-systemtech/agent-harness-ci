import { AssistantDeltaPayload, type AssistantDeltaPayload as Delta } from "@agent-harness/contracts";
import type { ScrubRegistry, ScrubStream } from "../scrub/registry.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { TranscriptEvent } from "./contract.js";

/** The same maximum hold-back as terminal output, on the environment's clock. */
export const DELTA_HOLD_BACK_MS = 50;

type Kind = Delta["fragments"][number]["kind"];
interface HeldKind {
  readonly output: ScrubStream;
  timer: Timer | undefined;
}

/**
 * One run's assistant output before scoped append: each item's text and
 * thinking are independent streams. Unambiguous text is appended immediately;
 * a possible registered prefix waits for its continuation, settlement or end,
 * for at most fifty milliseconds from when it was first held.
 */
export const createDeltaAppend = (options: {
  readonly scrub: ScrubRegistry;
  readonly clock: Clock;
  readonly runId: string;
  readonly append: (event: TranscriptEvent) => unknown;
  readonly onError: (error: unknown) => void;
}): { append(event: TranscriptEvent): void; flush(): void } => {
  const items = new Map<string, Map<Kind, HeldKind>>();
  const show = (itemId: string, kind: Kind, text: string): void => {
    if (text !== "") options.append({ type: "assistant.delta", payload: { itemId, fragments: [{ kind, text }] } });
  };
  const flushItem = (itemId: string): void => {
    const kinds = items.get(itemId);
    items.delete(itemId);
    if (kinds === undefined) return;
    for (const held of kinds.values()) held.timer?.cancel();
    for (const [kind, held] of kinds) show(itemId, kind, held.output.flush());
  };
  return {
    append(event) {
      if (event.type !== "assistant.delta") {
        if (event.type === "assistant.text" || event.type === "assistant.thinking") flushItem(event.payload.itemId);
        options.append(event);
        return;
      }
      // Validate before buffering: an empty or malformed batch still fails the run.
      const delta = AssistantDeltaPayload.parse({ ...event.payload, runId: options.runId });
      let kinds = items.get(delta.itemId);
      if (kinds === undefined) {
        kinds = new Map();
        items.set(delta.itemId, kinds);
      }
      const fragments: Delta["fragments"] = [];
      for (const { kind, text } of delta.fragments) {
        let held = kinds.get(kind);
        if (held === undefined) {
          held = { output: options.scrub.stream(), timer: undefined };
          kinds.set(kind, held);
        }
        const out = held.output.push(text);
        if (out !== "") fragments.push({ kind, text: out });
        if (!held.output.holding) {
          held.timer?.cancel();
          held.timer = undefined;
        } else if (held.timer === undefined) {
          const pending = held;
          pending.timer = options.clock.setTimeout(() => {
            pending.timer = undefined;
            try {
              show(delta.itemId, kind, pending.output.flush());
            } catch (error) {
              options.onError(error);
            }
          }, DELTA_HOLD_BACK_MS);
        }
      }
      if (fragments.length > 0) options.append({ type: "assistant.delta", payload: { itemId: delta.itemId, fragments } });
    },
    flush() {
      const pending = [...items];
      items.clear();
      // Cancel every timer before any append, which may fail while ending a run.
      for (const [, kinds] of pending) for (const held of kinds.values()) held.timer?.cancel();
      for (const [itemId, kinds] of pending) for (const [kind, held] of kinds) show(itemId, kind, held.output.flush());
    },
  };
};
