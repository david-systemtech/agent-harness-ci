import { describe, expect, it } from "vitest";
import { manualClock } from "../../../test/clock.js";
import type { AdapterEvent } from "../../adapter/contract.js";
import { DELTA_FLUSH_BYTES, DELTA_FLUSH_MS, createDeltaBatcher } from "./delta-batcher.js";

/**
 * The delta batcher (claude-adapter spec, "The transcript event vocabulary":
 * `assistant.delta` flushed every 100 milliseconds or 512 bytes, a chosen
 * default): fragments for the open item gather and leave as one event, on
 * the clock or the size, and never behind an event that follows them.
 */

const delta = (itemId: string, text: string, kind: "text" | "thinking" = "text"): AdapterEvent => ({
  type: "assistant.delta",
  payload: { itemId, fragments: [{ kind, text }] },
});

const setup = () => {
  const clock = manualClock();
  const out: AdapterEvent[] = [];
  const batcher = createDeltaBatcher(clock, (event) => out.push(event));
  return { clock, out, batcher };
};

describe("the delta batcher", () => {
  it("holds fragments and sends them as one batch 100 ms after the first", () => {
    const { clock, out, batcher } = setup();
    batcher.push(delta("i1", "Hel"));
    clock.advance(40);
    batcher.push(delta("i1", "lo, "));
    batcher.push(delta("i1", "world"));
    expect(out).toEqual([]);
    clock.advance(DELTA_FLUSH_MS - 41);
    expect(out).toEqual([]);
    clock.advance(1);
    expect(out).toEqual([{ type: "assistant.delta", payload: { itemId: "i1", fragments: [{ kind: "text", text: "Hello, world" }] } }]);
    clock.advance(1_000);
    expect(out).toHaveLength(1);
  });

  it("sends at once when the batch reaches 512 bytes, counted in UTF-8", () => {
    const { clock, out, batcher } = setup();
    batcher.push(delta("i1", "a".repeat(DELTA_FLUSH_BYTES - 2)));
    expect(out).toEqual([]);
    batcher.push(delta("i1", "é"));
    expect(out).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("keeps text and thinking apart within a batch, in the order they came", () => {
    const { clock, out, batcher } = setup();
    batcher.push(delta("i1", "Let me ", "thinking"));
    batcher.push(delta("i1", "think.", "thinking"));
    batcher.push(delta("i1", "Answer", "text"));
    clock.advance(DELTA_FLUSH_MS);
    expect(out).toEqual([
      {
        type: "assistant.delta",
        payload: {
          itemId: "i1",
          fragments: [
            { kind: "thinking", text: "Let me think." },
            { kind: "text", text: "Answer" },
          ],
        },
      },
    ]);
  });

  it("sends a batch before a fragment for another item", () => {
    const { out, batcher } = setup();
    batcher.push(delta("i1", "one"));
    batcher.push(delta("i2", "two"));
    expect(out).toEqual([{ type: "assistant.delta", payload: { itemId: "i1", fragments: [{ kind: "text", text: "one" }] } }]);
  });

  it("sends a batch before any other event, so the settled item never overtakes its fragments", () => {
    const { clock, out, batcher } = setup();
    batcher.push(delta("i1", "Hi"));
    batcher.push({ type: "assistant.text", payload: { itemId: "i1", text: "Hi", aborted: false } });
    expect(out.map((event) => event.type)).toEqual(["assistant.delta", "assistant.text"]);
    expect(clock.pending()).toBe(0);
  });

  it("passes other events straight through, and drops empty fragments", () => {
    const { clock, out, batcher } = setup();
    batcher.push(delta("i1", ""));
    batcher.push({ type: "end", reason: "completed" });
    clock.advance(DELTA_FLUSH_MS);
    expect(out).toEqual([{ type: "end", reason: "completed" }]);
  });

  it("flushes on demand, and does nothing after it is closed", () => {
    const { clock, out, batcher } = setup();
    batcher.push(delta("i1", "partial"));
    batcher.flush();
    expect(out).toHaveLength(1);
    batcher.push(delta("i1", "late"));
    batcher.close();
    clock.advance(DELTA_FLUSH_MS);
    expect(out).toHaveLength(2);
    batcher.push(delta("i1", "after"));
    clock.advance(DELTA_FLUSH_MS);
    expect(out).toHaveLength(2);
  });
});
