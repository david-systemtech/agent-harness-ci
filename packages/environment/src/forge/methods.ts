import type { MethodHandlers } from "../serve/methods.js";
import type { ForgeService } from "./forge-service.js";

/**
 * The forge account methods on the method table (forge spec, "Wire
 * methods"): `forge.accounts.list` and `forge.gh.probe` at `read`;
 * `forge.accounts.add` and `update`, prepared commands that hear from the
 * forge first, and `remove` and `setPrimary`, at `admin`, each appending to
 * the environment stream; `forge.accounts.verify`, an `admin` query that
 * records what it finds there; `forge.detect`, an `admin` query, and
 * `forge.orgs.list` at `read`, which record nothing. The rules are the
 * ForgeService's.
 */
export const forgeMethods = (forge: ForgeService): MethodHandlers => ({
  "forge.accounts.list": () => ({ accounts: forge.list() }),
  "forge.accounts.add": forge.add,
  "forge.accounts.update": forge.update,
  "forge.accounts.remove": forge.remove,
  "forge.accounts.setPrimary": forge.setPrimary,
  "forge.accounts.verify": async (params) => ({ accounts: await forge.verify(params.forgeAccountId) }),
  "forge.gh.probe": () => forge.probeGh(),
  "forge.detect": (params) => forge.detect(params.url),
  "forge.orgs.list": (params) => forge.owners(params.forgeAccountId),
});
