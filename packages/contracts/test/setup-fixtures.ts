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

/** The command id of `setup.mint`'s fixtures. */
const mintCommandId = "5a0f9a3e-6b1e-4b47-9d4c-0f1f6f2b8d11";

const done = {
  step: "your-machines",
  state: "done",
  reason: "The environment runs as a non-root user.",
  failing: [],
  actions: [],
  checkedAt: "2026-09-25T08:00:00.000Z",
};
export const pendingRead = { ...done, state: "pending", reason: "Waiting for the first release channel read." };

const needsAttention = {
  step: "permissions",
  state: "needs-attention",
  reason: "The paths section of the denylist is missing 2 of its presets (~/.aws, ~/.kube); Restore puts them back.",
  failing: ["permissions.denylist"],
  actions: ["restore"],
  checkedAt: "2026-09-25T08:00:00.000Z",
};

const timedOut = {
  step: "your-machines",
  state: "needs-attention",
  reason: "Checking took too long. Choose Check again.",
  details: ["Stopped after 5 seconds."],
  failing: ["your-machines.release-channel"],
  actions: ["check-again"],
  checkedAt: "2026-09-25T09:00:00.000Z",
  lastGood: { state: "done", reason: "The environment runs as a non-root user.", checkedAt: "2026-09-25T08:00:00.000Z" },
};
const skipped = {
  step: "account",
  state: "skipped",
  reason: "No account is added.",
  failing: [],
  actions: [],
  checkedAt: "2026-09-25T08:00:00.000Z",
};

const signedOut = { action: "sign-in-again", kind: "account", id: "account-work", label: "Work" };
const signedOutResult = {
  step: "account",
  state: "needs-attention",
  reason: "Work and Personal are signed out.",
  failing: ["account.signed-in"],
  actions: ["sign-in-again"],
  targets: [signedOut, { ...signedOut, id: "account-personal", label: "Personal" }],
  checkedAt: "2026-09-25T08:00:00.000Z",
};

/** A result that names what its action applies to: the payload of a `setup.result-changed` and an entry of the snapshot's `setup` too. */
export const forgeRejected = {
  step: "forges",
  state: "needs-attention",
  reason: "The forge refused the credential of david on git.example.com: Sign in again to give it a new one.",
  failing: ["forges.identity"],
  actions: ["sign-in-again", "check-again"],
  targets: [{ action: "sign-in-again", kind: "forge-account", id: "https://git.example.com", label: "david on git.example.com" }],
  checkedAt: "2026-09-25T08:00:00.000Z",
};

