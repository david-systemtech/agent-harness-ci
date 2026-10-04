import { describe, expect, it } from "vitest";
import { consumeBrowserRoute, sessionLink } from "./browser-boot.js";

describe("browser entry routes", () => {
  it("removes the pairing fragment before returning its code, and returns to the root", () => {
    history.replaceState(null, "", "/pair#K7Q2M-XH4RT");
    const route = consumeBrowserRoute(window);
    expect(location.pathname + location.hash).toBe("/");
    expect(route.pairing).toEqual({ address: location.origin, code: "K7Q2MXH4RT" });
  });
  it("scrubs even malformed or unexpected credential fragments", () => {
    for (const fragment of ["%", "not-a-code", "token-for-tests"]) {
      history.replaceState(null, "", `/pair#${fragment}`);
      expect(consumeBrowserRoute(window).pairing).toBeUndefined();
      expect(location.hash).toBe("");
    }
  });
  it("reads root-scoped session links without changing the public asset scope", () => {
    const session = { environmentId: "environment-one", sessionId: "session one" };
    expect(sessionLink(session)).toBe("/#/session/environment-one/session%20one");
    history.replaceState(null, "", sessionLink(session));
    expect(consumeBrowserRoute(window).session).toEqual(session);
    expect(location.pathname).toBe("/");
    history.replaceState(null, "", "/");
  });
});
