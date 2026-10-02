import { z } from "zod";
import { BankId } from "./bank-registry.js";
import { MemoryPromoteResult } from "./memory-drafts.js";
import { commandParams, defineMethod } from "./method.js";
import { BankReadOnlyError, ValidationFailedError } from "./methods/banks.js";

/** Replaces the vendored validator through the bank's existing reviewed landing path. */
export const banksValidatorUpdate = defineMethod({
  name: "banks.validator.update", scope: "admin", kind: "command",
  params: commandParams({ bankId: BankId }),
  result: z.object({
    version: z.int().positive().meta({ description: "The environment's BANK_VALIDATOR version." }),
    landing: MemoryPromoteResult.nullable().meta({ description: "The reviewed update's state, or null when the bank already has equal or newer rules." }),
  }),
  errors: [BankReadOnlyError, ValidationFailedError],
});
