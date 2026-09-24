import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ContractError, SHARED_ERRORS, SHARED_ERROR_CODES, SharedError, WireError, invalidParams } from "./index.js";

describe("the shared error union", () => {
  it("holds the seven errors every method may return", () => {
    expect(SHARED_ERROR_CODES).toEqual([
      "unauthorized",
      "forbidden",
      "unavailable",
      "invalid_params",
      "not_found",
      "conflict",
      "internal",
    ]);
  });

  it("gives every error a stable code, a message and structured data, and nothing else", () => {
    for (const member of SHARED_ERRORS) expect(Object.keys(member.shape)).toEqual(["code", "message", "data"]);
    expect(Object.keys(WireError.shape)).toEqual(["code", "message", "data"]);
  });

  it("tells a forbidden call which scope it needed, and an unavailable one why", () => {
    expect(SharedError.safeParse({ code: "forbidden", message: "m", data: { scope: "admin" } }).success).toBe(true);
    expect(SharedError.safeParse({ code: "forbidden", message: "m", data: {} }).success).toBe(false);
    expect(SharedError.safeParse({ code: "unavailable", message: "m", data: { readiness: "draining" } }).success).toBe(true);
  });
});

describe("invalid_params", () => {
  it("carries the schema's issues as plain data", () => {
    const failure = z.object({ label: z.string() }).safeParse({ label: 3 });
    if (failure.success) throw new Error("expected a failure");
    const error = invalidParams(failure.error.issues);
    expect(error.code).toBe("invalid_params");
    expect(error.data.issues).toEqual([expect.objectContaining({ code: "invalid_type", path: ["label"] })]);
    expect(JSON.parse(JSON.stringify(error))).toEqual(error);
    expect(SharedError.parse(error)).toEqual(error);
  });
});

describe("ContractError", () => {
  it("is the thrown form of a wire error and gives it back unchanged", () => {
    const wire = { code: "not_found", message: "No such client session.", data: { clientSessionId: "cs-9" } };
    const error = new ContractError(wire);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(wire.message);
    expect(error.code).toBe("not_found");
    expect(error.toWire()).toEqual(wire);
  });
});
