import { describe, expect, it } from "vitest";
import { DISCOVERY_PATH, HEALTH_PATH, PRODUCT_NAME, PROTOCOL_VERSION } from "./index.js";

describe("contracts", () => {
  it("speaks protocol version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("names the product with the placeholder name", () => {
    expect(PRODUCT_NAME).toBe("agent-harness");
  });

  it("puts the discovery document at the well-known path named after the product, and health at /health", () => {
    expect(DISCOVERY_PATH).toBe("/.well-known/agent-harness/environment");
    expect(HEALTH_PATH).toBe("/health");
  });
});