export const setupSchemaFixtures: Record<string, Fixtures> = {
  "setup/registered-step-id.json": { valid: ["account", "your-machines", "forges", "key-manager", "memory-bank", "skills", "instructions", "browser", "permissions", "appearance"], invalid: ["unknown-step", "Permissions", ""] },
  "setup/action.json": {
    valid: ["restore", "check-again", "set-up-this-machine", "start-service", "import-again", "try-again", "write-it-myself", "start-over", "revise"],
    invalid: ["Restore", "reboot", "try again", ""],
  },
  "setup/target-kind.json": {
    valid: ["account", "forge-account", "key-manager-connection", "tool", "skill-source", "chrome", "session", "bank", "denylist-section", "environment"],
    invalid: ["Account", "forge account", "workspace", ""],
  },
  "setup/target.json": {
    valid: [signedOut, { action: "pull-now", kind: "skill-source", id: "source-1", label: "team-skills" }, { action: "try-again", kind: "session", id: "session-1", label: "Set up: memory-bank (david-memory)" }],
    invalid: [
      { ...signedOut, kind: "workspace" },
      { ...signedOut, action: "reboot" },
      { ...signedOut, id: "" },
      { ...signedOut, label: "" },
      { kind: "account", id: "account-work", label: "Work" },
      { action: "sign-in-again", kind: "account", id: "account-work" },
    ],
  },
  "setup/step-state.json": { valid: ["done", "needs-attention", "skipped", "pending"], invalid: ["needs attention", "checking", ""] },
  "setup/step-result.json": {
    valid: [
      done,
      pendingRead,
      needsAttention,
      timedOut,
      skipped,
      { ...timedOut, step: "account", lastGood: { state: "skipped", reason: skipped.reason, checkedAt: skipped.checkedAt } },
      signedOutResult,
      { ...needsAttention, targets: [{ action: "restore", kind: "denylist-section", id: "paths", label: "Paths" }] },
      { ...skipped, step: "forges", reason: "No forge account is on this environment." },
      forgeRejected,
      // A step of the milestone-1 order this build does not register: a newer environment's result (#672).
      { ...done, step: "key-manager", reason: "The key manager is reachable and its login is valid." },
      // A verb and a kind of item a newer environment's vocabulary has and this one's lacks: read, and left out (#693).
      { ...needsAttention, actions: ["reboot", "restore"] },
      { ...signedOutResult, targets: [{ ...signedOut, kind: "workspace" }] },
      { ...signedOutResult, actions: ["rotate-token"], targets: [{ ...signedOut, action: "rotate-token" }] },
    ],
    invalid: [
      { ...needsAttention, actions: ["Reboot"] },
      { ...needsAttention, actions: ["try again"] },
      { ...signedOutResult, targets: [{ ...signedOut, kind: "forge account" }] },
      { ...signedOutResult, targets: [{ ...signedOut, action: "" }] },
      { ...signedOutResult, targets: [{ ...signedOut, label: "" }] },
      { ...signedOutResult, targets: signedOut },
      { ...timedOut, lastGood: { ...timedOut.lastGood, state: "needs-attention" } },
      { ...timedOut, lastGood: { state: "done", reason: "The environment runs as a non-root user." } },
      { ...timedOut, lastGood: { ...timedOut.lastGood, reason: "" } },
      { ...timedOut, lastGood: "The environment runs as a non-root user." },
      { ...done, reason: "" },
      { ...done, state: "checking" },
      { ...done, checkedAt: "yesterday" },
      { ...done, step: "housekeeping" },
      { state: "done", reason: "x", failing: [], actions: [], checkedAt: "2026-09-25T08:00:00.000Z" },
    ],
  },
  "setup/step-results.json": {
    valid: [
      [],
      [done, needsAttention, signedOutResult, pendingRead],
      // A step past the milestone-1 order, a later milestone's: passed over whatever it holds, the rest read (#693).
      [done, { ...done, step: "housekeeping" }, { step: "housekeeping", state: "idle" }],
    ],
    invalid: [done, [{ ...done, state: "checking" }], [done, { ...done, step: "" }], [{ ...done, step: "Housekeeping" }], [{ state: "done", reason: "x", failing: [], actions: [], checkedAt: done.checkedAt }]],
  },
  "setup/prompt-variant.json": {
    valid: ["first", "revise"],
    invalid: ["again", "", "First"],
  },
  "setup/minted-payload.json": {
    valid: [
      { step: "instructions", subject: null, variant: "first" },
      { step: "memory-bank", subject: { kind: "bank", id: "bank-1", label: "Personal" }, variant: "revise" },
    ],
    invalid: [
      { step: "unknown-step", subject: null, variant: "first" },
      { step: "instructions", subject: null, variant: "again" },
      { step: "instructions", variant: "first" },
      { step: "memory-bank", subject: { kind: "workspace", id: "bank-1", label: "Personal" }, variant: "first" },
      { step: "memory-bank", subject: { kind: "bank", id: "", label: "Personal" }, variant: "first" },
      { step: "memory-bank", subject: { kind: "bank", id: "bank-1", label: "" }, variant: "first" },
      { step: "memory-bank", subject: { kind: "bank", id: "bank-1" }, variant: "first" },
    ],
  },
};

export const setupMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "setup.check": {
    params: { valid: [{}, { step: "permissions" }, { step: "forges" }, { step: "key-manager" }, { step: "memory-bank" }, { step: "skills" }], invalid: [{ step: "unknown-step" }, { step: "" }, { step: ["permissions"] }] },
    result: {
      valid: [
        { results: [] },
        { results: [done, needsAttention, timedOut, signedOutResult] },
        { results: [skipped, { ...skipped, step: "skills", reason: "Nothing is tracked and the own directory is empty." }, done] },
        // A later milestone's step passed over, and a verb this version lacks left out (#693).
        { results: [done, { ...done, step: "housekeeping" }, { ...needsAttention, actions: ["reboot"] }] },
      ],
      invalid: [{}, { results: [{ ...done, state: "skipped?" }] }, { results: done }, { results: [done, { ...done, step: "" }] }],
    },
  },
  "setup.mint": {
    params: {
      valid: [
        { commandId: mintCommandId, step: "instructions", variant: "first" },
        { commandId: mintCommandId, step: "instructions", subject: "bank-1", variant: "revise", account: "claude-max", model: "opus", effort: "high" },
        { commandId: mintCommandId, step: "memory-bank", subject: "bank-1", variant: "first" },
        { commandId: mintCommandId, step: "skills", variant: "first" },
      ],
      invalid: [
        { step: "instructions", variant: "first" },
        { commandId: mintCommandId, step: "instructions" },
        { commandId: mintCommandId, step: "instructions", variant: "again" },
        { commandId: mintCommandId, step: "unknown-step", variant: "first" },
        { commandId: mintCommandId, step: "instructions", subject: "", variant: "first" },
      ],
    },
    result: {
      valid: [{ sessionId: "0b8a3c52-2f5e-4c09-9a6f-1c2d3e4f5a6b" }],
      invalid: [{}, { sessionId: "" }],
    },
  },
};
