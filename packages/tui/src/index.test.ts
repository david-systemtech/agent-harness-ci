import { CLIENT_PROTOCOL_VERSION } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { TUI_PROTOCOL_VERSION } from "./index.js";

describe("terminal UI", () => {
  it("speaks the protocol version of the client runtime it renders from", () => {
    expect(TUI_PROTOCOL_VERSION).toBe(CLIENT_PROTOCOL_VERSION);
  });
});
