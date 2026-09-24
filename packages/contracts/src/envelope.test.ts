import { describe, expect, it } from "vitest";
import { validEnvelope } from "../test/fixtures.js";
import { ACTOR_KINDS, EventEnvelope } from "./index.js";

describe("the event envelope", () => {
  it("has the fields the env spec lists, in its order", () => {
    expect(Object.keys(EventEnvelope.shape)).toEqual([
      "sequence",
      "eventId",
      "streamKind",
      "streamId",
      "streamVersion",
      "type",
      "occurredAt",
      "commandId",
      "causationId",
      "correlationId",
      "actor",
      "payload",
      "metadata",
    ]);
  });

  it("names a command, causation and correlation id only when there is one, as null otherwise", () => {
    const bare = { ...validEnvelope, commandId: null, causationId: null, correlationId: null };
    expect(EventEnvelope.parse(bare)).toEqual(bare);
    const missing = Object.fromEntries(Object.entries(bare).filter(([key]) => key !== "correlationId"));
    expect(EventEnvelope.safeParse(missing).success).toBe(false);
  });

  it("is caused by a client session, a routine, an adapter or the system", () => {
    expect(ACTOR_KINDS).toEqual(["client_session", "routine", "adapter", "system"]);
  });
});
