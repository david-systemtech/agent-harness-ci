import { ContractError } from "@agent-harness/contracts";
import type { MethodHandlers } from "../serve/methods.js";
import type { BankService } from "./bank-service.js";

/**
 * The BankService's methods on the method table (banks spec, "The
 * BankService's methods"; #1025): `banks.list` and `banks.get` at `read`;
 * `banks.register`, an `admin` command prepared by reading and verifying
 * the checkout first; `banks.join.preview`, a read-only temporary clone;
 * `banks.join`, an admin command prepared by cloning and validating;
 * `banks.verify`, a `read` query that records what it
 * finds as `system:banks`. The rules are the BankService's.
 */
export const bankMethods = (banks: BankService): MethodHandlers => ({
  "banks.join": banks.join,
  "banks.join.preview": async (params) => banks.preview(params.url),
  "banks.list": async () => ({ banks: await banks.list() }),
  "banks.get": async (params) => {
    const bank = await banks.get(params.bankId);
    if (bank === null) throw new ContractError({ code: "not_found", message: `No bank ${params.bankId} is registered on this environment.`, data: {} });
    return { bank };
  },
  "banks.register": banks.register,
  "banks.verify": async (params) => ({ banks: await banks.verify(params.bankId) }),
});
