import { BRIDGE_PROOF_TEST_VECTOR } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { proofOf } from "./proof.js";

describe("the proof", () => {
  it("is HMAC-SHA256 of the nonce as sent, keyed by the secret's 32 bytes, in lowercase hex: #541's test vector", async () => {
    const { secret, nonce, proof } = BRIDGE_PROOF_TEST_VECTOR;
    expect(await proofOf(secret, nonce)).toBe(proof);
  });
});
