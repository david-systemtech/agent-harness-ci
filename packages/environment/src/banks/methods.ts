import { ContractError } from "@agent-harness/contracts";
import type { MethodHandlers } from "../serve/methods.js";
import type { BankService } from "./bank-service.js";

/**
 * The BankService's methods on the method table (banks spec, "The
 * BankService's methods"; #1025, #1026): reads and verification at `read`,
 * registry writes and forgetting at `admin`, a session's own pins at
 * `runs:drive`. Checkout reads and validation are prepared outside the
 * command transaction. The rules are the BankService's.
 */
export const bankMethods = (banks: BankService): MethodHandlers => ({
  "banks.list": async () => ({ banks: await banks.list() }),
  "banks.get": async (params) => {
    const bank = await banks.get(params.bankId);
    if (bank === null) throw new ContractError({ code: "not_found", message: `No bank ${params.bankId} is registered on this environment.`, data: {} });
    return { bank };
  },
  "banks.register": banks.register,
  "banks.registry.update": banks.update,
  "banks.pin": banks.pin,
  "banks.forget": banks.forget,
  "banks.create": banks.create,
  "banks.verify": async (params) => ({ banks: await banks.verify(params.bankId) }),
});
