import { describe, expect, it } from "vitest";
import { CAPABILITY_FLAG_LIST, CapabilityFlag, CapabilityFlags, PROTOCOL_VERSION, ProtocolVersion, supports } from "./index.js";

describe("protocol negotiation", () => {
  it("is one integer, 1, and a client may announce any positive integer", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(ProtocolVersion.safeParse(PROTOCOL_VERSION).success).toBe(true);
    expect(ProtocolVersion.safeParse(2).success).toBe(true);
    expect(ProtocolVersion.safeParse("1").success).toBe(false);
  });

  it("carries capability flags as a set of strings", () => {
    expect(CapabilityFlags.safeParse(["terminal", "files"]).success).toBe(true);
    expect(CapabilityFlags.safeParse(["terminal", "terminal"]).success).toBe(false);
    expect(CapabilityFlags.safeParse([1]).success).toBe(false);
  });

  it("treats an absent flag as unsupported", () => {
    expect(supports(["terminal"], "terminal")).toBe(true);
    expect(supports(["terminal"], "files")).toBe(false);
    expect(supports([], "terminal")).toBe(false);
  });

  it("keeps a flag list of distinct, well-formed flags, which a hello may carry", () => {
    expect(new Set(CAPABILITY_FLAG_LIST).size).toBe(CAPABILITY_FLAG_LIST.length);
    for (const flag of CAPABILITY_FLAG_LIST) expect(CapabilityFlag.safeParse(flag).success, flag).toBe(true);
    expect(CapabilityFlags.safeParse([...CAPABILITY_FLAG_LIST]).success).toBe(true);
  });
});
