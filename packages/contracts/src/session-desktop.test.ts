import { describe, expect, it } from "vitest";
import { EVENT_TYPES, SUMMARY_FIELD_OWNERS, SETTINGS, SessionSummary, isListEvent, registry } from "./index.js";

/**
 * The desktop as a session field (computer spec, "Session field and run
 * resolution"; ADR 0038; #2161): the summary's `desktop`, `sessions.setDesktop`
 * its owner, `sessions.create`'s first value, the two session-stream events and
 * the operator's `desktop.contained.allowRuns`.
 */

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const commandId = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const EVERY_DESKTOP = [{ kind: "none" }, { kind: "contained" }, { kind: "local" }];

describe("the summary's desktop field", () => {
  it("is null for never set, or none, contained or local", () => {
    const field = SessionSummary.shape.desktop;
    expect(field.safeParse(null).success).toBe(true);
    for (const desktop of EVERY_DESKTOP) expect(field.safeParse(desktop).success, JSON.stringify(desktop)).toBe(true);
    for (const wrong of [{ kind: "vnc" }, "local", {}]) expect(field.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
  });

  it("is owned by sessions.setDesktop in the field table", () => {
    expect(SUMMARY_FIELD_OWNERS.desktop).toEqual({ command: "sessions.setDesktop" });
  });
});

describe("sessions.setDesktop", () => {
  it("is a command at runs:drive, as sessions.setBrowser is", () => {
    expect(registry["sessions.setDesktop"]).toMatchObject({ kind: "command", scope: "runs:drive" });
  });

  it("sets none, contained or local, and answers with the summary", () => {
    const params = registry["sessions.setDesktop"].params;
    for (const desktop of EVERY_DESKTOP) expect(params.safeParse({ commandId, sessionId, desktop }).success, JSON.stringify(desktop)).toBe(true);
    expect(params.safeParse({ commandId, sessionId }).success).toBe(false);
    expect(params.safeParse({ commandId, sessionId, desktop: null }).success).toBe(false);
    expect(Object.keys(registry["sessions.setDesktop"].result.shape)).toEqual(["summary"]);
  });
});

describe("sessions.create's desktop", () => {
  it("is optional, a desktop", () => {
    const params = registry["sessions.create"].params;
    const base = { commandId, id: sessionId, workspace: { kind: "scratch" } };
    expect(params.safeParse(base).success).toBe(true);
    expect(params.safeParse({ ...base, desktop: { kind: "contained" } }).success).toBe(true);
    expect(params.safeParse({ ...base, desktop: { kind: "vnc" } }).success).toBe(false);
  });
});

describe("the desktop's session events", () => {
  it("put session.desktop.set on the session stream, list-flagged", () => {
    expect(isListEvent("session", "session.desktop.set")).toBe(true);
    expect(EVENT_TYPES.session["session.desktop.set"].payload.safeParse({ desktop: { kind: "local" } }).success).toBe(true);
  });

  it("put run.desktop.resolved on the session stream, not listed: the run, the field it read, the desktop it drives, and why", () => {
    expect(isListEvent("session", "run.desktop.resolved")).toBe(false);
    const payload = EVENT_TYPES.session["run.desktop.resolved"].payload;
    const resolved = { runId, requested: { kind: "contained" }, desktop: { kind: "none" }, reason: "operator-disabled", message: "desktop.contained.allowRuns is off." };
    expect(payload.parse(resolved)).toEqual(resolved);
    expect(payload.safeParse({ ...resolved, runId: undefined }).success).toBe(false);
    expect(payload.safeParse({ ...resolved, reason: "because" }).success).toBe(false);
  });
});

describe("desktop.contained.allowRuns", () => {
  it("is a boolean, preset off", () => {
    expect(SETTINGS["desktop.contained.allowRuns"].preset).toBe(false);
    expect(SETTINGS["desktop.contained.allowRuns"].schema.safeParse("on").success).toBe(false);
  });
});
