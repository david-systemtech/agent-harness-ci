import { describe, expect, it } from "vitest";
import { accessEventWords } from "./words.js";

const labelOf = () => "phone";
const opened = (payload: Record<string, unknown>) =>
  accessEventWords({ type: "socket.opened", payload: { clientSessionId: "cs-1", socketId: "s-1", ...payload } }, labelOf);

describe("a socket opened, in the access log", () => {
  it("names the address it came from, and the Tailscale login the proxy forwarded with it", () => {
    expect(opened({ remoteAddress: "100.64.0.7" })).toBe("phone connected from 100.64.0.7.");
    expect(opened({ remoteAddress: "100.64.0.7", login: "owner@example.test" })).toBe("phone connected from 100.64.0.7 as owner@example.test.");
    expect(opened({ remoteAddress: null })).toBe("phone connected.");
  });
});
