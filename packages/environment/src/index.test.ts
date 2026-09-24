import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_PROTOCOL_VERSION, openEventLog, type EventLog, type StreamRef } from "./index.js";

describe("environment", () => {
  it("serves the protocol version contracts defines", () => {
    expect(ENVIRONMENT_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });

  it("exports the event log from the package root", () => {
    const log: EventLog = openEventLog({ path: ":memory:" });
    const stream: StreamRef = { kind: "session", id: "s1" };
    log.append(stream, [{ type: "note.added", payload: { text: "hi" } }], { actor: "system:test" });
    expect(log.readStream(stream).map((e) => e.payload)).toEqual([{ text: "hi" }]);
    log.close();
  });
});
