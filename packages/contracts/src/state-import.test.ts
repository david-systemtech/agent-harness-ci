import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  OWED_HANDLERS,
  StateImportReport,
  eventTypeEntry,
  registry,
} from "./index.js";

/**
 * The state import's contract (setup spec, "2. Carry over" and "Wire
 * summary"; ADR 0036; #581): `stateImport.detect` a read query, and
 * `stateImport.run` an admin command whose handler the switch-over build
 * owes, behind the `stateImport` flag, with its report's four groups, what
 * failed and the client-local values, and the `state-import.finished`
 * notice on the environment stream.
 */

describe("the state import's methods", () => {
  it("detect at read, a query, and run at admin, a command taking a dry run, whose handler the switch-over build owes (#94)", () => {
    expect([registry["stateImport.detect"].scope, registry["stateImport.detect"].kind]).toEqual(["read", "query"]);
    expect([registry["stateImport.run"].scope, registry["stateImport.run"].kind]).toEqual(["admin", "command"]);
    expect(registry["stateImport.run"].params.safeParse({ commandId: "0f8fad5b-d9cb-469f-a165-70867728950e", dryRun: true }).success).toBe(true);
    expect(OWED_HANDLERS).toMatchObject({ "stateImport.run": "#94" });
    expect(OWED_HANDLERS).not.toHaveProperty("stateImport.detect");
  });

  it("puts stateImport on the flag list, the flag an environment offers once it serves the run", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("stateImport");
  });

  it("reports the four groups, what failed and the client-local values, and whether it was a dry run", () => {
    expect(Object.keys(StateImportReport.shape)).toEqual(["carried", "reEnter", "later", "notCarried", "failed", "clientLocal", "dryRun"]);
  });
});

describe("state-import.finished", () => {
  it("is an environment notice, whose payload is the report without the client-local values or the dry run", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("state-import.finished");
    expect(eventTypeEntry("environment", "state-import.finished")).toMatchObject({ list: false });
    const payload = { carried: { accounts: 1 }, reEnter: [], later: [], notCarried: [], failed: [] };
    expect(EnvironmentNotice.safeParse({ type: "state-import.finished", payload }).success).toBe(false);
    const carried = { accounts: 1, archived: 0, pins: 0, groups: 0, forgeAccounts: 0, keyManagerConnections: 0, banks: 0, routines: 0, instructions: 0, skillSources: 0, alwaysOnSkills: 0, drafts: 0, devSites: 0 };
    expect(EnvironmentNotice.parse({ type: "state-import.finished", payload: { ...payload, carried } })).toEqual({ type: "state-import.finished", payload: { ...payload, carried } });
  });
});
