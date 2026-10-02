import { z } from "zod";
import { AccountId } from "../accounts.js";
import { CarryOverInventory, StateImportAccountInventories, CarryOverMemoryAssignedPayload, CarryOverMemoryFolderName, CarryOverReport } from "../carry-over.js";
import { commandParams, defineMethod } from "../method.js";
import { RepositoryIdentity } from "../repository-identity.js";

/**
 * Carry over's methods (setup spec, "2. Carry over" and "Wire summary"; ADR
 * 0021): the sessions (#578), the memory, the skills tick and the rest of
 * the inventory (#580). An account the environment does not hold is
 * `not_found` (data `kind: account`); an account whose directory the
 * environment owns, rather than adopted in place, is `conflict` (reason
 * `not_adopted`): only an adopted directory holds anything to carry. An
 * adapter that cannot list its sessions is `invalid_params` (reason
 * `unsupported`, capability `sessionListing`). Nothing in the adopted
 * directory is created, linked or deleted.
 *
 * Memory is copied by ADR 0021's `carried/` rule, the one a session whose
 * auto-memory key changes is carried by (#329): each memory folder
 * (`projects/<folder>/memory/`) is mapped to the path a transcript in the
 * same project folder names, and the repository identity of that path's
 * git remote; its files are copied into the environment's auto-memory
 * directory for the key (the identity, else the main checkout, else the
 * path), never over a file there; a second source for one key, or a source
 * changed since it was copied, lands under `carried/<folder>/` with a
 * pointer line appended to `MEMORY.md`. A folder whose files are those an
 * import or an assignment copied to the same key before is kept.
 */

const accountId = AccountId.meta({ description: "The adopted account whose directory to carry over." });

/**
 * The Carry over card's counts: the sessions the account's adapter lists,
 * the archived, those whose working directory is gone, and those new since
 * the last import; the memory folders, the repositories they map to, the
 * unmappable and those an import would copy; the skills and commands as
 * `skills.carryOver`'s dry run answers them, with the checkouts offered as
 * sources; the subagents and plugins not carried; and the hooks, personal
 * MCP servers and permission rules that do not carry. Reads alone.
 * `source: state-import` previews every source-declared Claude directory,
 * without an Account or a caller-supplied path.
 */
export const carryOverInventory = defineMethod({
  name: "carryOver.inventory",
  scope: "read",
  kind: "query",
  params: z.union([z.strictObject({ accountId }), z.strictObject({ source: z.literal("state-import") })]),
  result: z.union([CarryOverInventory, StateImportAccountInventories]),
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
 * A session it cannot import is named in the report and the rest are kept.
 * Each mapped memory folder is copied by the rule above, and one that
 * cannot be is named; the unmappable are listed. With `skills`, it runs
 * `skills.carryOver` with the same `dryRun`, in the same command, and its
 * report joins this one. Then `carry-over.imported` with the counts and
 * what failed, on the environment stream as the caller, which is also the
 * notice of that name. `dryRun` answers the same report and writes
 * nothing. A second run of the account, or an assignment, while one is
 * under way is `conflict` (reason `import_in_progress`). A prepared
 * command: the adapter's listing, the looks at each working directory, the
 * memory copies and the skills' copies come first, outside the transaction.
 */
export const carryOverRun = defineMethod({
  name: "carryOver.run",
  scope: "admin",
  kind: "command",
  params: commandParams({
    accountId,
    dryRun: z.boolean().meta({ description: "Answer the report of what an import would do, and write nothing." }),
    skills: z.boolean().meta({
      description: "The card's skills tick: run skills.carryOver with the same dry run, copying the directory's skills and commands into the own directory, its report joining this one's.",
    }),
  }),
  result: CarryOverReport,
  errors: [],
});

/**
 * Copies a memory folder no transcript maps to the repository a person
 * picks, by the same rule as an import, and records the assignment
 * (`carry-over.memory-assigned`, also the notice of that name): a later
 * import copies the folder to that repository while no transcript maps it.
 * A folder the directory does not hold with a file in it is `not_found`
 * (data `kind: memory-folder`); one whose copy fails is `internal`, and
 * what it copied stays. An import of the account under way is `conflict`
 * (reason `import_in_progress`). A prepared command: the copy comes first,
 * outside the transaction.
 */
export const carryOverAssignMemory = defineMethod({
  name: "carryOver.assignMemory",
  scope: "admin",
  kind: "command",
  params: commandParams({
    accountId,
    folder: CarryOverMemoryFolderName.meta({ description: "The memory folder to assign, by its project folder's name under the adopted directory's projects/." }),
    repositoryIdentity: RepositoryIdentity.meta({ description: "The repository whose auto memory the folder is copied into." }),
  }),
  result: CarryOverMemoryAssignedPayload,
  errors: [],
});
