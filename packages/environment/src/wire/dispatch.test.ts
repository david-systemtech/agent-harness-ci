import { ContractError, registry, type EnvironmentStatus, type RequestFrame, type Scope } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOP_CEILING, type VerifiedClientSession } from "../auth/client-sessions.js";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { createMethodTable, type MethodHandlers } from "../serve/methods.js";
import { createDispatch, type Answer } from "./dispatch.js";
import type { Opening } from "./subscriptions.js";

const caller = (scopes: readonly Scope[]): VerifiedClientSession => ({
  id: "cs-1",
  kind: "program",
  scopes,
  ceiling: TOP_CEILING,
  local: false,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

/** A status as `environment.status` answers it, and a second one to tell a replaced handler from its successor. */
const ready: EnvironmentStatus = { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false };
const starting: EnvironmentStatus = { ...ready, readiness: "starting" };

let logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs) log.close();
  logs = [];
});

/** A fresh in-memory log for the commands a dispatch runs. */
const memoryLog = (): EventLog => {
  const log = openEventLog({ path: ":memory:" });
  logs.push(log);
  return log;
};

const request = (method: string, params: Record<string, unknown> = {}): RequestFrame => ({ type: "request", id: "r1", method, params });

/** Dispatches one request and resolves with the one answer it gave, and no subscription opened. */
const answer = async (methods: MethodHandlers, frame: RequestFrame, scopes: readonly Scope[]): Promise<Answer> => {
  const answers: Answer[] = [];
  const open = vi.fn();
  await createDispatch(createMethodTable(methods), memoryLog())(frame, caller(scopes), (given) => answers.push(given), open);
  expect(answers).toHaveLength(1);
  expect(open).not.toHaveBeenCalled();
  return answers[0] as Answer;
};

