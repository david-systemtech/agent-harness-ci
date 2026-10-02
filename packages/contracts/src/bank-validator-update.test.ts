import { expect, it } from "vitest";
import { BANK_VALIDATOR, bankValidatorStatus, exportedSchemas, methods, STEP_PROMPTS } from "./index.js";

it("publishes one admin update command with commandId and the existing review, failure and tool schemas", () => {
  const matches = methods.filter((method) => method.name === "banks.validator.update");
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ scope: "admin", kind: "command" });
  expect(matches[0]?.params.safeParse({ bankId: "b2f6a1c9-7e04-4b5a-8c32-3d7f5e1a9b00" }).success).toBe(false);
  expect(exportedSchemas().map((schema) => schema.path)).toEqual(expect.arrayContaining([
    "methods/banks.validator.update/params.json", "methods/banks.validator.update/result.json", "banks/validator-status.json",
    "banks/events/bank.awaiting-review.json", "banks/events/bank.landed.json", "banks/events/bank.landing-failed.json",
    "errors/bank_read_only.json", "banks/tools/read.json",
  ]));
});

it("compares older and equal stamps numerically, refuses malformed stamps and never downgrades a newer bank", () => {
  expect(bankValidatorStatus("// bank-validator 9\n", 10)).toEqual({ installedVersion: 9, currentVersion: 10, needsUpdate: true });
  expect(bankValidatorStatus("// bank-validator 10\n", 10)).toEqual({ installedVersion: 10, currentVersion: 10, needsUpdate: false });
  expect(bankValidatorStatus("// bank-validator 11\r\n", 10)).toEqual({ installedVersion: 11, currentVersion: 10, needsUpdate: false });
  for (const text of [undefined, "", "// other-validator 1\n", "// bank-validator 0\n", "// bank-validator 1-extra\n", "// bank-validator 9007199254740992\n"]) expect(bankValidatorStatus(text).installedVersion).toBeNull();
  expect(bankValidatorStatus("// bank-validator 1\n").currentVersion).toBe(BANK_VALIDATOR.version);
  expect(STEP_PROMPTS.find((prompt) => prompt.id === "describe-bank")?.validator).toEqual(BANK_VALIDATOR);
});
