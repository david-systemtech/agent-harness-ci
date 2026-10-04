import { describe, expect, it } from "vitest";
import { AttentionPayload, AttentionTargetInput } from "./attention.js";

describe("closed-client attention contracts", () => {
  it("admits only generic text and a canonical HTTPS session link", () => {
    const payload = { message: "A session needs you", url: "https://example.test:8443/#/session/env-1/session-1" };
    expect(AttentionPayload.parse(payload)).toEqual(payload);
    expect(AttentionPayload.safeParse({ ...payload, transcript: "private text" }).success).toBe(false);
    expect(AttentionPayload.safeParse({ ...payload, url: "http://example.test/" }).success).toBe(false);
    expect(AttentionPayload.safeParse({ ...payload, message: "Session title" }).success).toBe(false);
  });
  it("requires explicit completion opt-in and bounded transport configuration", () => {
    expect(AttentionTargetInput.safeParse({ id: "target-1", transport: "push", enabled: true, completion: false, configuration: {} }).success).toBe(true);
    expect(AttentionTargetInput.safeParse({ id: "target-1", transport: "push", enabled: true, configuration: {} }).success).toBe(false);
  });
});
