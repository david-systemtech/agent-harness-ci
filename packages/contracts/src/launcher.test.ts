import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ACCESS_FILE,
  CREDENTIAL_ACCESS_STATES,
  DATABASE_FILE,
  DRAIN_CAP_MS,
  INSTALL_REFUSALS,
  LAUNCHER_PROTOCOL,
  OUTCOME_RECORD_FILE,
  STAGING_DIRECTORY,
  SWITCH_REFUSALS,
  UPDATE_ID_PATTERN,
  answersRequest,
  isCredentialAccessRecord,
  isOutcomeRecord,
  parseEnvironmentMessage,
  parseLauncherMessage,
  parsePreflightReport,
  type CredentialAccessRecord,
  type EnvironmentMessage,
  type LauncherMessage,
  type OutcomeRecord,
  type PreflightReport,
} from "./launcher.js";

/** A message as it arrives on the other side of the IPC channel, which carries JSON. */
const overIpc = (message: unknown): unknown => JSON.parse(JSON.stringify(message)) as unknown;

const status = { readiness: "ready", activity: { state: "busy", reason: "run-running" }, updatesManagedOutside: false } as const;

/** Every message the environment sends the launcher, one of each kind. */
const fromEnvironment: readonly EnvironmentMessage[] = [
  { type: "prepared", version: "0.4.0" },
  { type: "install?", id: 1, version: "0.5.0-beta.1", staged: "/home/david/.local/state/agent-harness/staging/0.5.0-beta.1" },
  { type: "switch?", id: 2, updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", version: "0.5.0" },
  { type: "versions?", id: 3 },
  { type: "idle", ...status },
  // A terminal running a command holds the environment busy, as a run does (#343).
  { type: "idle", readiness: "ready", activity: { state: "busy", reason: "terminal-running" }, updatesManagedOutside: false },
  { type: "idle", readiness: "draining", activity: { state: "draining", drainingSince: "2026-09-28T10:00:00.000Z" }, updatesManagedOutside: false },
  { type: "draining", drainingSince: "2026-09-28T10:00:00.000Z", trigger: "launcher" },
  // The drain an update began, joined by the launcher's drain query (#335).
  { type: "draining", drainingSince: "2026-09-28T10:00:00.000Z", trigger: "update" },
  // A start whose OS credential read waits on the person, then got or was refused its stored key (#1689).
  ...CREDENTIAL_ACCESS_STATES.map((state) => ({ type: "credential-access", state }) as const),
];

/** Every message the launcher sends the environment, one of each kind, each refusal reason included. */
const fromLauncher: readonly LauncherMessage[] = [
  { type: "committed" },
  { type: "installed", id: 1 },
  ...INSTALL_REFUSALS.map((reason) => ({ type: "refused", id: 1, reason }) as const),
  { type: "switching", id: 2 },
  ...SWITCH_REFUSALS.map((reason) => ({ type: "refused", id: 2, reason }) as const),
  { type: "versions", id: 3, installed: ["0.3.0", "0.4.0"], launcherVersion: "0.3.0", launcherProtocol: 1 },
  { type: "idle?" },
  { type: "drain?" },
];

describe("the launcher channel's messages", () => {
  it("are read on the launcher's side as the environment sent them", () => {
    for (const message of fromEnvironment) expect(parseEnvironmentMessage(overIpc(message)), message.type).toEqual(message);
  });

  it("are read on the environment's side as the launcher sent them", () => {
    for (const message of fromLauncher) expect(parseLauncherMessage(overIpc(message)), message.type).toEqual(message);
  });

  it("drop fields neither side defines, so a newer sender's additions are read as the message both know", () => {
    expect(parseLauncherMessage({ type: "committed", at: "2026-09-28T10:00:00.000Z" })).toEqual({ type: "committed" });
    expect(parseEnvironmentMessage({ type: "prepared", version: "0.4.0", pid: 4242 })).toEqual({ type: "prepared", version: "0.4.0" });
  });

  it("reads the failed handover's target in versions answers, while accepting older launchers without it", () => {
    const versions = { type: "versions", id: 3, installed: ["0.6.0"], launcherVersion: "0.4.1", launcherProtocol: 1 };
    expect(parseLauncherMessage(overIpc({ ...versions, failedHandoverVersion: "0.6.0" }))).toEqual({ ...versions, failedHandoverVersion: "0.6.0" });
    expect(parseLauncherMessage(overIpc(versions))).toEqual(versions);
    for (const failedHandoverVersion of [null, "", 42, { toVersion: "0.6.0" }]) {
      expect(parseLauncherMessage(overIpc({ ...versions, failedHandoverVersion }))).toBeUndefined();
    }
  });

  it("read a message either side does not know as nothing to answer, never as an error", () => {
    const unknownToEither: unknown[] = [
      null,
      undefined,
      "committed",
      42,
      [],
      [{ type: "committed" }],
      {},
      { kind: "committed" },
      { type: "commit" },
      { type: "status?" },
    ];
    for (const message of unknownToEither) {
      expect(parseLauncherMessage(message), JSON.stringify(message)).toBeUndefined();
      expect(parseEnvironmentMessage(message), JSON.stringify(message)).toBeUndefined();
    }
    const malformedFromLauncher: unknown[] = [
      { type: "installed" },
      { type: "installed", id: 0 },
      { type: "installed", id: 1.5 },
      { type: "installed", id: "1" },
      { type: "refused", id: 1 },
      { type: "refused", id: 1, reason: "no-launcher" },
      { type: "refused", id: 1, reason: "tired" },
      { type: "versions", id: 3, installed: "0.4.0", launcherVersion: "0.3.0", launcherProtocol: 1 },
      { type: "versions", id: 3, installed: ["0.4.0", ""], launcherVersion: "0.3.0", launcherProtocol: 1 },
      { type: "versions", id: 3, installed: [], launcherVersion: "", launcherProtocol: 1 },
      { type: "versions", id: 3, installed: [], launcherVersion: "0.3.0", launcherProtocol: 0 },
      { type: "versions", id: 3, installed: [], launcherVersion: "0.3.0" },
    ];
    for (const message of malformedFromLauncher) expect(parseLauncherMessage(message), JSON.stringify(message)).toBeUndefined();
    const malformedFromEnvironment: unknown[] = [
      { type: "prepared" },
      { type: "prepared", version: "" },
      { type: "install?", id: 1, version: "0.5.0" },
      { type: "install?", version: "0.5.0", staged: "/staging/0.5.0" },
      { type: "switch?", id: 2, version: "0.5.0" },
      // The launcher names the update's snapshot folder by its id, so an id that is not a version 4 UUID is no switch.
      { type: "switch?", id: 2, updateId: "update-1", version: "0.5.0" },
      { type: "switch?", id: 2, updateId: "../7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", version: "0.5.0" },
      { type: "switch?", id: 2, updateId: "7d0f2b1e-2c55-1a8e-9f0b-3a1c5d7e9b20", version: "0.5.0" },
      { type: "versions?" },
      { type: "idle", readiness: "ready", updatesManagedOutside: false },
      { type: "idle", ...status, activity: { state: "asleep" } },
      { type: "draining", trigger: "launcher" },
      { type: "credential-access" },
      { type: "credential-access", state: "asked" },
    ];
    for (const message of malformedFromEnvironment) expect(parseEnvironmentMessage(message), JSON.stringify(message)).toBeUndefined();
  });

  it("are each read by one side only: what the launcher sends means nothing to the launcher, and the reverse", () => {
    for (const message of fromLauncher) expect(parseEnvironmentMessage(overIpc(message)), message.type).toBeUndefined();
    for (const message of fromEnvironment) expect(parseLauncherMessage(overIpc(message)), message.type).toBeUndefined();
  });

  it("pair each request with the answers it takes: install? installed or an install refusal, switch? switching or a switch refusal, versions? versions", () => {
    const answers = (message: LauncherMessage) => ({
      "install?": answersRequest("install?", message),
      "switch?": answersRequest("switch?", message),
      "versions?": answersRequest("versions?", message),
    });
    expect(answers({ type: "installed", id: 1 })).toEqual({ "install?": true, "switch?": false, "versions?": false });
    expect(answers({ type: "refused", id: 1, reason: "preflight" })).toEqual({ "install?": true, "switch?": false, "versions?": false });
    expect(answers({ type: "refused", id: 1, reason: "launcher-protocol" })).toEqual({ "install?": true, "switch?": false, "versions?": false });
    expect(answers({ type: "switching", id: 1 })).toEqual({ "install?": false, "switch?": true, "versions?": false });
    expect(answers({ type: "refused", id: 1, reason: "not-installed" })).toEqual({ "install?": false, "switch?": true, "versions?": false });
    expect(answers({ type: "refused", id: 1, reason: "disk" })).toEqual({ "install?": true, "switch?": true, "versions?": false });
    expect(answers({ type: "versions", id: 1, installed: [], launcherVersion: "0.3.0", launcherProtocol: 1 })).toEqual({
      "install?": false,
      "switch?": false,
      "versions?": true,
    });
    expect(answers({ type: "committed" })).toEqual({ "install?": false, "switch?": false, "versions?": false });
  });

  it("refuse an install for the five reasons the spec names", () => {
    expect([...INSTALL_REFUSALS]).toEqual(["launcher-protocol", "incomplete", "preflight", "disk", "io"]);
  });

  it("are launcher protocol 1", () => {
    expect(LAUNCHER_PROTOCOL).toBe(1);
  });

  it("name an update by a version 4 UUID, in either case, and by nothing else", () => {
    for (const id of ["7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", "7D0F2B1E-2C55-4A8E-BF0B-3A1C5D7E9B20"]) expect(UPDATE_ID_PATTERN.test(id), id).toBe(true);
    const others = ["", "update-1", "7d0f2b1e2c554a8e9f0b3a1c5d7e9b20", "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20/..", "7d0f2b1e-2c55-4a8e-cf0b-3a1c5d7e9b20"];
    for (const id of others) expect(UPDATE_ID_PATTERN.test(id), id).toBe(false);
  });

  it("give the environment's drain its 30-minute cap, which the launcher waits a minute past for a child that is switching", () => {
    expect(DRAIN_CAP_MS).toBe(30 * 60_000);
  });

  it("load nothing at run time, so the launcher reads them on Node's built-ins alone: every import is a type", () => {
    const source = readFileSync(new URL("./launcher.ts", import.meta.url), "utf8");
    const imports = source.match(/^(?:import|export)\b[^;]*?\bfrom\s*["'][^"']+["']/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const statement of imports) expect(statement).toMatch(/^(import|export) type\b/);
    expect(source).not.toMatch(/^import\s*["']/m);
    expect(source).not.toMatch(/\bimport\(/);
  });
});

describe("a version's preflight report, as the launcher reads it", () => {
  const report: PreflightReport = {
    version: "0.5.0",
    protocolVersion: 1,
    launcherProtocol: 1,
    databaseSchemaVersion: 14,
    bundledClaudeCodeVersion: "2.1.283",
  };
  const printed = (value: unknown): string => `${JSON.stringify(value)}\n`;

  it("is the one JSON document preflight prints, its line feed or none", () => {
    expect(parsePreflightReport(printed(report))).toEqual(report);
    expect(parsePreflightReport(JSON.stringify(report))).toEqual(report);
    // A database with no migrations yet is schema 0.
    expect(parsePreflightReport(printed({ ...report, databaseSchemaVersion: 0 }))).toEqual({ ...report, databaseSchemaVersion: 0 });
  });

  it("drops the fields it does not define, so a newer version's additions are read as the report both know", () => {
    expect(parsePreflightReport(printed({ ...report, loaded: ["sqlite"] }))).toEqual(report);
  });

  it("is nothing when the output is not one report: missing a part, a part of the wrong kind, or more than one document", () => {
    for (const key of Object.keys(report)) {
      const partial: Record<string, unknown> = { ...report };
      delete partial[key];
      expect(parsePreflightReport(printed(partial)), key).toBeUndefined();
    }
    const others = [
      "",
      "preflight failed",
      printed(null),
      printed([report]),
      `${printed(report)}${printed(report)}`,
      printed({ ...report, version: "v0.5.0" }),
      printed({ ...report, protocolVersion: 0 }),
      printed({ ...report, launcherProtocol: 1.5 }),
      printed({ ...report, launcherProtocol: "1" }),
      printed({ ...report, databaseSchemaVersion: -1 }),
      printed({ ...report, bundledClaudeCodeVersion: "" }),
    ];
    for (const text of others) expect(parsePreflightReport(text), text).toBeUndefined();
  });
});

describe("the files the environment and the launcher share in the data directory", () => {
  const record: OutcomeRecord = {
    updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20",
    fromVersion: "0.4.0",
    toVersion: "0.5.0",
    stage: "trial",
    reason: "deadline",
  };

  it("are the database, the staging area and the outcome record, each named once", () => {
    expect(DATABASE_FILE).toBe("environment.db");
    expect(STAGING_DIRECTORY).toBe("staging");
    expect(OUTCOME_RECORD_FILE).toBe("update-outcome.json");
  });

  it("take an outcome record with the update id, the from and to versions, the stage and the reason", () => {
    expect(isOutcomeRecord(overIpc(record))).toBe(true);
    expect(isOutcomeRecord({ ...record, stage: "crash-loop", reason: "exits" })).toBe(true);
  });

  it("refuse an outcome record missing any of its parts, or with a stage no rollback has", () => {
    for (const key of Object.keys(record)) {
      const partial: Record<string, unknown> = { ...record };
      delete partial[key];
      expect(isOutcomeRecord(partial), key).toBe(false);
      expect(isOutcomeRecord({ ...record, [key]: "" }), key).toBe(false);
    }
    for (const invalid of [null, [], "trial", { ...record, stage: "switch" }, { ...record, reason: 3 }, { ...record, updateId: "../update" }]) {
      expect(isOutcomeRecord(invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  const waiting: CredentialAccessRecord = { version: "0.5.0", pid: 4242, since: "2026-10-06T10:34:01.000Z", state: "waiting" };

  it("take a credential-access record naming the version, its process, since when and the state of its wait (#1689)", () => {
    expect(CREDENTIAL_ACCESS_FILE).toBe("credential-access.json");
    for (const state of CREDENTIAL_ACCESS_STATES) expect(isCredentialAccessRecord(overIpc({ ...waiting, state })), state).toBe(true);
  });

  it("refuse a credential-access record missing any of its parts, or with a state or process no wait has", () => {
    for (const key of Object.keys(waiting)) {
      const partial: Record<string, unknown> = { ...waiting };
      delete partial[key];
      expect(isCredentialAccessRecord(partial), key).toBe(false);
    }
    for (const invalid of [null, [], { ...waiting, state: "asked" }, { ...waiting, pid: 0 }, { ...waiting, pid: "4242" }, { ...waiting, version: "" }, { ...waiting, since: "" }]) {
      expect(isCredentialAccessRecord(invalid), JSON.stringify(invalid)).toBe(false);
    }
  });
});
