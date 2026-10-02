import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  OWED_HANDLERS,
  STATE_IMPORT_STREAM_KIND,
  StateImportReport,
  eventTypeEntry,
  isListEvent,
  registry,
} from "./index.js";

/**
 * The state import's contract (setup spec, "2. Carry over" and "Wire
 * summary"; ADR 0036; #581): `stateImport.detect` a read query, and
 * `stateImport.run` an admin command the switch-over build serves (#1165),
 * behind the `stateImport` flag, with its report's four groups, what failed
 * and the client-local values; the `state-import.finished` notice on the
 * environment stream; and the import's own evidence on the `state-import`
 * stream: `state-import.started` and `state-import.item-carried`.
 */

describe("the state import's methods", () => {
  it("detect at read, a query, and run at admin, a command requiring a command id and a dry run, neither owed: the switch-over build serves the run (#1165)", () => {
    expect([registry["stateImport.detect"].scope, registry["stateImport.detect"].kind]).toEqual(["read", "query"]);
    expect([registry["stateImport.run"].scope, registry["stateImport.run"].kind]).toEqual(["admin", "command"]);
    expect(registry["stateImport.run"].params.safeParse({ commandId: "0f8fad5b-d9cb-469f-a165-70867728950e", dryRun: true }).success).toBe(true);
    expect(registry["stateImport.run"].params.safeParse({ commandId: "0f8fad5b-d9cb-469f-a165-70867728950e" }).success).toBe(false);
    expect(registry["stateImport.run"].params.safeParse({ dryRun: false }).success).toBe(false);
    expect(OWED_HANDLERS).not.toHaveProperty("stateImport.run");
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

describe("the state-import stream", () => {
  const importId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const started = { importId, sourceKey: "/home/david/.config/source" };
  const carried = { importId, sourceKey: started.sourceKey, store: "instructions", sourceId: "p1", kind: "instruction", targetId: "8f2c1a7e-5b9d-4c3e-9a1f-2d6b7e8c9f0a", origin: "import" };

  it("carries state-import.started and state-import.item-carried, neither listed, beside the environment stream's notice", () => {
    expect(STATE_IMPORT_STREAM_KIND).toBe("state-import");
    for (const type of ["state-import.started", "state-import.item-carried"]) {
      expect(eventTypeEntry("state-import", type), type).toMatchObject({ list: false });
      expect(isListEvent("state-import", type), type).toBe(false);
      expect(ENVIRONMENT_NOTICE_TYPES as readonly string[], type).not.toContain(type);
    }
    expect(eventTypeEntry("state-import", "state-import.finished")).toBeUndefined();
  });

  it("starts an import under the parent command's id and the source's canonical folder", () => {
    expect(eventTypeEntry("state-import", "state-import.started")?.payload.parse(started)).toEqual(started);
    expect(eventTypeEntry("state-import", "state-import.started")?.payload.safeParse({ importId }).success).toBe(false);
  });

  it("names a carried item by its folder, store and source id, its kind and target, the import that carried it and the import origin", () => {
    const payload = eventTypeEntry("state-import", "state-import.item-carried")?.payload;
    expect(payload?.parse(carried)).toEqual(carried);
    expect(payload?.safeParse({ ...carried, origin: "client" }).success).toBe(false);
    expect(payload?.safeParse({ ...carried, kind: "nothing" }).success).toBe(false);
    expect(payload?.safeParse({ ...carried, sourceId: undefined }).success).toBe(false);
  });
});
