/**
 * Fixtures for Carry over's sessions half (#578): the inventory's counts,
 * what an import did, a failure, the `carry-over.imported` payload, the
 * report, and the two methods' params and results. A valid and an invalid
 * instance of each file the export writes; `fixtures.ts` folds them into
 * the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const accountId = "claude-max";

const inventory = { total: 42, archived: 7, missingDirectory: 3, new: 5 };
const nothing = { total: 0, archived: 0, missingDirectory: 0, new: 0 };
const sessions = { listed: 42, imported: 5, archived: 1, missingDirectory: 2, held: 36 };
const failure = { providerSessionId: "5c1b7a3e-8f2d-4b6a-9e0c-2d4f6a8b0c1e", message: "Its working directory relative/path is not an absolute path on this environment." };
const unreadable = { providerSessionId: null, message: "Listing the sessions in /home/david/.claude failed: EACCES." };
const imported = { accountId, sessions, failed: [failure] };
const report = { ...imported, dryRun: false };

/** Schema instances, by the file the export writes. */
export const carryOverSchemaFixtures: Record<string, Fixtures> = {
  "carry-over/sessions-inventory.json": {
    valid: [inventory, nothing],
    invalid: [{ ...inventory, new: -1 }, { total: 1, archived: 0, missingDirectory: 0 }, { ...inventory, total: 1.5 }],
  },
  "carry-over/inventory.json": {
    valid: [{ accountId, sessions: inventory }],
    invalid: [{ sessions: inventory }, { accountId: "", sessions: inventory }, { accountId, sessions: { total: 1 } }],
  },
  "carry-over/sessions-imported.json": {
    valid: [sessions, { listed: 0, imported: 0, archived: 0, missingDirectory: 0, held: 0 }],
    invalid: [{ ...sessions, held: -1 }, { listed: 1, imported: 1, archived: 0, missingDirectory: 0 }],
  },
  "carry-over/failure.json": {
    valid: [failure, unreadable],
    invalid: [{ providerSessionId: "", message: "x" }, { providerSessionId: null, message: "" }, { message: "No id at all." }],
  },
  "carry-over/notices/carry-over.imported.json": {
    valid: [imported, { accountId, sessions, failed: [] }, { accountId, sessions: { listed: 0, imported: 0, archived: 0, missingDirectory: 0, held: 0 }, failed: [unreadable] }],
    invalid: [{ accountId, sessions }, { accountId, sessions: inventory, failed: [] }, { ...imported, failed: [{ message: "" }] }],
  },
  "carry-over/report.json": {
    valid: [report, { ...imported, failed: [], dryRun: true }],
    invalid: [imported, { ...report, dryRun: "yes" }],
  },
};

/** Params and result instances for Carry over's methods. */
export const carryOverMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "carryOver.inventory": {
    params: { valid: [{ accountId }], invalid: [{}, { accountId: "" }, { accountId: 7 }] },
    result: {
      valid: [{ accountId, sessions: inventory }],
      invalid: [{ accountId, sessions: { ...inventory, archived: -2 } }, { accountId }],
    },
  },
  "carryOver.run": {
    params: {
      valid: [
        { commandId, accountId, dryRun: false, skills: true },
        { commandId, accountId, dryRun: true, skills: false },
      ],
      invalid: [{ commandId, accountId, dryRun: false }, { commandId, accountId, skills: true }, { accountId, dryRun: false, skills: false }],
    },
    result: {
      valid: [report, { ...imported, dryRun: true }],
      invalid: [imported, { ...report, sessions: inventory }],
    },
  },
};
