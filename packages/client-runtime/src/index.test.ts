import { PROTOCOL_VERSION as CONTRACTS_PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.js";

describe("client runtime", () => {
  it("speaks the protocol version contracts defines", () => {
    expect(PROTOCOL_VERSION).toBe(CONTRACTS_PROTOCOL_VERSION);
  });
});
