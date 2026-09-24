import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_GRANT_FILE,
  BOOTSTRAP_PATH,
  DISCOVERY_PATH,
  HEALTH_PATH,
  PAIR_PATH,
  PRODUCT_NAME,
  PROTOCOL_VERSION,
  WIRE_PATH,
} from "./index.js";

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

  it("puts the wire at /ws and the bootstrap exchange at /api/bootstrap, and names the grant file", () => {
    expect(WIRE_PATH).toBe("/ws");
    expect(BOOTSTRAP_PATH).toBe("/api/bootstrap");
    expect(BOOTSTRAP_GRANT_FILE).toBe("bootstrap-grant.json");
  });

  it("puts the pairing exchange at /api/pair", () => {
    expect(PAIR_PATH).toBe("/api/pair");
  });
});
