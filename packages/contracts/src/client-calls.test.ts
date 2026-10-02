import { describe, expect, it } from "vitest";
import {
  CLIENT_ANSWER_MAX_BYTES,
  BrowserChromeListCall,
  BrowserChromeListResult,
  CLIENT_CALL_KINDS,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  FORBIDDEN_REASONS,
  ForbiddenError,
  eventTypeEntry,
  methods,
  registry,
} from "./index.js";

/**
 * Client-addressed calls (browser spec, "The browser relay"; ADR 0014;
 * #554): the `client.call` notice a run's environment appends for the client
 * session that started the run, carrying a verb for a Chrome paired with
 * another environment and its deadline, and `client.answer`, the request
 * that client answers it with.
 */

const callId = "5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b";
const environmentId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const chromeId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const verb = {
  environmentId,
  chromeId,
  pageKey: `${environmentId}/${chromeId}`,
  command: { verb: "navigate", args: { url: "https://example.com/" } },
  deadline: "2026-09-24T00:00:20.000Z",
};
const call = { callId, clientSessionId: "cs-1", kind: "browser.chrome", payload: verb };

describe("the client.call notice", () => {
  it("is on the environment stream, never in the session list, addressed to one client session, with a kind and that kind's payload", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("client.call");
    expect(eventTypeEntry("environment", "client.call")).toMatchObject({
      list: false,
    });
    expect(CLIENT_CALL_KINDS).toEqual(["browser.chrome", "browser.dock"]);
    expect(EnvironmentNotice.parse({ type: "client.call", payload: call })).toEqual({ type: "client.call", payload: call });
    expect(
      EnvironmentNotice.safeParse({
        type: "client.call",
        payload: { ...call, clientSessionId: undefined },
      }).success,
    ).toBe(false);
    expect(
      EnvironmentNotice.safeParse({
        type: "client.call",
        payload: { ...call, kind: "browser.unknown" },
      }).success,
    ).toBe(false);
    expect(
      EnvironmentNotice.safeParse({
        type: "client.call",
        payload: { ...call, callId: "call-1" },
      }).success,
    ).toBe(false);
  });

  it("carries a dock verb with its page, allowance and deadline, without a Chrome destination", () => {
    const payload = {
      pageKey: verb.pageKey,
      command: verb.command,
      allowance: { host: "paypal.com" },
      deadline: verb.deadline,
    };
    expect(
      EnvironmentNotice.parse({
        type: "client.call",
        payload: { ...call, kind: "browser.dock", payload },
      }),
    ).toEqual({
      type: "client.call",
      payload: { ...call, kind: "browser.dock", payload },
    });
    expect(
      EnvironmentNotice.safeParse({
        type: "client.call",
        payload: {
          ...call,
          kind: "browser.dock",
          payload: { ...payload, deadline: undefined },
        },
      }).success,
    ).toBe(false);
  });

  it("carries a browser.chrome verb's Chrome, page key, verb and arguments, allowance and deadline, a null Chrome being the plain My Chrome", () => {
    const parse = (payload: object) =>
      EnvironmentNotice.safeParse({
        type: "client.call",
        payload: { ...call, payload },
      });
    expect(parse({ ...verb, allowance: { host: "www.paypal.com" } }).success).toBe(true);
    expect(parse({ ...verb, chromeId: null }).success).toBe(true);
    expect(parse({ ...verb, environmentId: "desk" }).success).toBe(false);
    expect(parse({ ...verb, deadline: undefined }).success).toBe(false);
    expect(parse({ ...verb, command: { verb: "focus", args: {} } }).success).toBe(false);
    expect(parse({ ...verb, chromeId: undefined }).success).toBe(false);
  });

  it("carries a remote Chrome list request with its environment and deadline, and validates the list answer", () => {
    const payload = { operation: "list", environmentId, deadline: verb.deadline };
    expect(EnvironmentNotice.parse({ type: "client.call", payload: { ...call, payload } }).payload).toEqual({ ...call, payload });
    expect(BrowserChromeListCall.safeParse({ ...payload, environmentId: "desk" }).success).toBe(false);
    expect(BrowserChromeListCall.safeParse({ ...payload, deadline: undefined }).success).toBe(false);
    expect(BrowserChromeListResult.parse({ ok: true, environmentName: "desk", chromes: [] })).toEqual({ ok: true, environmentName: "desk", chromes: [] });
    expect(BrowserChromeListResult.safeParse({ ok: true, environmentName: "desk", chromes: [{ id: chromeId, name: "Work" }] }).success).toBe(false);
  });

});

describe("client.answer", () => {
  it("is a query at runs:drive answering whether the call took the answer", () => {
    expect(methods.find((method) => method.name === "client.answer")).toMatchObject({ kind: "query", scope: "runs:drive" });
    expect(registry["client.answer"].result.parse({ taken: true })).toEqual({
      taken: true,
    });
    expect(registry["client.answer"].result.safeParse({}).success).toBe(false);
  });

  it("takes the call's id with ok and the result, or not ok and the error a client names", () => {
    const params = registry["client.answer"].params;
    const outcome = { ok: true, value: { url: "https://example.com/", title: "Example" } };
    expect(params.parse({ callId, ok: true, result: outcome })).toEqual({ callId, ok: true, result: outcome });
    expect(params.parse({ callId, ok: true, result: null })).toEqual({ callId, ok: true, result: null });
    expect(params.parse({ callId, ok: false, error: { code: "unsupported", message: "This client has no handler for browser.chrome." } })).toMatchObject({ ok: false });
    expect(params.safeParse({ callId, ok: true }).success).toBe(false);
    expect(params.safeParse({ callId, ok: false, result: outcome }).success).toBe(false);
    expect(
      params.safeParse({
        callId,
        ok: true,
        result: outcome,
        error: { code: "handler_failed", message: "No." },
      }).success,
    ).toBe(false);
    expect(
      params.safeParse({
        callId,
        ok: false,
        error: { code: "", message: "No." },
      }).success,
    ).toBe(false);
    expect(params.safeParse({ callId: "call-1", ok: true, result: null }).success).toBe(false);
  });

  it("carries a result of at most 8 MiB, and a call answered by another client session than its own is forbidden with reason addressed", () => {
    expect(CLIENT_ANSWER_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(FORBIDDEN_REASONS).toContain("addressed");
    expect(ForbiddenError.safeParse({ code: "forbidden", message: "Another client session's call.", data: { scope: "runs:drive", reason: "addressed" } }).success).toBe(true);
  });
});
