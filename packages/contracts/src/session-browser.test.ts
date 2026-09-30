import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  SUMMARY_FIELD_OWNERS,
  SessionBrowser,
  SessionSummary,
  isListEvent,
  registry,
} from "./index.js";

/**
 * The browser as a session field (browser spec, "The browser as a session
 * field"; ADR 0014, ADR 0003; #550): the summary's `browser` and its five
 * shapes, `sessions.setBrowser` its owner, `sessions.create`'s first value,
 * and the two session-stream events.
 */

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const environmentId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const chromeId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const commandId = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const work = { kind: "chrome", environmentId, chromeId };
const myChrome = { kind: "chrome", environmentId, chromeId: null };
const EVERY_BROWSER = [work, myChrome, { kind: "headless" }, { kind: "dock" }, { kind: "none" }];

describe("the summary's browser field", () => {
  it("is null for none chosen, or a Chrome (a null chromeId the plain My Chrome), headless, the dock or none", () => {
    const field = SessionSummary.shape.browser;
    expect(field.safeParse(null).success).toBe(true);
    for (const browser of EVERY_BROWSER) expect(field.safeParse(browser).success, JSON.stringify(browser)).toBe(true);
    for (const wrong of [{ kind: "chrome", environmentId }, { kind: "chrome", chromeId }, { kind: "firefox" }, "headless", { kind: "chrome", environmentId: "e-1", chromeId: null }]) {
      expect(SessionBrowser.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });

  it("is owned by sessions.setBrowser in the field table", () => {
    expect(SUMMARY_FIELD_OWNERS.browser).toEqual({ command: "sessions.setBrowser" });
  });
});

describe("sessions.setBrowser", () => {
  it("is a command at runs:drive, since it chooses what the session's next run may drive", () => {
    expect(registry["sessions.setBrowser"]).toMatchObject({ kind: "command", scope: "runs:drive" });
  });

  it("sets any of the five shapes, null among them, and answers with the summary", () => {
    const params = registry["sessions.setBrowser"].params;
    for (const browser of [null, ...EVERY_BROWSER]) expect(params.safeParse({ commandId, sessionId, browser }).success, JSON.stringify(browser)).toBe(true);
    expect(params.safeParse({ commandId, sessionId }).success).toBe(false);
    expect(params.safeParse({ commandId, sessionId, browser: { kind: "firefox" } }).success).toBe(false);
    expect(Object.keys(registry["sessions.setBrowser"].result.shape)).toEqual(["summary"]);
  });
});

describe("sessions.create's browser", () => {
  it("is optional, a browser with who chose it: a person or the reach default", () => {
    const params = registry["sessions.create"].params;
    const base = { commandId, id: sessionId, workspace: { kind: "scratch" } };
    expect(params.safeParse(base).success).toBe(true);
    expect(params.safeParse({ ...base, browser: { value: work, chosenBy: "person" } }).success).toBe(true);
    expect(params.safeParse({ ...base, browser: { value: myChrome, chosenBy: "reach" } }).success).toBe(true);
    for (const wrong of [{ value: null, chosenBy: "person" }, { value: work, chosenBy: "agent" }, { value: work }, work]) {
      expect(params.safeParse({ ...base, browser: wrong }).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});

describe("the browser's session events", () => {
  it("put session.browser.set on the session stream, list-flagged: the value, and who chose it", () => {
    expect(isListEvent("session", "session.browser.set")).toBe(true);
    const payload = EVENT_TYPES.session["session.browser.set"].payload;
    for (const chosenBy of ["person", "agent", "reach", "completions"]) expect(payload.safeParse({ browser: work, chosenBy }).success, chosenBy).toBe(true);
    expect(payload.safeParse({ browser: null, chosenBy: "person" }).success).toBe(true);
    expect(payload.safeParse({ browser: work }).success).toBe(false);
    expect(payload.safeParse({ browser: work, chosenBy: "routine" }).success).toBe(false);
  });

  it("put run.browser.resolved on the session stream, not listed: the run, the field it read, the browser it gets, and why", () => {
    expect(isListEvent("session", "run.browser.resolved")).toBe(false);
    const payload = EVENT_TYPES.session["run.browser.resolved"].payload;
    const resolved = { runId, requested: null, browser: { kind: "headless" }, reason: "default", message: "The session chose no browser, so the run takes this environment's headless browser." };
    expect(payload.parse(resolved)).toEqual(resolved);
    for (const reason of ["chosen", "default", "unattended", "headless-not-allowed", "headless-unavailable"]) {
      expect(payload.safeParse({ ...resolved, reason }).success, reason).toBe(true);
    }
    expect(payload.safeParse({ ...resolved, requested: work, browser: { kind: "none" }, reason: "unattended" }).success).toBe(true);
    expect(payload.safeParse({ ...resolved, browser: null }).success).toBe(false);
    expect(payload.safeParse({ ...resolved, reason: "because" }).success).toBe(false);
    expect(payload.safeParse({ ...resolved, message: "" }).success).toBe(false);
  });
});
