import { describe, expect, it } from "vitest";
import { formatActor, parseActor } from "./envelope.js";

describe("an actor as the log stores it", () => {
  it("is kind:id, and reads back as the actor it was written from", () => {
    expect(formatActor({ kind: "client_session", id: "cs-1" })).toBe("client_session:cs-1");
    expect(parseActor("client_session:cs-1")).toEqual({ kind: "client_session", id: "cs-1" });
    expect(parseActor("system:lifecycle")).toEqual({ kind: "system", id: "lifecycle" });
    expect(parseActor("routine:nightly:backup")).toEqual({ kind: "routine", id: "nightly:backup" });
    for (const kind of ["client_session", "routine", "adapter", "system"] as const) {
      expect(parseActor(formatActor({ kind, id: "x" }))).toEqual({ kind, id: "x" });
    }
  });

  it("throws on read when it is not kind:id of a known kind, rather than becoming another actor", () => {
    for (const actor of ["test", "user:david", ":x", "system:", "", "System:lifecycle"]) {
      expect(() => parseActor(actor), actor).toThrow(`The log holds an actor that is not kind:id of a known kind`);
    }
  });
});
