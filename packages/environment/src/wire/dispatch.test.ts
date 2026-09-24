import { ContractError, registry, type RequestFrame, type Scope } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { TOP_CEILING, type VerifiedClientSession } from "../auth/client-sessions.js";
import type { MethodHandlers } from "../serve/methods.js";
import { createDispatch, type Answer } from "./dispatch.js";

const caller = (scopes: readonly Scope[]): VerifiedClientSession => ({
  id: "cs-1",
  kind: "program",
  scopes,
  ceiling: TOP_CEILING,
  local: false,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const request = (method: string, params: Record<string, unknown> = {}): RequestFrame => ({ type: "request", id: "r1", method, params });

/** Dispatches one request and resolves with the one answer it gave. */
const answer = async (methods: MethodHandlers, frame: RequestFrame, scopes: readonly Scope[]): Promise<Answer> => {
  const answers: Answer[] = [];
  await createDispatch(methods, registry)(frame, caller(scopes), (given) => answers.push(given));
  expect(answers).toHaveLength(1);
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

  it("answers not_found for an unknown method, a stream before #110 and a method with no handler", async () => {
    expect(await answer({}, request("nothing.here"), ["read"])).toMatchObject({ error: { code: "not_found" } });
    expect(await answer({}, request("environment.subscribe", { afterSequence: 0 }), ["read"])).toMatchObject({ error: { code: "not_found" } });
    expect(await answer({}, request("access.sessions.list"), ["admin"])).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers invalid_params with the issues", async () => {
    expect(await answer({}, request("access.log.list", { limit: 0 }), ["admin"])).toMatchObject({
      error: { code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["limit"] })] } },
    });
  });
});
