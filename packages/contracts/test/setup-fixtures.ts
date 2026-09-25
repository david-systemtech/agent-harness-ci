/**
 * Fixtures for the Set up schemas and `setup.check` (ADR 0031; #141): a
 * valid and an invalid instance of every Set up schema the export writes,
 * and params and results for the method. `fixtures.ts` folds them into the
 * package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const done = {
  step: "your-machines",
  state: "done",
  reason: "The environment runs as a non-root user.",
  failing: [],
  actions: [],
  checkedAt: "2026-09-25T08:00:00.000Z",
};
const needsAttention = {
  step: "permissions",
  state: "needs-attention",
  reason: "The paths section of the denylist is missing 2 of its presets (~/.aws, ~/.kube); Restore puts them back.",
  failing: ["permissions.denylist"],
  actions: ["restore"],
  checkedAt: "2026-09-25T08:00:00.000Z",
};

export const setupSchemaFixtures: Record<string, Fixtures> = {
  "setup/registered-step-id.json": { valid: ["account", "your-machines", "permissions", "appearance"], invalid: ["forges", "Permissions", ""] },
  "setup/action.json": { valid: ["restore", "check-again", "set-up-this-machine"], invalid: ["Restore", "reboot", ""] },
  "setup/step-state.json": { valid: ["done", "needs-attention", "skipped"], invalid: ["needs attention", "pending", ""] },
  "setup/step-result.json": {
    valid: [done, needsAttention],
    invalid: [
      { ...done, reason: "" },
      { ...done, state: "pending" },
      { ...needsAttention, actions: ["reboot"] },
      { ...done, checkedAt: "yesterday" },
      { ...done, step: "forges" },
      { state: "done", reason: "x", failing: [], actions: [], checkedAt: "2026-09-25T08:00:00.000Z" },
    ],
  },
};

export const setupMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "setup.check": {
    params: { valid: [{}, { step: "permissions" }], invalid: [{ step: "forges" }, { step: "" }, { step: ["permissions"] }] },
    result: { valid: [{ results: [] }, { results: [done, needsAttention] }], invalid: [{}, { results: [{ ...done, state: "skipped?" }] }, { results: done }] },
  },
};
