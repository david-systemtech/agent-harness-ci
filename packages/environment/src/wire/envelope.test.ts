import { EventEnvelope as WireEnvelope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { openEventLog } from "../event-log/event-log.js";
import { toWireEnvelope } from "./envelope.js";

describe("the wire's envelope of a logged event", () => {
  const withLog = (work: (log: ReturnType<typeof openEventLog>) => void) => {
    const log = openEventLog({ path: ":memory:" });
    try {
      work(log);
    } finally {
      log.close();
    }
  };

  it("matches the contracts' envelope, the actor read into its kind and id", () => {
    withLog((log) => {
      const { events } = log.append(
        { kind: "probe", id: "a" },
        [{ type: "probe.poked", payload: { i: 1, list: [1, 2] }, metadata: { k: "v" } }],
        { actor: "adapter:claude" },
      );
      const [wire] = events.map(toWireEnvelope);
      expect(WireEnvelope.safeParse(wire).success).toBe(true);
      expect(wire).toMatchObject({
        actor: { kind: "adapter", id: "claude" },
        payload: { i: 1, list: [1, 2] },
        metadata: { k: "v" },
        streamKind: "probe",
        streamId: "a",
      });
    });
  });

  it("throws for an event whose stored actor is not kind:id, a row written around append", () => {
    withLog((log) => {
      const [event] = log.append({ kind: "probe", id: "a" }, [{ type: "probe.poked", payload: {} }], { actor: "system:test" }).events;
      if (!event) throw new Error("nothing was appended");
      expect(() => toWireEnvelope({ ...event, actor: "test" })).toThrow(/not kind:id/);
    });
  });
});
