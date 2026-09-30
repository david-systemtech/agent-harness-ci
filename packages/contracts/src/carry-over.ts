import { z } from "zod";
import { AccountId } from "./accounts.js";

/**
 * Carry over (setup spec, "2. Carry over"; ADR 0021): the adopted account's
 * directory imported in one click. This is its sessions half (#578): what
 * `carryOver.inventory` counts of the sessions the account's adapter lists,
 * what an import of them did (the `carry-over.imported` notice) and what
 * `carryOver.run` answers. Memory, the skills tick and the rest of the
 * inventory join these (#580).
 */

const count = (description: string) => z.int().nonnegative().meta({ description });

/**
 * The sessions part of Carry over's inventory: the sessions the adapter
 * lists in the account's directory (orphaned and superseded transcripts
 * left out, a provider session listed twice counted once), those of them
 * that import archived, those whose working directory is gone, and those
 * this environment does not hold yet, which an import would bring in.
 */
export const CarryOverSessionsInventory = z
  .object({
    total: count("The sessions the account's directory holds, as its adapter lists them."),
    archived: count("Of them, those that import archived: tagged archived, or begun by the provider's scheduler."),
    missingDirectory: count("Of them, those whose working directory is gone."),
    new: count("Of them, those this environment does not hold yet, by provider session id: what an import brings in."),
  })
  .meta({ description: "The sessions Carry over finds in an adopted account's directory: every one, the archived, those with a missing directory, and the new." });
export type CarryOverSessionsInventory = z.infer<typeof CarryOverSessionsInventory>;

/** What `carryOver.inventory` answers: the account, and its directory's sessions counted. */
export const CarryOverInventory = z
  .object({
    accountId: AccountId,
    sessions: CarryOverSessionsInventory,
  })
  .meta({ description: "What Carry over's card counts in an adopted account's directory: its sessions." });
export type CarryOverInventory = z.infer<typeof CarryOverInventory>;

/**
 * What an import did with the listed sessions: how many it imported, of
 * them how many archived and how many marked missing, and how many it left
 * alone because the environment already held them.
 */
export const CarryOverSessionsImported = z
  .object({
    listed: count("The sessions the adapter listed, a provider session listed twice counted once."),
    imported: count("Those imported: each an imported session now, or, in a dry run, each one that would be."),
    archived: count("Of those imported, those imported archived."),
    missingDirectory: count("Of those imported, those marked missing, their working directory gone."),
    held: count("Those left alone: this environment already held them, by provider session id."),
  })
  .meta({ description: "What an import did with the listed sessions: imported, archived, marked missing, or left alone as held already." });
export type CarryOverSessionsImported = z.infer<typeof CarryOverSessionsImported>;

/** One thing an import could not do: a session it could not import, or the listing itself. */
export const CarryOverFailure = z
  .object({
    providerSessionId: z.string().min(1).nullable().meta({ description: "The provider session that was not imported; null when the listing itself failed and nothing could be." }),
    message: z.string().min(1).meta({ description: "What went wrong, for a person." }),
  })
  .meta({ description: "What an import could not do: a session it could not import, or (no provider session id) the directory it could not list." });
export type CarryOverFailure = z.infer<typeof CarryOverFailure>;

/**
 * `carry-over.imported`: an import of an adopted account's directory ended
 * (#578), appended on the environment stream as the client session that
 * ran it, in the transaction of what it imported: the counts, and what
 * failed, which a re-run tries again. What it imported stays imported.
 */
export const CarryOverImportedPayload = z
  .object({
    accountId: AccountId,
    sessions: CarryOverSessionsImported,
    failed: z.array(CarryOverFailure).meta({ description: "What could not be imported, each with why; empty when everything was." }),
  })
  .meta({ description: "carry-over.imported: an import of an adopted account's directory ended: what it did with the sessions, and what failed." });
export type CarryOverImportedPayload = z.infer<typeof CarryOverImportedPayload>;

/** What `carryOver.run` answers: the import's report, which a dry run answers the same, having written nothing. */
export const CarryOverReport = CarryOverImportedPayload.extend({
  dryRun: z.boolean().meta({ description: "Whether it was a dry run: the report of what an import would do, with nothing written." }),
}).meta({ description: "What an import of an adopted account's directory did, or, in a dry run, would do: the sessions' counts and what failed." });
export type CarryOverReport = z.infer<typeof CarryOverReport>;
