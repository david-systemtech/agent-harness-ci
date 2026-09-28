import type { MethodHandlers } from "../serve/methods.js";
import type { ForgeService } from "./forge-service.js";

/**
 * The forge account methods on the method table (forge spec, "Wire
 * methods"): `forge.accounts.list` at `read`; `forge.accounts.add` and
 * `update`, prepared commands that hear from the forge first, and `remove`
 * and `setPrimary`, at `admin`, each appending to the environment stream.
 * The rules are the ForgeService's.
 */
export const forgeMethods = (forge: ForgeService): MethodHandlers => ({
  "forge.accounts.list": () => ({ accounts: forge.list() }),
  "forge.accounts.add": forge.add,
  "forge.accounts.update": forge.update,
  "forge.accounts.remove": forge.remove,
  "forge.accounts.setPrimary": forge.setPrimary,
});
