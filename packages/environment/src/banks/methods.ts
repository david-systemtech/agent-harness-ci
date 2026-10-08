import { ContractError } from "@agent-harness/contracts";
import type { MethodHandlers } from "../serve/methods.js";
import type { BankCredentials } from "./credentials.js";
import type { BankSyncer } from "./syncer.js";
import type { BankService } from "./bank-service.js";

/**
 * The BankService's methods on the method table (banks spec, "The
 * BankService's methods"; #1025, #1026): reads and verification at `read`,
 * registry writes and forgetting at `admin`, a session's own pins at
 * `runs:drive`. Checkout reads and validation are prepared outside the
 * command transaction. The rules are the BankService's.
 * Sync pulls through the Syncer at `read`.
 * Preview uses a temporary clone; joining prepares a validated full clone.
 */
export const bankMethods = (banks: BankService, credentials: BankCredentials, syncer: BankSyncer): MethodHandlers => ({
  "banks.join": banks.join,
  "banks.join.preview": async (params) => banks.preview(params.url),
  "banks.list": async () => ({ banks: await banks.list() }),
  "banks.get": async (params) => {
    const bank = await banks.get(params.bankId);
    if (bank === null) throw new ContractError({ code: "not_found", message: "That notebook is not on this computer.", data: { bankId: params.bankId } });
    return { bank };
  },
  "banks.register": banks.register,
  "banks.registry.update": banks.update,
  "banks.pin": banks.pin,
  "banks.forget": banks.forget,
  "banks.credential.set": credentials.set,
  "banks.credential.swap": credentials.swap,
  "banks.sync": async (params) => ({ banks: await syncer.sync(params.bankId) }),
  "banks.create": banks.create,
  "banks.publish": banks.publish,
  "banks.verify": async (params) => ({ banks: await banks.verify(params.bankId) }),
});
