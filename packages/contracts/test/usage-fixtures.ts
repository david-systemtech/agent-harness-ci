/**
 * Fixtures for plan usage and the hand-off recommendation (#136): a valid
 * and an invalid instance of every usage schema the export writes, and
 * params and results for `accounts.usage` and `accounts.handoff.recommend`.
 * `fixtures.ts` folds them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const accountId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const at = "2026-09-24T01:02:03.456Z";
const resets = "2026-09-24T05:00:00.000Z";
const identity = { provider: "claude", email: "david@example.com", organisation: null };

const fiveHour = { window: "five_hour", utilisation: 0.25, resetsAt: resets, verdict: null, observedAt: at };
const refused = { window: "seven_day", utilisation: null, resetsAt: null, verdict: "rejected", observedAt: at };
const reading = { accountId, identity, windows: [fiveHour, refused], readAt: at, unavailableReason: null };
const unavailable = { accountId: "claude-max", identity: null, windows: [], readAt: at, unavailableReason: "The Fake adapter does not report plan usage." };

const trigger = { threshold: "five_hour", label: "5-hour", at: 0.9, window: "five_hour", utilisation: 0.94, verdict: null };
const recommendation = {
  accountId,
  reason: "limit-near",
  message: "Work's 5-hour window is at 94%; Personal has the most room, 60% free in its weekly window.",
  fromAccountId: "claude-max",
  trigger,
  headroom: 0.6,
  binding: "seven_day",
  candidates: 1,
  basis: "percentage",
};
const none = {
  accountId: null,
  reason: "no-target",
  message: "Fewer than two accounts have a fresh plan reading to compare.",
  fromAccountId: null,
  trigger: null,
  headroom: null,
  binding: null,
  candidates: 0,
  basis: null,
};

/** Every usage schema the export writes, by path. */
export const usageSchemaFixtures: Record<string, Fixtures> = {
  "usage/verdict.json": { valid: ["allowed", "warning", "rejected"], invalid: ["ok", ""] },
  "usage/window.json": {
    valid: [fiveHour, refused, { ...fiveHour, utilisation: 1.2 }],
    invalid: [{ ...fiveHour, utilisation: -0.1 }, { ...fiveHour, window: "" }, { ...fiveHour, verdict: "ok" }, { ...fiveHour, observedAt: null }, { window: "five_hour" }],
  },
  "usage/account-usage.json": {
    valid: [reading, unavailable],
    invalid: [{ ...reading, identity: { provider: "claude" } }, { ...reading, unavailableReason: "" }, { ...reading, readAt: "now" }, { accountId, windows: [] }],
  },
  "usage/usage-updated.json": {
    valid: [{ accountId, identity }, { accountId: "claude-max", identity: null }],
    invalid: [{ accountId }, { identity }, { accountId: "", identity: null }],
  },
  "usage/handoff-reason.json": { valid: ["limit-reached", "limit-near", "most-room", "no-target"], invalid: ["rotate", ""] },
  "usage/handoff-basis.json": { valid: ["same-plan", "weighted", "percentage"], invalid: ["capacity", ""] },
  "usage/handoff-trigger.json": {
    valid: [trigger, { ...trigger, threshold: "seven_day", label: "weekly", window: "seven_day", utilisation: 1, verdict: "rejected" }],
    invalid: [{ ...trigger, utilisation: -1 }, { ...trigger, threshold: "" }, { threshold: "five_hour" }],
  },
  "usage/handoff-recommendation.json": {
    valid: [recommendation, none, { ...recommendation, reason: "most-room", fromAccountId: null, trigger: null, candidates: 2 }],
    invalid: [{ ...recommendation, reason: "rotate" }, { ...recommendation, message: "" }, { ...recommendation, candidates: -1 }, { accountId: null }],
  },
};

/** Params and results for the two usage methods. */
export const usageMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "accounts.usage": {
    params: { valid: [{}, { accountId }], invalid: [{ accountId: "" }, []] },
    result: { valid: [{ readings: [] }, { readings: [reading, unavailable] }], invalid: [{}, { readings: [{ accountId }] }] },
  },
  "accounts.handoff.recommend": {
    params: { valid: [{}, { fromAccountId: accountId }], invalid: [{ fromAccountId: "" }, []] },
    result: { valid: [recommendation, none], invalid: [{}, { ...none, reason: "stay" }] },
  },
};
