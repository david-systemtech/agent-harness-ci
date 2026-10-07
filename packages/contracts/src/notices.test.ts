import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validEnvironmentStartedEvent } from "../test/fixtures.js";
import {
  ENVIRONMENT_NOTICE_TYPES,
  ENVIRONMENT_STREAM_KIND,
  EnvironmentNotice,
  EnvironmentNoticeType,
  EventEnvelope,
  UPDATE_CANCEL_CAUSES,
  UPDATE_CAUSES,
  UPDATE_FAILURE_STAGES,
  UPDATE_SOURCES,
  WORKSPACE_KEPT_REASONS,
  eventTypeEntry,
} from "./index.js";

describe("environment notices", () => {
  it("are these types, in this order, on the environment stream", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toEqual([
      "environment.started",
      "environment.updated",
      "environment.draining",
      "environment.update-pending",
      "environment.update-started",
      "environment.update-failed",
      "environment.update-cancelled",
      "environment.channel-checked",
      "environment.renamed",
      "environment.icon-set",
      "environment.colour-set",
      "environment.known-environments-updated",
      "account.updated",
      "signin.updated",
      "signin.executable-chosen",
      "prompt.parked",
      "prompt.resolved",
      "usage.updated",
      "denylist.updated",
      "review.updated",
      "forge.account.added",
      "forge.account.updated",
      "forge.account.primary-set",
      "forge.account.verified",
      "forge.account.capability-learned",
      "forge.account.git-rejected",
      "forge.account.removed",
      "forge.origin-missing",
      "bank.added",
      "bank.review-held",
      "bank.draft-queued",
      "bank.drafts-consumed",
      "bank.updated",
      "bank.pinned",
      "bank.forgotten",
      "bank.synced",
      "bank.verified",
      "bank.landed",
      "bank.landing-failed",
      "bank.awaiting-review",
      "key-manager.connection.added",
      "key-manager.connection.signed-in",
      "key-manager.connection.signed-out",
      "key-manager.connection.updated",
      "key-manager.connection.policies-set",
      "key-manager.connection.base-path-set",
      "key-manager.connection.injected-set",
      "key-manager.connection.verified",
      "key-manager.connection.removed",
      "key-manager.moved",
      "key-manager.stored-value-deleted",
      "key-manager.value-copied",
      "routine.updated",
      "routine.delivered",
      "routine.delivery-failed",
      "routine.endpoint-set",
      "routine.endpoint-removed",
      "settings.changed",
      "web.origins.updated",
      "setup.result-changed",
      "skills.updated",
      "trust.updated",
      "instructions.updated",
      "tools.updated",
      "tool.run-started",
      "tool.run-finished",
      "extension.seen",
      "carry-over.imported",
      "carry-over.memory-assigned",
      "state-import.finished",
      "checks.changed",
      "checks.failures-reset",
      "workspace.kept",
      "chrome.updated",
      "client.call",
    ]);
    expect(ENVIRONMENT_STREAM_KIND).toBe("environment");
  });

  it("are each an entry of EnvironmentNoticeType's export, in their order, described by its own gloss (#799, #817)", () => {
    const exported = z.toJSONSchema(EnvironmentNoticeType, { target: "draft-2020-12", io: "input" }) as { anyOf: { const: string; description: string }[] };
    expect(exported.anyOf.map((entry) => entry.const)).toEqual(ENVIRONMENT_NOTICE_TYPES);
    for (const entry of exported.anyOf) expect(entry.description, entry.const).toMatch(/^\S.*\.$/);
  });

  it("parse from the event envelope an event frame carries, the envelope's other fields left aside", () => {
    const event = EventEnvelope.parse(validEnvironmentStartedEvent);
    expect(EnvironmentNotice.parse(event)).toEqual({
      type: "environment.started",
      payload: { harnessVersion: "0.1.0", protocolVersion: 1 },
    });
  });
});

