import { expect, it } from "vitest";
import { registry } from "./registry.js";

it("publishes only through an admin command with explicit optional issue transfer and a reviewed result", () => {
  const method = registry["banks.publish"];
  const params = { commandId: "0f8fad5b-d9cb-469f-a165-70867728950e", bankId: "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10" };
  expect(method).toMatchObject({ scope: "admin", kind: "command" });
  expect(method.params.parse(params)).toEqual(params);
  expect(method.params.parse({ ...params, transferIssues: true })).toEqual({ ...params, transferIssues: true });
  expect(method.params.safeParse({ ...params, commandId: undefined }).success).toBe(false);
  expect(method.params.safeParse({ ...params, transferIssues: "yes" }).success).toBe(false);
  expect(method.error.options.map((schema) => schema.shape.code.value)).toContain("conflict");
});
