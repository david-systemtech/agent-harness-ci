import { describe, expect, it } from "vitest";
import { validEnvironmentStartedEvent } from "../test/fixtures.js";
import {
  ENVIRONMENT_NOTICE_TYPES,
  ENVIRONMENT_STREAM_KIND,
  EnvironmentNotice,
  EventEnvelope,
  UPDATE_CANCEL_CAUSES,
  UPDATE_CAUSES,
  UPDATE_FAILURE_STAGES,
  UPDATE_SOURCES,
  eventTypeEntry,
} from "./index.js";

describe("environment notices", () => {
  it("are started, updated and draining, an update's pending, started, failed and cancelled (#335), an account updated (#134), the sign-in's state and executable (#135), a prompt parked and resolved (#130), and an account's usage updated (#136), on the environment stream", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toEqual([
      "environment.started",
      "environment.updated",
      "environment.draining",
      "environment.update-pending",
      "environment.update-started",
      "environment.update-failed",
      "environment.update-cancelled",
      "account.updated",
      "signin.updated",
      "signin.executable-chosen",
      "prompt.parked",
      "prompt.resolved",
      "usage.updated",
    ]);
    expect(ENVIRONMENT_STREAM_KIND).toBe("environment");
  });

  it("parse from the event envelope an event frame carries, the envelope's other fields left aside", () => {
    const event = EventEnvelope.parse(validEnvironmentStartedEvent);
    expect(EnvironmentNotice.parse(event)).toEqual({
      type: "environment.started",
      payload: { harnessVersion: "0.1.0", protocolVersion: 1 },
    });
  });
});

/** An update's notices (launcher-update spec, "Settings, methods, notices and flags"; #335). */
describe("an update's notices", () => {
  const updateId = "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20";
  const since = "2026-09-28T10:00:00.000Z";
  const notice = (type: string, payload: Record<string, unknown>) => EnvironmentNotice.safeParse({ type, payload });

  it("say an update is pending: its id, target, source (channel, pin, request or desktop), since when, and when the cap forces it", () => {
    expect(UPDATE_SOURCES).toEqual(["channel", "pin", "request", "desktop"]);
    for (const source of UPDATE_SOURCES) {
      const payload = { updateId, toVersion: "0.5.0", source, since, deferUntil: "2026-09-29T10:00:00.000Z" };
      expect(notice("environment.update-pending", payload).data, source).toEqual({ type: "environment.update-pending", payload });
    }
    expect(notice("environment.update-pending", { updateId, toVersion: "0.5.0", source: "cron", since, deferUntil: since }).success).toBe(false);
    expect(notice("environment.update-pending", { updateId: "u-1", toVersion: "0.5.0", source: "pin", since, deferUntil: since }).success).toBe(false);
  });

  it("say an update began its drain: from and to which version, and its cause (idle, the cap, or asked)", () => {
    expect(UPDATE_CAUSES).toEqual(["idle", "cap", "requested"]);
    for (const cause of UPDATE_CAUSES) {
      const payload = { updateId, fromVersion: "0.4.2", toVersion: "0.5.0", cause };
      expect(notice("environment.update-started", payload).data, cause).toEqual({ type: "environment.update-started", payload });
    }
    expect(notice("environment.update-started", { updateId, fromVersion: "0.4.2", toVersion: "0.5.0", cause: "now" }).success).toBe(false);
  });

  it("say an update failed: at which stage (the switch, the trial or the crash-loop watch), why, and whether it was rolled back", () => {
    expect(UPDATE_FAILURE_STAGES).toEqual(["switch", "trial", "crash-loop"]);
    for (const stage of UPDATE_FAILURE_STAGES) {
      const payload = { updateId, fromVersion: "0.4.2", toVersion: "0.5.0", stage, reason: "deadline", rolledBack: stage !== "switch" };
      expect(notice("environment.update-failed", payload).data, stage).toEqual({ type: "environment.update-failed", payload });
    }
    expect(notice("environment.update-failed", { updateId, fromVersion: "0.4.2", toVersion: "0.5.0", stage: "preflight", reason: "unknown", rolledBack: false }).success).toBe(false);
    expect(notice("environment.update-failed", { updateId, fromVersion: "0.4.2", toVersion: "0.5.0", stage: "trial", reason: "", rolledBack: true }).success).toBe(false);
  });

  it("say a pending update was withdrawn, by updates.cancel or because the settings stopped calling for it", () => {
    expect(UPDATE_CANCEL_CAUSES).toEqual(["requested", "settings"]);
    for (const cause of UPDATE_CANCEL_CAUSES) {
      const payload = { updateId, toVersion: "0.5.0", cause };
      expect(notice("environment.update-cancelled", payload).data, cause).toEqual({ type: "environment.update-cancelled", payload });
    }
  });

  it("carry the update id on environment.updated, while an event in the older shape, with none, still parses", () => {
    const updated = { fromVersion: "0.4.2", toVersion: "0.5.0", updateId };
    expect(notice("environment.updated", updated).data).toEqual({ type: "environment.updated", payload: updated });
    expect(notice("environment.updated", { fromVersion: "0.4.2", toVersion: "0.5.0" }).data).toEqual({
      type: "environment.updated",
      payload: { fromVersion: "0.4.2", toVersion: "0.5.0" },
    });
    expect(notice("environment.updated", { ...updated, updateId: "not-an-id" }).success).toBe(false);
  });

  it("go on the environment stream only, none of them list-flagged", () => {
    for (const type of ["environment.update-pending", "environment.update-started", "environment.update-failed", "environment.update-cancelled"]) {
      expect(eventTypeEntry("environment", type)?.list, type).toBe(false);
      expect(eventTypeEntry("session", type), type).toBeUndefined();
    }
  });
});
