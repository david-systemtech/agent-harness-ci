import { describe, expect, it } from "vitest";
import { AccountUsage, EnvironmentNotice, HandoffRecommendation, eventTypeEntry, registry, usageWindowLabel, usageWindowMeterLabel, isKnownUsageWindow } from "./index.js";

/**
 * Plan usage and the hand-off recommendation (#136): the reading a client
 * pools by identity, the notice, and the two read methods.
 */

const at = "2026-09-24T01:02:03.456Z";
const identity = { provider: "claude", email: "david@example.com", organisation: "Acme" };

describe("a plan-usage reading", () => {
  it.each([
    ["five_hour", "5-hour"],
    ["seven_day", "Weekly"],
    ["seven_day_opus", "Weekly, Opus"],
    ["seven_day_sonnet", "Weekly, Sonnet"],
    ["seven_day_oauth_apps", "Weekly, apps"],
    ["model_scoped:fable", "Weekly, Fable"],
    ["extra_usage", "Extra usage"],
  ])("names %s for a person as %s", (window, label) => {
    expect(usageWindowLabel(window as string)).toBe(label);
    expect(isKnownUsageWindow(window as string)).toBe(true);
  });

  it.each([
    ["five_hour", "5-hour"],
    ["seven_day", "Weekly"],
    ["seven_day_opus", "Opus"],
    ["seven_day_sonnet", "Sonnet"],
    ["seven_day_oauth_apps", "Apps"],
    ["model_scoped:fable", "Fable"],
    ["extra_usage", "Extra usage"],
    ["iguana_necktie", "Other limit"],
  ])("captions %s beside its meter ring as %s, the window's name left to the tooltip", (window, caption) => {
    expect(usageWindowMeterLabel(window as string)).toBe(caption);
  });

  it.each(["iguana_necktie", "toString", "model_scoped:"])("never uses the unknown identifier %s as a label", (window) => {
    expect(usageWindowLabel(window)).toBe("Other limit");
    expect(isKnownUsageWindow(window)).toBe(false);
  });

  it("carries its account's identity, and each window its own observation time beside the reading's", () => {
    const reading = {
      accountId: "claude-max",
      identity,
      windows: [{ window: "five_hour", utilisation: 0.4, resetsAt: at, verdict: "warning", observedAt: at }],
      readAt: at,
      unavailableReason: null,
    };
    expect(AccountUsage.parse(reading)).toEqual(reading);
    expect(AccountUsage.safeParse({ ...reading, windows: [{ ...reading.windows[0], observedAt: undefined }] }).success).toBe(false);
  });

  it("says why it has no windows, rather than failing, when the usage cannot be read", () => {
    const unavailable = { accountId: "claude-max", identity: null, windows: [], readAt: at, unavailableReason: "The account is signed out." };
    expect(AccountUsage.safeParse(unavailable).success).toBe(true);
    expect(AccountUsage.safeParse({ ...unavailable, unavailableReason: "" }).success).toBe(false);
  });
});

describe("the usage.updated notice", () => {
  it("is an environment notice naming the account and the identity whose gauge changed", () => {
    const notice = { type: "usage.updated", payload: { accountId: "claude-max", identity } };
    expect(EnvironmentNotice.parse(notice)).toEqual(notice);
    expect(eventTypeEntry("environment", "usage.updated")?.list).toBe(false);
  });
});

describe("the usage methods", () => {
  it("are reads: accounts.usage for one account or every one, accounts.handoff.recommend from an account or none", () => {
    expect([registry["accounts.usage"].kind, registry["accounts.usage"].scope]).toEqual(["query", "read"]);
    expect([registry["accounts.handoff.recommend"].kind, registry["accounts.handoff.recommend"].scope]).toEqual(["query", "read"]);
    expect(registry["accounts.usage"].params.safeParse({}).success).toBe(true);
    expect(registry["accounts.handoff.recommend"].params.safeParse({ fromAccountId: "claude-max" }).success).toBe(true);
  });

  it("answer a recommendation of an account or none, with its reason and sentence", () => {
    const none = {
      accountId: null,
      reason: "no-target",
      message: "No other account has a fresh plan reading with room.",
      fromAccountId: "claude-max",
      trigger: null,
      headroom: null,
      binding: null,
      candidates: 0,
      basis: null,
    };
    expect(HandoffRecommendation.parse(none)).toEqual(none);
    expect(HandoffRecommendation.safeParse({ ...none, reason: "rotate" }).success).toBe(false);
  });
});
