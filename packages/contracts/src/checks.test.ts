import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  CHECK_OUTPUT_MAX_BYTES,
  CHECK_TIMEOUT_MS,
  ChecksFinishedPayload,
  ChecksStartedPayload,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  OWED_HANDLERS,
  SessionEventType,
  checkPassed,
  eventTypeEntry,
  exportedSchemas,
  registry,
} from "./index.js";

/**
 * Workspace checks' contract (switch-over spec, "Phase-D commands and
 * parity", Checks; #1187): a query and two prepared commands under
 * `terminal`, the `workspaceChecks` flag, the `checks.changed` notice and
 * the session's `checks.started` and `checks.finished` events.
 */

const SESSION = "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10";
const COMMAND_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TERMINAL = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const RUN = "8d3c5f2e-4b1a-4c6d-9e7f-0a1b2c3d4e5f";

describe("the check methods", () => {
  it("are a query and two commands, each under the one terminal scope, taking the session, the commands a command id too", () => {
    expect(["checks.get", "checks.set", "checks.run"].map((name) => [registry[name as "checks.get"].kind, registry[name as "checks.get"].scope])).toEqual([
      ["query", "terminal"],
      ["command", "terminal"],
      ["command", "terminal"],
    ]);
    expect(registry["checks.get"].params.safeParse({ sessionId: SESSION }).success).toBe(true);
    expect(registry["checks.set"].params.safeParse({ sessionId: SESSION, command: "pnpm test" }).success).toBe(false);
    expect(registry["checks.set"].params.safeParse({ commandId: COMMAND_ID, sessionId: SESSION, command: "pnpm test" }).success).toBe(true);
    expect(registry["checks.run"].params.safeParse({ commandId: COMMAND_ID }).success).toBe(false);
    expect(registry["checks.run"].params.safeParse({ commandId: COMMAND_ID, sessionId: SESSION }).success).toBe(true);
    for (const name of ["checks.get", "checks.set", "checks.run"]) expect(OWED_HANDLERS).not.toHaveProperty(name);
  });

  it("keeps the shell text verbatim, clears it with null, and refuses text with nothing to run", () => {
    const command = "  pnpm typecheck && pnpm exec vitest run 'a b.test.ts' \\\n  --maxWorkers=2\t\n";
    expect(registry["checks.set"].params.parse({ commandId: COMMAND_ID, sessionId: SESSION, command }).command).toBe(command);
    expect(registry["checks.set"].params.parse({ commandId: COMMAND_ID, sessionId: SESSION, command: null }).command).toBeNull();
    expect(registry["checks.set"].params.safeParse({ commandId: COMMAND_ID, sessionId: SESSION, command: " \n\t" }).success).toBe(false);
    expect(registry["checks.set"].params.safeParse({ commandId: COMMAND_ID, sessionId: SESSION, command: "" }).success).toBe(false);
  });

  it("answer get and set with the canonical workspace and its nullable command, and run with the terminal it opened", () => {
    const answer = { workspace: "/home/milo/project", command: null };
    expect(registry["checks.get"].result.parse(answer)).toEqual(answer);
    expect(registry["checks.set"].result.parse({ ...answer, command: "make check" })).toEqual({ ...answer, command: "make check" });
    expect(registry["checks.get"].result.safeParse({ ...answer, workspace: "project" }).success).toBe(false);
    expect(registry["checks.run"].result.parse({ terminalId: TERMINAL })).toEqual({ terminalId: TERMINAL });
  });

  it("puts workspaceChecks on the flag list", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("workspaceChecks");
  });
});

describe("checks.changed", () => {
  it("is an unlisted environment notice naming the workspace and its command, null once cleared", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("checks.changed");
    expect(eventTypeEntry("environment", "checks.changed")).toMatchObject({ list: false });
    const notice = { type: "checks.changed", payload: { workspace: "/home/milo/project", command: null } };
    expect(EnvironmentNotice.parse(notice)).toEqual(notice);
    expect(EnvironmentNotice.safeParse({ ...notice, payload: { command: null } }).success).toBe(false);
  });
});

describe("checks.started and checks.finished", () => {
  const started = { terminalId: TERMINAL, command: "pnpm test", sourceRunId: null };
  const finished = { ...started, output: "1 failed\r\n", truncated: false, exitCode: 1, signal: null, timedOut: false, failure: null };

  it("are unlisted session events, published with the session's other event payloads", () => {
    for (const [type, payload] of [["checks.started", ChecksStartedPayload], ["checks.finished", ChecksFinishedPayload]] as const) {
      expect(SessionEventType.options).toContain(type);
      expect(eventTypeEntry("session", type)).toEqual({ list: false, payload });
      expect(exportedSchemas().find((entry) => entry.path === `sessions/events/${type}.json`)?.schema).toBe(payload);
    }
  });

  it("carry the terminal, the command and a null source run for a manual check, and on finishing its output, truncation, exit and timeout", () => {
    expect(ChecksStartedPayload.parse(started)).toEqual(started);
    expect(ChecksStartedPayload.parse({ ...started, sourceRunId: RUN })).toEqual({ ...started, sourceRunId: RUN });
    expect(ChecksFinishedPayload.parse(finished)).toEqual(finished);
    expect(ChecksFinishedPayload.safeParse({ ...finished, output: "x".repeat(CHECK_OUTPUT_MAX_BYTES + 1) }).success).toBe(false);
    // The bound is in UTF-8 bytes, as the environment cuts the output: three-byte characters reach it at a third of the length.
    const third = Math.floor(CHECK_OUTPUT_MAX_BYTES / 3);
    const atBound = "€".repeat(third) + "x".repeat(CHECK_OUTPUT_MAX_BYTES - 3 * third);
    expect(ChecksFinishedPayload.safeParse({ ...finished, output: atBound }).success).toBe(true);
    expect(ChecksFinishedPayload.safeParse({ ...finished, output: `${atBound}x` }).success).toBe(false);
    expect(ChecksFinishedPayload.safeParse({ ...finished, output: "€".repeat(third + 1) }).success).toBe(false);
    expect(ChecksFinishedPayload.safeParse({ ...finished, failure: "skipped" }).success).toBe(false);
    expect(CHECK_TIMEOUT_MS).toBe(120_000);
    expect(CHECK_OUTPUT_MAX_BYTES).toBe(64 * 1024);
  });

  it("pass only on exit code 0 with no signal, no timeout and no failure", () => {
    expect(checkPassed({ ...finished, exitCode: 0 })).toBe(true);
    expect(checkPassed(finished)).toBe(false);
    expect(checkPassed({ ...finished, exitCode: 0, signal: 9 })).toBe(false);
    expect(checkPassed({ ...finished, exitCode: null, timedOut: true })).toBe(false);
    expect(checkPassed({ ...finished, exitCode: null, failure: "interrupted" })).toBe(false);
  });
});
