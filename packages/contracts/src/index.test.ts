import { describe, expect, it } from "vitest";
import { PRODUCT_NAME, PROTOCOL_VERSION } from "./index.js";

describe("contracts", () => {
  it("speaks protocol version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("names the product with the placeholder name", () => {
    expect(PRODUCT_NAME).toBe("agent-harness");
  });
});
