import { ContractError, registry, type RequestFrame, type Scope } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { TOP_CEILING, type VerifiedClientSession } from "../auth/client-sessions.js";
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

const request = (method: string, params: Record<string, unknown> = {}): RequestFrame => ({ type: "request", id: "r1", method, params });

/** Dispatches one request and resolves with the one answer it gave, and no subscription opened. */
const answer = async (methods: MethodHandlers, frame: RequestFrame, scopes: readonly Scope[]): Promise<Answer> => {
  const answers: Answer[] = [];
  const open = vi.fn();
  await createDispatch(createMethodTable(methods))(frame, caller(scopes), (given) => answers.push(given), open);
  expect(answers).toHaveLength(1);
  expect(open).not.toHaveBeenCalled();
  return answers[0] as Answer;
};

describe("dispatch", () => {
  it("refuses forbidden without running the handler", async () => {
    const handler = vi.fn(() => ({ readiness: "ready" as const }));
    expect(await answer({ "environment.status": handler }, request("environment.status"), ["admin"])).toEqual({
      error: { code: "forbidden", message: expect.stringContaining("read"), data: { scope: "read" } },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler with the parsed params and the caller, and answers its result", async () => {
    const handler = vi.fn(() => ({ readiness: "ready" as const }));
    expect(await answer({ "environment.status": handler }, request("environment.status", { ignored: 1 }), ["read"])).toEqual({
      result: { readiness: "ready" },
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
    const source = { stream: { kind: "environment", id: "e" }, snapshot: () => ({ status: { readiness: "ready" as const } }) };
    const handler = vi.fn(() => source);
    const answers: Answer[] = [];
    const opened: Opening[] = [];
    await createDispatch(createMethodTable({ "environment.subscribe": handler }))(
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
      "environment.subscribe": () => ({ stream: { kind: "environment", id: "e" }, snapshot: () => ({ status: { readiness: "ready" } }) }),
    };
    for (const [thrown, code] of [
      [new ContractError({ code: "conflict", message: "Not now.", data: {} }), "conflict"],
      [new Error("boom"), "internal"],
    ] as const) {
      const answers: Answer[] = [];
      await createDispatch(createMethodTable(methods))(request("environment.subscribe", { afterSequence: 0 }), caller(["read"]), (given) => answers.push(given), () => {
        throw thrown;
      });
      expect(answers).toMatchObject([{ error: { code } }]);
    }
    quiet.mockRestore();
  });

  it("serves a handler registered on its table after dispatch was made, replacing the one before", async () => {
    const table = createMethodTable({ "environment.status": () => ({ readiness: "starting" as const }) });
    const dispatch = createDispatch(table);
    table.register(registry["environment.status"], () => ({ readiness: "ready" }));
    const answers: Answer[] = [];
    await dispatch(request("environment.status"), caller(["read"]), (given) => answers.push(given), vi.fn());
    expect(answers).toEqual([{ result: { readiness: "ready" } }]);
  });

  it("answers invalid_params with the issues", async () => {
    expect(await answer({}, request("access.log.list", { limit: 0 }), ["admin"])).toMatchObject({
      error: { code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["limit"] })] } },
    });
  });
});
