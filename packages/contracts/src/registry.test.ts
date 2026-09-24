import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  CommandId,
  CommandReceipt,
  METHOD_KINDS,
  SCOPES,
  Sequence,
  defineMethod,
  errorSchema,
  isMethodName,
  methods,
  registry,
  type CommandName,
  type ErrorOf,
  type MethodName,
  type MintedPairing,
  type ParamsOf,
  type ResponseOf,
  type ResultOf,
  type SharedErrorCode,
} from "./index.js";

const unscoped = {
  name: "example.unscoped",
  params: z.object({}),
  result: z.object({}),
  errors: [],
  kind: "query",
} as const;

describe("the method registry", () => {
  // Modelled on T3 Code's RpcAuthorization test: the scope table and the
  // method table are one table, so a method cannot exist without its scope.
  it("declares exactly one scope for every registered method", () => {
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(typeof method.scope, method.name).toBe("string");
      expect(SCOPES, method.name).toContain(method.scope);
    }
  });

  it("is keyed by each method's own name, with no name registered twice", () => {
    const names = methods.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(registry).sort()).toEqual([...names].sort());
    for (const method of methods) expect(registry[method.name]).toBe(method);
  });

  it("gives the environment's own methods the scopes the env spec gives them", () => {
    expect(Object.fromEntries(methods.map((m) => [m.name, m.scope]))).toEqual({
      "environment.status": "read",
      "environment.subscribe": "read",
      "environment.drain": "admin",
      "environment.rebuildProjections": "admin",
      "access.pairings.create": "admin",
      "access.sessions.list": "admin",
      "access.sessions.revoke": "admin",
      "access.sessions.refresh": "read",
      "access.log.list": "admin",
    });
  });

  it("names every method area.verb", () => {
    for (const method of methods) expect(method.name).toMatch(/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/);
  });

  it("is a query, a command or a stream", () => {
    expect(METHOD_KINDS).toEqual(["query", "command", "stream"]);
    for (const method of methods) expect(METHOD_KINDS, method.name).toContain(method.kind);
  });

  it("takes a commandId UUID in the params of every command", () => {
    for (const method of methods.filter((m) => m.kind === "command")) {
      expect(method.params.shape, method.name).toHaveProperty("commandId", CommandId);
    }
    expect(methods.filter((m) => m.kind === "command").map((m) => m.name)).toEqual([
      "environment.drain",
      "environment.rebuildProjections",
      "access.pairings.create",
      "access.sessions.revoke",
      "access.sessions.refresh",
    ]);
  });

  it("answers every command with its receipt beside its result, which a retry or a rejection leaves out", () => {
    const receipt = { status: "accepted", sequence: 3, changed: true } as const;
    for (const method of methods) {
      if (method.kind !== "command") {
        expect("response" in method, method.name).toBe(false);
        continue;
      }
      expect(method.response.shape.receipt, method.name).toBe(CommandReceipt);
      expect(method.response.safeParse({ receipt }).success, method.name).toBe(true);
      expect(method.response.safeParse({}).success, method.name).toBe(false);
    }
    const drain = registry["environment.drain"].response;
    expect(drain.safeParse({ receipt, result: { drainingSince: "2026-09-24T00:00:00.000Z", trigger: "command" } }).success).toBe(true);
    expect(drain.safeParse({ receipt, result: { trigger: "command" } }).success).toBe(false);
  });

  it("types a command's response as its receipt and an optional result, and a query's as its result", () => {
    expectTypeOf<CommandName>().toEqualTypeOf<
      | "environment.drain"
      | "environment.rebuildProjections"
      | "access.pairings.create"
      | "access.sessions.revoke"
      | "access.sessions.refresh"
    >();
    expectTypeOf<ResponseOf<"access.pairings.create">>().toEqualTypeOf<{ receipt: CommandReceipt; result?: MintedPairing | undefined }>();
    expectTypeOf<ResultOf<"access.pairings.create">>().toEqualTypeOf<MintedPairing>();
    expectTypeOf<ResponseOf<"environment.status">>().toEqualTypeOf<ResultOf<"environment.status">>();
  });

  it("takes an afterSequence cursor in the params of every stream", () => {
    const streams = methods.filter((m) => m.kind === "stream");
    expect(streams.map((m) => m.name)).toEqual(["environment.subscribe"]);
    for (const method of streams) expect(method.params.shape, method.name).toHaveProperty("afterSequence", Sequence);
  });

  it("recognises registered names only, never Object.prototype's", () => {
    expect(isMethodName("environment.status")).toBe(true);
    for (const name of ["environment.nope", "toString", "constructor", "__proto__", "hasOwnProperty", ""]) {
      expect(isMethodName(name), name).toBe(false);
    }
  });

  it("gives every method the shared error union plus its own members", () => {
    const method = defineMethod({
      name: "example.frob",
      scope: "read",
      params: z.object({}),
      result: z.object({}),
      errors: [errorSchema("frob_jammed", z.object({ attempts: z.int() }))],
      kind: "query",
    });
    expect(method.error.safeParse({ code: "frob_jammed", message: "m", data: { attempts: 2 } }).success).toBe(true);
    expect(method.error.safeParse({ code: "frob_jammed", message: "m", data: {} }).success).toBe(false);
    expect(method.error.safeParse({ code: "conflict", message: "m", data: {} }).success).toBe(true);
    expect(method.error.safeParse({ code: "jammed", message: "m", data: {} }).success).toBe(false);
    expectTypeOf<z.infer<typeof method.error>["code"]>().toEqualTypeOf<SharedErrorCode | "frob_jammed">();
    expectTypeOf<ErrorOf<"environment.status">["code"]>().toEqualTypeOf<SharedErrorCode>();
  });

  it("refuses a method's own error that reuses a shared code", () => {
    expect(() =>
      defineMethod({ ...unscoped, scope: "read", errors: [errorSchema("conflict", z.object({ with: z.string() }))] }),
    ).toThrow(/conflict/);
  });

  it("types params and results from the table", () => {
    expectTypeOf<MethodName>().toEqualTypeOf<
      | "environment.status"
      | "environment.subscribe"
      | "environment.drain"
      | "environment.rebuildProjections"
      | "access.pairings.create"
      | "access.sessions.list"
      | "access.sessions.revoke"
      | "access.sessions.refresh"
      | "access.log.list"
    >();
    expectTypeOf<ParamsOf<"access.sessions.revoke">>().toEqualTypeOf<{ commandId: string; clientSessionId: string }>();
  });

  it("does not compile a method without exactly one scope, and refuses one at run time too", () => {
    // @ts-expect-error: a method without a scope is a type error.
    expect(() => defineMethod(unscoped)).toThrow(/scope/);
    // @ts-expect-error: exactly one scope, not a list of them.
    expect(() => defineMethod({ ...unscoped, scope: ["read", "admin"] })).toThrow(/scope/);
    // @ts-expect-error: only the five scopes exist.
    expect(() => defineMethod({ ...unscoped, scope: "write" })).toThrow(/scope/);
  });

  it("does not compile a command without a commandId, or a stream without a cursor, and refuses them at run time", () => {
    // @ts-expect-error: a command takes a commandId.
    expect(() => defineMethod({ ...unscoped, scope: "admin", kind: "command" })).toThrow(/commandId/);
    // @ts-expect-error: a stream takes an afterSequence cursor.
    expect(() => defineMethod({ ...unscoped, scope: "read", kind: "stream" })).toThrow(/afterSequence/);
    // @ts-expect-error: there are three kinds of method.
    expect(() => defineMethod({ ...unscoped, scope: "read", kind: "notification" })).toThrow(/kind/);
  });
});
