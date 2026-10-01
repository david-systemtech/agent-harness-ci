import { z } from "zod";
import { AccountId } from "../accounts.js";
import { BankAccountScope, BankId, BankRecord, BankRepositoryScope, BankRole } from "../bank-registry.js";
import { BankFinding, BankName, BankRuleId } from "../banks.js";
import { errorSchema } from "../errors.js";
import { commandParams, defineMethod } from "../method.js";
import { RepositoryIdentity } from "../repository-identity.js";

/**
 * The BankService's methods (banks spec, "The BankService's methods"; ADR
 * 0010, ADR 0035, ADR 0036). Records answer with their status, counts and
 * rendered bank line, never a credential.
 *
 * A bank the environment does not hold is `not_found`. A name another bank
 * holds is `conflict` with reason `name_taken`; a registry change under
 * which an account and repository would carry more than 8 KB of fixed tiers
 * is `conflict` with reason `index_too_large`, its data naming the banks and
 * the scopes (`BankIndexConflict`); the other reasons are
 * `BANK_CONFLICT_REASONS`'.
 */

/** Where an account and a repository would carry more than 8 KB of fixed tiers, and the banks that would. */
export const BankIndexConflict = z
  .object({
    reason: z.literal("index_too_large"),
    bytes: z.int().positive().meta({ description: "The fixed tiers' size, in bytes, under the first scope that is over." }),
    limitBytes: z.int().positive().meta({ description: "The limit: 8 KB." }),
    banks: z.array(BankName).min(1).meta({ description: "The banks whose fixed tiers add up past the limit, by name." }),
    scopes: z
      .array(
        z.object({
          account: z.union([z.literal("all"), AccountId]).meta({ description: "The account, or all for every account." }),
          repository: z.union([z.literal("all"), RepositoryIdentity]).meta({ description: "The repository, or all for every repository." }),
        }),
      )
      .min(1)
      .meta({ description: "The account and repository scopes under which they do." }),
  })
  .meta({ description: "The data of a conflict with reason index_too_large: the banks and the scopes under which their fixed tiers would pass 8 KB." });
export type BankIndexConflict = z.infer<typeof BankIndexConflict>;

/** Several writable banks are in scope and the call named none (ADR 0010: no auto-routing). */
export const BankRequiredError = errorSchema(
  "bank_required",
  z.object({ banks: z.array(BankName).min(2).meta({ description: "The writable banks in scope, by name." }) }),
).meta({ description: "Several writable banks are in scope and the call named none: data lists them; name one." });
export type BankRequiredError = z.infer<typeof BankRequiredError>;

/** The bank named is read-only. */
export const BankReadOnlyError = errorSchema("bank_read_only", z.object({ bank: BankName })).meta({
  description: "The bank named is read-only for this account: data names it.",
});
export type BankReadOnlyError = z.infer<typeof BankReadOnlyError>;

/** The validator refused a write: the rule ids, never a value. */
export const ValidationFailedError = errorSchema(
  "validation_failed",
  z.object({
    rules: z.array(BankRuleId).min(1).meta({ description: "The validator rules the write fails." }),
    findings: z.array(BankFinding).meta({ description: "Every finding of the verdict, refusals and warnings." }),
  }),
).meta({ description: "The bank validator refused the write: data names the rules and each finding, never a secret's value." });
export type ValidationFailedError = z.infer<typeof ValidationFailedError>;

/** Every bank, with its status, counts and line. */
export const banksList = defineMethod({
  name: "banks.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ banks: z.array(BankRecord) }),
  errors: [],
});

/** One bank; `not_found` for one the environment does not hold. */
export const banksGet = defineMethod({
  name: "banks.get",
  scope: "read",
  kind: "query",
  params: z.object({ bankId: BankId }),
  result: z.object({ bank: BankRecord }),
  errors: [],
});

/**
 * Registers an existing checkout by its path (the state import, ADR 0036),
 * keeping the path, with the role, scopes and default given. A repeated
 * `importedFrom` answers the bank registered from it, appending nothing. A
 * checkout without `BANK.md` registers, its name its folder's, and shows
 * needs attention until the migration. A prepared command: the checkout is
 * verified first, outside the transaction; `bank.added` carries what that
 * verification found. Refused `conflict` with reason `name_taken`, or
 * `index_too_large`; `invalid_params` for a path that is no git repository.
 */
export const banksRegister = defineMethod({
  name: "banks.register",
  scope: "admin",
  kind: "command",
  params: commandParams({
    bankId: BankId,
    path: z.string().min(1).meta({ description: "The checkout's absolute path on the environment's machine." }),
    role: BankRole,
    accounts: BankAccountScope,
    repositories: BankRepositoryScope,
    defaultFor: z.array(AccountId).meta({ description: "The accounts this bank becomes the default write target for." }),
    importedFrom: z.string().min(1).optional().meta({ description: "What the state import registers it from; a repeated one answers the bank registered from it." }),
  }),
  result: z.object({ bank: BankRecord }),
  errors: [],
});

/**
 * Verifies one bank now, or every enabled one (banks spec, "The Memory bank
 * step"): its remote's reachability, or a local-only repository's
 * existence; `BANK.md` on main against the validator, or an open pull
 * request holding it; the orientation memories; a team bank's owners on its
 * forge. What changed is recorded as `bank.verified`, as `system:banks`; a
 * verification running is joined. Answers the records after.
 */
export const banksVerify = defineMethod({
  name: "banks.verify",
  scope: "read",
  kind: "query",
  params: z.object({ bankId: BankId.optional().meta({ description: "The bank to verify; every enabled one when absent." }) }),
  result: z.object({ banks: z.array(BankRecord) }),
  errors: [],
});

/** Pulls one bank now, or every enabled one; records the last successful fetch as system:banks, even when main did not move. */
export const banksSync = defineMethod({
  name: "banks.sync",
  scope: "read",
  kind: "query",
  params: z.object({ bankId: BankId.optional().meta({ description: "The bank to pull; every enabled one when absent." }) }),
  result: z.object({ banks: z.array(BankRecord) }),
  errors: [],
});
