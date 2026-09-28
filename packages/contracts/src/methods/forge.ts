import { z } from "zod";
import { errorSchema } from "../errors.js";
import { ForgeAccountId, ForgeAccountRecord, ForgeAddCredential, ForgeCopiedFrom, ForgeCredentialInput, ForgeIdentity } from "../forge-accounts.js";
import { GhProbe } from "../forge-gh.js";
import { FORGE_KINDS, ForgeKind, ForgeOrigin, ForgeSlug } from "../forge.js";
import { KeyManagerConnectionId } from "../key-managers.js";
import { commandParams, defineMethod } from "../method.js";

/**
 * The forge account methods (forge spec, "Wire methods"; ADR 0012, ADR
 * 0020): the list at `read`, and add, update, remove and setPrimary at
 * `admin`, each a command whose events go on the environment stream. A
 * forge account the environment does not hold is rejected `not_found`
 * (data `kind: forge_account`). A pasted token crosses the wire once, in add
 * or update, and is never answered back: not in a result, a receipt, an
 * event or an `invalid_params` issue.
 *
 * Add and update are prepared commands: they hear from the forge's identity
 * endpoint before their transaction, as `runs.withdraw` hears from the
 * provider. The token is written to the environment's vault before the
 * transaction and removed again when the command is rejected.
 *
 * A credential is read for the identity call as it is for every operation
 * (forge spec, "Credentials"): the environment's `gh` runs `gh auth token`
 * for the host and login, and a key-manager reference is resolved through
 * the key-manager registry, neither kept past the command. `forge.gh.probe`
 * says what `gh` is signed in as, for a client offering it.
 */

/** The forge refused the credential: its identity endpoint answered a refusal (401, 403) or something that is no user. */
export const VerificationFailedError = errorSchema(
  "verification_failed",
  z.object({
    origin: ForgeOrigin,
    status: z.int().meta({ description: "The HTTP status the forge's identity endpoint answered." }),
  }),
).meta({ description: "The forge refused the credential, or its identity endpoint answered no user: nothing was stored. data names the origin and the HTTP status." });
export type VerificationFailedError = z.infer<typeof VerificationFailedError>;

/** A new credential answered as another user than the forge account's. */
export const IdentityMismatchError = errorSchema(
  "identity_mismatch",
  z.object({
    forgeAccountId: ForgeAccountId,
    expected: ForgeIdentity.meta({ description: "The identity the forge account holds." }),
    found: ForgeIdentity.meta({ description: "The identity the new credential answered as." }),
  }),
).meta({ description: "The new credential answered with another user id than the forge account's: nothing was changed. data names both identities." });
export type IdentityMismatchError = z.infer<typeof IdentityMismatchError>;

/** A key-manager reference could not be read: no key-manager connection holds it, or it answered no value. */
export const CredentialSourceUnavailableError = errorSchema(
  "credential_source_unavailable",
  z.object({ connectionId: KeyManagerConnectionId.meta({ description: "The key-manager connection the reference names." }) }),
).meta({
  description:
    "The credential's key-manager reference could not be read: no key-manager connection holds it, the connection is not signed in, or it answered no value. Nothing was changed; the message says which, and data names the connection.",
});
export type CredentialSourceUnavailableError = z.infer<typeof CredentialSourceUnavailableError>;

/** The kinds a forge account is added with: GitLab is reserved for milestone 2 (ADR 0033). */
const AddableKind = ForgeKind.exclude(["gitlab"]).meta({
  description: `The kind of forge the URL is on: ${FORGE_KINDS.filter((kind) => kind !== "gitlab").join(", ")}; optional for github.com, which is GitHub. gitlab is reserved for milestone 2.`,
});

const forgeAccountResult = z.object({ account: ForgeAccountRecord });

/** Every forge account the environment holds, in the order they were added, each with the exact variable names it injects; never a secret. */
export const forgeAccountsList = defineMethod({
  name: "forge.accounts.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ accounts: z.array(ForgeAccountRecord) }),
  errors: [],
});

