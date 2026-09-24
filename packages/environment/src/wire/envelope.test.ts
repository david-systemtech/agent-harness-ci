import { EventEnvelope as WireEnvelope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { openEventLog } from "../event-log/event-log.js";
import { formatActor, parseActor, toWireEnvelope } from "./envelope.js";

describe("the wire's envelope of a logged event", () => {
  it("writes an actor as kind:id and reads it back", () => {
    expect(formatActor({ kind: "client_session", id: "cs-1" })).toBe("client_session:cs-1");
    expect(parseActor("client_session:cs-1")).toEqual({ kind: "client_session", id: "cs-1" });
    expect(parseActor("system:lifecycle")).toEqual({ kind: "system", id: "lifecycle" });
    expect(parseActor("routine:nightly:backup")).toEqual({ kind: "routine", id: "nightly:backup" });
  });

  it("reads an actor of no known kind, or not in the kind:id form, as a system component naming itself", () => {
    for (const actor of ["test", "user:david", ":x", "system:"]) expect(parseActor(actor), actor).toEqual({ kind: "system", id: actor });
  });

  it("matches the contracts' envelope, a payload that is no object carried under value", () => {
    const log = openEventLog({ path: ":memory:" });
    try {
      const stream = { kind: "probe", id: "a" };
      const { events } = log.append(
        stream,
        [
          { type: "probe.poked", payload: { i: 1 }, metadata: { k: "v" } },
          { type: "probe.poked", payload: [1, 2] },
          { type: "probe.poked", payload: "text" },
        ],
        { actor: "adapter:claude" },
      );
      const wire = events.map(toWireEnvelope);
      for (const envelope of wire) expect(WireEnvelope.safeParse(envelope).success).toBe(true);
      expect(wire.map((e) => e.payload)).toEqual([{ i: 1 }, { value: [1, 2] }, { value: "text" }]);
      expect(wire[0]).toMatchObject({ actor: { kind: "adapter", id: "claude" }, metadata: { k: "v" }, streamKind: "probe", streamId: "a" });
    } finally {
      log.close();
    }
  });
});