describe("dispatch", () => {
  it("refuses forbidden without running the handler", async () => {
    const handler = vi.fn(() => ready);
    expect(await answer({ "environment.status": handler }, request("environment.status"), ["admin"])).toEqual({
      error: { code: "forbidden", message: expect.stringContaining("read"), data: { scope: "read" } },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler with the parsed params and the caller, and answers its result", async () => {
    const handler = vi.fn(() => ready);
    expect(await answer({ "environment.status": handler }, request("environment.status", { ignored: 1 }), ["read"])).toEqual({
      result: ready,
    });
    expect(handler).toHaveBeenCalledWith({}, { clientSession: caller(["read"]) });
  });

  it("answers a ContractError the handler throws as it is", async () => {
    const methods: MethodHandlers = {
      "environment.status": () => {
        throw new ContractError({ code: "conflict", message: "Not now.", data: {} });
      },
    };
    expect(await answer(methods, request("environment.status"), ["read"])).toEqual({ error: { code: "conflict", message: "Not now.", data: {} } });
  });

  it("answers internal for anything else a handler throws, or a result outside its schema", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwing: MethodHandlers = {
      "environment.status": () => {
        throw new Error("boom");
      },
    };
    expect(await answer(throwing, request("environment.status"), ["read"])).toMatchObject({ error: { code: "internal" } });
    const wrong = { "environment.status": () => ({ readiness: "sleepy" }) } as unknown as MethodHandlers;
    expect(await answer(wrong, request("environment.status"), ["read"])).toMatchObject({ error: { code: "internal" } });
    expect(quiet).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });

  it("answers not_found for an unknown method, and for a method or a stream with no handler", async () => {
    expect(await answer({}, request("nothing.here"), ["read"])).toMatchObject({ error: { code: "not_found" } });
    expect(await answer({}, request("environment.subscribe", { afterSequence: 0 }), ["read"])).toMatchObject({ error: { code: "not_found" } });
    expect(await answer({}, request("access.sessions.list"), ["admin"])).toMatchObject({ error: { code: "not_found" } });
  });

  it("opens a stream rather than answering it: the request id, the source, the cursor and the snapshot's schema", async () => {
    const source = { stream: { kind: "environment", id: "e" }, snapshot: () => ({ status: ready }) };
    const handler = vi.fn(() => source);
    const answers: Answer[] = [];
    const opened: Opening[] = [];
    await createDispatch(createMethodTable({ "environment.subscribe": handler }), memoryLog())(
      request("environment.subscribe", { afterSequence: 7 }),
      caller(["read"]),
      (given) => answers.push(given),
      (opening) => void opened.push(opening),
    );
    expect(answers).toEqual([]);
    expect(opened).toEqual([
      { requestId: "r1", source, afterSequence: 7, payloadSchema: registry["environment.subscribe"].result },
    ]);
    expect(handler).toHaveBeenCalledWith({ afterSequence: 7 }, { clientSession: caller(["read"]) });
  });

  it("answers what opening a stream throws, as a handler's throw is answered", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const methods: MethodHandlers = {
      "environment.subscribe": () => ({ stream: { kind: "environment", id: "e" }, snapshot: () => ({ status: ready }) }),
    };
    for (const [thrown, code] of [
      [new ContractError({ code: "conflict", message: "Not now.", data: {} }), "conflict"],
      [new Error("boom"), "internal"],
    ] as const) {
      const answers: Answer[] = [];
      await createDispatch(createMethodTable(methods), memoryLog())(request("environment.subscribe", { afterSequence: 0 }), caller(["read"]), (given) => answers.push(given), () => {
        throw thrown;
      });
      expect(answers).toMatchObject([{ error: { code } }]);
    }
    quiet.mockRestore();
  });

  it("serves a handler registered on its table after dispatch was made, replacing the one before", async () => {
    const table = createMethodTable({ "environment.status": () => starting });
    const dispatch = createDispatch(table, memoryLog());
    table.register(registry["environment.status"], () => ready);
    const answers: Answer[] = [];
    await dispatch(request("environment.status"), caller(["read"]), (given) => answers.push(given), vi.fn());
    expect(answers).toEqual([{ result: ready }]);
  });

  it("runs a command in the log with the caller as its actor, and answers its receipt beside its result", async () => {
    const log = memoryLog();
    const stream = { kind: "environment", id: "e" };
    const handler = vi.fn(() => ({ aggregate: stream, result: { drainingSince: "2026-09-24T00:00:00.000Z", trigger: "command" as const } }));
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const answers: Answer[] = [];
    await createDispatch(createMethodTable({ "environment.drain": handler }), log)(
      request("environment.drain", { commandId }),
      caller(["admin"]),
      (given) => answers.push(given),
      vi.fn(),
    );
    expect(answers).toEqual([
      { result: { receipt: { status: "accepted", sequence: 0, changed: false }, result: { drainingSince: "2026-09-24T00:00:00.000Z", trigger: "command" } } },
    ]);
    expect(handler).toHaveBeenCalledWith({ commandId }, expect.objectContaining({ clientSession: caller(["admin"]), commandId, actor: "client_session:cs-1" }));
    expect(log.receipt("client_session:cs-1", commandId)).toMatchObject({ stream, status: "accepted" });
  });

  it("answers a rejection in its receipt, its reason the code, with a plain message and no data when the handler gives none", async () => {
    const log = memoryLog();
    const stream = { kind: "environment", id: "e" };
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const answers: Answer[] = [];
    const methods: MethodHandlers = { "environment.drain": () => ({ aggregate: stream, rejected: { code: "conflict" } }) };
    await createDispatch(createMethodTable(methods), log)(request("environment.drain", { commandId }), caller(["admin"]), (given) => answers.push(given), vi.fn());
    const receipt = {
      status: "rejected",
      sequence: 0,
      changed: false,
      reason: "conflict",
      error: { code: "conflict", message: "The command was rejected: conflict.", data: {} },
    };
    expect(answers).toEqual([{ result: { receipt } }]);
    expect(log.receipt("client_session:cs-1", commandId)).toMatchObject({ status: "rejected", error: receipt.error });
  });

  it("answers internal and stores no receipt for a command whose handler answers later or outside its schema", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stream = { kind: "environment", id: "e" };
    const handlers = [
      () => Promise.resolve({ aggregate: stream, result: { drainingSince: "2026-09-24T00:00:00.000Z", trigger: "command" } }),
      () => ({ aggregate: stream, result: { trigger: "sometime" } }),
    ];
    for (const handler of handlers) {
      const log = memoryLog();
      const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
      const answers: Answer[] = [];
      const methods = { "environment.drain": handler } as unknown as MethodHandlers;
      await createDispatch(createMethodTable(methods), log)(request("environment.drain", { commandId }), caller(["admin"]), (given) => answers.push(given), vi.fn());
      expect(answers).toMatchObject([{ error: { code: "internal" } }]);
      expect(log.receipt("client_session:cs-1", commandId)).toBeNull();
    }
    quiet.mockRestore();
  });

  it("answers invalid_params with the issues", async () => {
    expect(await answer({}, request("access.log.list", { limit: 0 }), ["admin"])).toMatchObject({
      error: { code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["limit"] })] } },
    });
  });
});
