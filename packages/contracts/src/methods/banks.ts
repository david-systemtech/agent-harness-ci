import { z } from "zod";
import { BankJoinPreview } from "../bank-join.js";
import { CredentialUnavailableError } from "../git-credential.js";
import { ForgeAccountMissingError, ForgeOwner, ForgeUnreachableError, KindUnsupportedError, VerificationFailedError } from "./forge.js";
import { ForgeAccountId } from "../forge-accounts.js";
import { SecretShapedError } from "../shape-rules.js";
import { AccountId } from "../accounts.js";
import { BankAccountScope, BankFolderPointer, BankId, BankRecord, BankRepositoryScope, BankRole, BankUpdatedPayload } from "../bank-registry.js";
import { BankFinding, BankName, BankRuleId } from "../banks.js";
import { errorSchema } from "../errors.js";
import { commandParams, defineMethod } from "../method.js";
import { CredentialSourceUnavailableError, ReferenceDeniedError, ReferenceNotFoundError, ReferenceProviderUnavailableError, KeyManagerReference } from "../key-managers.js";
import { RepositoryIdentity } from "../repository-identity.js";
import { SessionId } from "../sessions.js";

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

/** Changes registry settings; omitted fields keep their values. Fixed tiers must still fit every scope. */
export const banksRegistryUpdate = defineMethod({
  name: "banks.registry.update",
  scope: "admin",
  kind: "command",
  params: commandParams(BankUpdatedPayload.pick({ bankId: true, role: true, enabled: true, accounts: true, repositories: true, defaultFor: true, pins: true, mergeOverride: true, privateCopy: true }).shape),
  result: z.object({ bank: BankRecord }),
  errors: [ValidationFailedError],
});

/** Records a session's own folder pin, leaving registry pins unchanged. */
export const banksPin = defineMethod({
  name: "banks.pin",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({ sessionId: SessionId, pointer: BankFolderPointer, pinned: z.boolean() }),
  result: z.object({ sessionId: SessionId, pins: z.array(BankFolderPointer) }),
  errors: [],
});

/** Unregisters a bank; removing its checkout is opt-in and only for a checkout the BankService owns. */
export const banksForget = defineMethod({
  name: "banks.forget",
  scope: "admin",
  kind: "command",
  params: commandParams({ bankId: BankId, removeCheckout: z.boolean().optional().meta({ description: "Remove the BankService's checkout too; false when absent. A registered checkout is never removed." }) }),
  result: z.object({ bankId: BankId, checkoutRemoved: z.boolean() }),
  errors: [],
});

/** Shallow temporary clone under the git budget: preview never registers or attaches the bank. */
export const banksJoinPreview = defineMethod({
  name: "banks.join.preview",
  scope: "read",
  kind: "query",
  params: z.object({ url: z.string().min(1).max(2048) }),
  result: BankJoinPreview,
  errors: [ValidationFailedError, ForgeAccountMissingError, CredentialUnavailableError, ForgeUnreachableError, KindUnsupportedError],
});

/** Joins with exactly the selected accounts; none are preset, and a join becomes no account's default. */
export const banksJoin = defineMethod({
  name: "banks.join",
  scope: "admin",
  kind: "command",
  params: commandParams({
    bankId: BankId,
    url: z.string().min(1).max(2048),
    accounts: z.array(AccountId).meta({ description: "Exactly the accounts ticked by the teammate, none preset; an empty selection attaches to no account." }),
    repositories: BankRepositoryScope,
  }),
  result: z.object({ bank: BankRecord }),
  errors: [ValidationFailedError, ForgeAccountMissingError, CredentialUnavailableError, ForgeUnreachableError, KindUnsupportedError],
});

/** A fallback token sent once, only when no forge account serves the bank's origin. */
export const banksCredentialSet = defineMethod({
  name: "banks.credential.set",
  scope: "admin",
  kind: "command",
  params: commandParams({ bankId: BankId, token: z.string().min(1).regex(/^[^\r\n\0]+$/).meta({ description: "A token sent directly once, kept in the environment vault and never returned." }) }),
  result: z.object({}),
  errors: [],
});

/** Move swaps the bank's source through this command after verifying the target's value. */
export const banksCredentialSwap = defineMethod({
  name: "banks.credential.swap",
  scope: "admin",
  kind: "command",
  params: commandParams({ bankId: BankId, reference: KeyManagerReference }),
  result: z.object({}),
  errors: [CredentialSourceUnavailableError, ReferenceDeniedError, ReferenceNotFoundError, ReferenceProviderUnavailableError],
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

/** Creates and admits a bank from the shipped template; describe is a later session. */
export const banksCreate = defineMethod({
  name: "banks.create",
  scope: "admin",
  kind: "command",
  params: commandParams({
    bankId: BankId,
    name: BankName,
    creation: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("personal"),
        localOnly: z.boolean().meta({ description: "Keep the bank on this machine, else create it privately under the login on the primary forge." }),
        personName: z.string().trim().min(1).max(40).optional().meta({ description: "Optional display name for the first entity; otherwise the creator's forge login, or OS username locally." }),
        org: BankName.meta({ description: "First seed answer: what the person calls their own work, preset personal." }),
        project: BankName.meta({ description: "Second seed answer: the first project, preset to the primary repository's name." }),
      }),
      z.strictObject({
        kind: z.literal("team"),
        forgeAccountId: ForgeAccountId,
        owner: ForgeOwner.meta({ description: "A user or organisation from forge.orgs.list for the selected verified account." }),
        repositoryName: BankName,
        teamName: z.string().trim().min(1).max(40),
        org: BankName.meta({ description: "The team's first org folder." }),
        projects: z.array(z.strictObject({ name: z.string().trim().min(1).max(100), folder: BankName })).min(1).max(40),
      }),
    ]),
  }),
  result: z.object({ bank: BankRecord }),
  errors: [ValidationFailedError, SecretShapedError, ForgeAccountMissingError, CredentialUnavailableError, VerificationFailedError, ForgeUnreachableError, KindUnsupportedError],
});