/**
 * Adds a forge account for the origin a URL in any form names (an https or
 * http URL, ssh, scp-like, a bare host and port), with its credential: a
 * token sent once (pasted, or handed over from the calling client's `gh`,
 * whose client session is recorded), the environment's `gh` for a login, a
 * key-manager reference, or none. The forge's identity endpoint is called
 * with the credential first: a refusal is rejected `verification_failed`
 * and nothing is stored; a forge that does not answer keeps the forge
 * account with problem `unreachable`; a `gh` that is missing, older than
 * 2.40 or not signed in to the host as the login keeps it with problem
 * `credential-unavailable`; a reference that cannot be read is rejected
 * `credential_source_unavailable`. None asks nothing and keeps it with
 * problem `needs-credential`: a copy from another environment, which
 * `copiedFrom` names, awaiting a credential here. `gh` and a client's `gh`
 * are for GitHub forge accounts alone. The first
 * forge account becomes primary; `primary` makes another one primary,
 * clearing the one that was. The slug is derived from the host unless one
 * is given. An id already used is `conflict` (reason `exists`); an origin
 * another forge account holds as its origin or an alias is `conflict`
 * (reason `origin_held`); a slug in use is `conflict` (reason
 * `slug_taken`). A URL that is no remote, or no kind for an origin other
 * than github.com, is `invalid_params`.
 */
export const forgeAccountsAdd = defineMethod({
  name: "forge.accounts.add",
  scope: "admin",
  kind: "command",
  params: commandParams({
    forgeAccountId: ForgeAccountId,
    url: z.string().min(1).max(2048).meta({ description: "The forge's URL in any form git takes, or a repository's on it: only its origin is kept." }),
    kind: AddableKind.optional(),
    slug: ForgeSlug.optional().meta({ description: "The slug its variables are named by; derived from the host when absent." }),
    primary: z.boolean().optional().meta({ description: "Make it the primary forge, clearing the one that is. The first forge account is primary whatever this says." }),
    credential: ForgeAddCredential,
    copiedFrom: ForgeCopiedFrom.optional().meta({ description: "The environment a copy was made from, which the record keeps; absent for a forge account added here." }),
  }),
  result: forgeAccountResult,
  errors: [VerificationFailedError, CredentialSourceUnavailableError],
});

/**
 * Changes a forge account's slug or credential; what it has already
 * changes nothing. A new credential is checked on the forge's identity
 * endpoint first: a refusal is `verification_failed`, another user id than
 * the forge account's is `identity_mismatch`, a reference that cannot be
 * read is `credential_source_unavailable`, and each changes nothing; a
 * forge that does not answer keeps the new credential with problem
 * `unreachable`, and a `gh` that cannot give a token keeps it with problem
 * `credential-unavailable`. A reference in place of a stored token is the
 * Key manager step's Move. The replaced token's vault entry is deleted once
 * the change has committed. A slug in use is `conflict` (reason
 * `slug_taken`).
 */
export const forgeAccountsUpdate = defineMethod({
  name: "forge.accounts.update",
  scope: "admin",
  kind: "command",
  params: commandParams({
    forgeAccountId: ForgeAccountId,
    slug: ForgeSlug.optional().meta({ description: "The new slug." }),
    credential: ForgeCredentialInput.optional().meta({ description: "The new credential, which must answer as the forge account's identity." }),
  }),
  result: forgeAccountResult,
  errors: [VerificationFailedError, IdentityMismatchError, CredentialSourceUnavailableError],
});

/** Removes a forge account (`forge.account.removed`); its stored token's vault entry is deleted once the removal has committed. A primary one leaves none primary until a person chooses. */
export const forgeAccountsRemove = defineMethod({
  name: "forge.accounts.remove",
  scope: "admin",
  kind: "command",
  params: commandParams({ forgeAccountId: ForgeAccountId }),
  result: z.object({ forgeAccountId: ForgeAccountId }),
  errors: [],
});

/** Makes a forge account the primary forge, in one `forge.account.primary-set` naming the one it cleared; the primary already appends nothing. */
export const forgeAccountsSetPrimary = defineMethod({
  name: "forge.accounts.setPrimary",
  scope: "admin",
  kind: "command",
  params: commandParams({ forgeAccountId: ForgeAccountId }),
  result: forgeAccountResult,
  errors: [],
});

/**
 * What the environment's own `gh` is (forge spec, "Wire methods"; ADR 0032):
 * whether it is installed, its version against the minimum, and per
 * signed-in host the login, whether it is active, and its token's kind and
 * scopes, read through `gh auth status` without the token variables, so it
 * reports the accounts `gh` stores. Never a token. At `read`, as
 * `accounts.probe` is.
 */
export const forgeGhProbe = defineMethod({
  name: "forge.gh.probe",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: GhProbe,
  errors: [],
});
