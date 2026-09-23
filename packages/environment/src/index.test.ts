import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_PROTOCOL_VERSION } from "./index.js";

describe("environment", () => {
  it("serves the protocol version contracts defines", () => {
    expect(ENVIRONMENT_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});
