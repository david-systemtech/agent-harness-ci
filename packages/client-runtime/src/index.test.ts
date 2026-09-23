import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { CLIENT_PROTOCOL_VERSION } from "./index.js";

describe("client runtime", () => {
  it("speaks the protocol version contracts defines", () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});