/** A worktree the reaper kept at its last session's purge (workspace-picker spec, "The reaper"; #330). */
describe("the workspace.kept notice", () => {
  const notice = (payload: unknown) => EnvironmentNotice.safeParse({ type: "workspace.kept", payload });
  const kept = { path: "/data/worktrees/app-0123456789ab/agent-harness-7c9e6679", branch: "agent-harness/7c9e6679", title: "Invoices", reason: "uncommitted_changes" };

  it("names the worktree's path, its branch (null when detached), the session's title and why it stayed", () => {
    expect(WORKSPACE_KEPT_REASONS).toEqual(["uncommitted_changes", "git_filters_refused", "git_failed"]);
    for (const reason of WORKSPACE_KEPT_REASONS) expect(notice({ ...kept, reason }).data, reason).toEqual({ type: "workspace.kept", payload: { ...kept, reason } });
    expect(notice({ ...kept, branch: null }).success).toBe(true);
    for (const bad of [
      { ...kept, reason: "dirty" },
      { ...kept, path: "worktrees/app" },
      { ...kept, branch: "" },
      { ...kept, title: "" },
      { path: kept.path, title: kept.title, reason: kept.reason },
    ]) {
      expect(notice(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("goes on the environment stream, never in the session list", () => {
    expect(eventTypeEntry("environment", "workspace.kept")).toMatchObject({ list: false });
    expect(eventTypeEntry("session", "workspace.kept")).toBeUndefined();
  });
});

/** Settings changed (GUI spec, "Live"; #391): beside every settings.updated, naming the keys, never the values. */
describe("the settings.changed notice", () => {
  const notice = (payload: unknown) => EnvironmentNotice.safeParse({ type: "settings.changed", payload });

  it("names the keys that changed, each a setting and each once, at least one", () => {
    expect(notice({ keys: ["appearance.theme"] }).data).toEqual({ type: "settings.changed", payload: { keys: ["appearance.theme"] } });
    expect(notice({ keys: ["permissions.containment.default", "sessions.autoSettleOnMerge"] }).success).toBe(true);
    for (const bad of [{}, { keys: [] }, { keys: ["theme"] }, { keys: ["appearance.theme", "appearance.theme"] }, { keys: "appearance.theme" }]) {
      expect(notice(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("goes on the environment stream, never in the session list, beside the access log's type of the same name on the access stream", () => {
    expect(eventTypeEntry("environment", "settings.changed")).toMatchObject({ list: false });
    expect(eventTypeEntry("access", "settings.changed")).toBeDefined();
    expect(eventTypeEntry("settings", "settings.changed")).toBeUndefined();
  });
});

/** The denylist's and the Unattended review's notices (permissions spec, "Events"; #811): what a client's cached answers of them wait on. */
describe("the denylist.updated and review.updated notices", () => {
  const notice = (type: string, payload: unknown) => EnvironmentNotice.safeParse({ type, payload });

  it("say the denylist changed, naming the sections that did, each a section and each once, at least one", () => {
    expect(notice("denylist.updated", { sections: ["paths"] }).data).toEqual({ type: "denylist.updated", payload: { sections: ["paths"] } });
    expect(notice("denylist.updated", { sections: ["browserDomains", "paths", "commandPatterns", "hosts"] }).success).toBe(true);
    for (const bad of [{}, { sections: [] }, { sections: ["files"] }, { sections: ["paths", "paths"] }, { sections: "paths" }]) {
      expect(notice("denylist.updated", bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("say the Unattended review changed, carrying nothing more", () => {
    expect(notice("review.updated", {}).data).toEqual({ type: "review.updated", payload: {} });
    expect(notice("review.updated", null).success).toBe(false);
  });

  it("go on the environment stream, never in the session list, the denylist's beside the access log's denylist.changed", () => {
    expect(eventTypeEntry("environment", "denylist.updated")).toMatchObject({ list: false });
    expect(eventTypeEntry("environment", "review.updated")).toMatchObject({ list: false });
    expect(eventTypeEntry("access", "denylist.changed")).toBeDefined();
    expect(eventTypeEntry("access", "denylist.updated")).toBeUndefined();
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

  it("say, managed outside, which image the pending update goes to: its reference and digest, which a native environment's update has none of (#348)", () => {
    const pending = { updateId, toVersion: "0.5.0", source: "channel", since, deferUntil: "2026-09-29T10:00:00.000Z" };
    const image = { reference: "git.example.com/david/agent-harness:0.5.0", digest: `sha256:${"0".repeat(64)}` };
    expect(notice("environment.update-pending", { ...pending, image }).data).toEqual({ type: "environment.update-pending", payload: { ...pending, image } });
    expect(notice("environment.update-pending", pending).success).toBe(true);
    expect(notice("environment.update-pending", { ...pending, image: { reference: image.reference } }).success).toBe(false);
    expect(notice("environment.update-pending", { ...pending, image: { ...image, digest: "latest" } }).success).toBe(false);
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

  it("say a pending update was withdrawn by request, settings or a superseding running release", () => {
    expect(UPDATE_CANCEL_CAUSES).toEqual(["requested", "settings", "superseded"]);
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
    for (const type of ["environment.update-pending", "environment.update-started", "environment.update-failed", "environment.update-cancelled", "environment.channel-checked"]) {
      expect(eventTypeEntry("environment", type)?.list, type).toBe(false);
      expect(eventTypeEntry("session", type), type).toBeUndefined();
    }
  });
});
