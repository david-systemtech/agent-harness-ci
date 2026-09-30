import { z } from "zod";
import { AccountId } from "../accounts.js";
import { CarryOverInventory, CarryOverReport } from "../carry-over.js";
import { commandParams, defineMethod } from "../method.js";

/**
 * Carry over's methods (setup spec, "2. Carry over" and "Wire summary"; ADR
 * 0021), the sessions half (#578). An account the environment does not hold
 * is `not_found` (data `kind: account`); an account whose directory the
 * environment owns, rather than adopted in place, is `conflict` (reason
 * `not_adopted`): only an adopted directory holds anything to carry. An
 * adapter that cannot list its sessions is `invalid_params` (reason
 * `unsupported`, capability `sessionListing`). Nothing in the adopted
 * directory is created, linked or deleted.
 */

const accountId = AccountId.meta({ description: "The adopted account whose directory to carry over." });

/**
 * The sessions part of the Carry over card's counts: the sessions the
 * account's adapter lists, the archived, those whose working directory is
 * gone, and those new since the last import. Memory, skills and the rest of
 * the inventory are #580's.
 */
export const carryOverInventory = defineMethod({
  name: "carryOver.inventory",
  scope: "read",
  kind: "query",
  params: z.object({ accountId }),
  result: CarryOverInventory,
  errors: [],
});

/**
 * Imports every session the adopted account's adapter lists that this
 * environment does not hold, by provider session id (one a harness run has
 * continued included): each is `session.created` with origin `import`,
 * then, right after it when its working directory is gone,
 * `session.workspace-status-changed` (missing), then `session.archived` at
 * its last-modified time when it is tagged archived or its first prompt is
 * the provider scheduler's.
 * A session it cannot import is named in the report and the rest are kept;
 * then `carry-over.imported` with the counts and what failed, on the
 * environment stream as the caller, which is also the notice of that name.
 * `dryRun` answers the same report and writes nothing. A second run of the
 * account while one is under way is `conflict` (reason
 * `import_in_progress`). A prepared command: the adapter's listing and the
 * looks at each working directory come first, outside the transaction.
 */
export const carryOverRun = defineMethod({
  name: "carryOver.run",
  scope: "admin",
  kind: "command",
  params: commandParams({
    accountId,
    dryRun: z.boolean().meta({ description: "Answer the report of what an import would do, and write nothing." }),
    skills: z.boolean().meta({
      description: "The card's skills tick: copy the directory's skills and commands too. The copy is #580's; until it lands, no skill is copied.",
    }),
  }),
  result: CarryOverReport,
  errors: [],
});
