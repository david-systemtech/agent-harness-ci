import { z } from "zod";
import { errorSchema } from "../errors.js";
import { ForgeAccountId, ForgeAccountRecord, ForgeAddCredential, ForgeCopiedFrom, ForgeCredentialInput, ForgeDetails, ForgeIdentity } from "../forge-accounts.js";
import { GhProbe } from "../forge-gh.js";
import { FORGE_KINDS, ForgeKind, ForgeOrigin, ForgeSlug, ForgeTokenPage } from "../forge.js";
import { CredentialUnavailableError } from "../git-credential.js";
import { ReferenceProviderUnavailableError, CredentialSourceUnavailableError, ReferenceDeniedError, ReferenceNotFoundError } from "../key-managers.js";
import { commandParams, defineMethod } from "../method.js";
import { PullRequest, SessionId, SessionSummary } from "../sessions.js";

/**
 * The forge account methods (forge spec, "Wire methods"; ADR 0012, ADR
 * 0020): the list at `read`, add, update, remove and setPrimary at
 * `admin`, each a command whose events go on the environment stream, and
 * verify, an `admin` query that records what it finds there. A
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
 * Aliases are verified on their own origin as the canonical origin is, and
 * accepted only for the same login and user id (`alias_identity_mismatch`);
 * an alias another forge account holds is `conflict` (reason `origin_held`).
 *
 * A credential is read for the identity call as it is for every operation
 * (forge spec, "Credentials"): the environment's `gh` runs `gh auth token`
 * for the host and login, and a key-manager reference is resolved through
 * the key-manager registry, neither kept past the command. `forge.gh.probe`
 * says what `gh` is signed in as, for a client offering it.
 *
 * `forge.detect` says which forge a URL is on and which token to mint
 * there; `forge.orgs.list` reads the owners a forge account may create a
 * repository under, live and never stored (ADR 0020).
 *
 * `forge.pullRequests.link`, `unlink` and `refresh` keep a session's pull
 * requests (forge spec, "Pull-request links and status"; ADR 0012), whose
 * events and the summary's `pullRequests` are session-state's: a link and
 * an unlink are the session's own events, at `sessions:write`.
 */

/** The forge refused the credential: its identity endpoint answered a refusal (401, 403) or something that is no user, or a read it asked for answered so. */
export const VerificationFailedError = errorSchema(
  "verification_failed",
  z.object({
    origin: ForgeOrigin,
    status: z.int().meta({ description: "The HTTP status the forge answered." }),
    details: ForgeDetails.optional().meta({ description: "What the forge answered, behind the message's plain line; absent when the message says it all." }),
  }),
).meta({
  description:
    "The forge refused the credential, or answered no user on its identity endpoint (or, listing owners, no list; linking a pull request, no pull request): an add or update stored nothing, a link linked nothing. data names the origin and the HTTP status.",
});
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

/** An alias's origin answered as someone else than the forge account's identity, or refused the credential. */
export const AliasIdentityMismatchError = errorSchema(
  "alias_identity_mismatch",
  z.object({
    origin: ForgeOrigin.meta({ description: "The alias's origin." }),
    expected: ForgeIdentity.meta({ description: "The identity the credential answers as on the forge account's canonical origin." }),
    found: ForgeIdentity.nullable().meta({ description: "The identity the credential answered as on the alias; null when the alias refused it." }),
    status: z.int().meta({ description: "The HTTP status the alias's identity endpoint answered." }),
  }),
).meta({
  description:
    "An alias was not accepted: on its own origin the credential answered as another login or user id than on the forge account's canonical origin, or was refused there, so it is not the same instance. Nothing was changed; data names the alias, both identities and the status.",
});
export type AliasIdentityMismatchError = z.infer<typeof AliasIdentityMismatchError>;

/**
 * A harness operation on a forge was refused on an origin no forge account
 * covers (forge spec, "No forge account"; ADR 0020): it read anonymously,
 * and the forge asked for a credential. The refusal names the origin and the
 * Forges step, which a client deep-links to.
 */
export const ForgeAccountMissingError = errorSchema(
  "forge_account_missing",
  z.object({
    origin: ForgeOrigin.meta({ description: "The origin no forge account covers." }),
    step: z.literal("forges").meta({ description: "The Set up step that adds a forge account for it, for the deep link." }),
    details: ForgeDetails.optional().meta({ description: "What the harness was doing and what the forge answered, behind the message's plain line." }),
  }),
).meta({
  description:
    "The forge asked for a credential on an origin no forge account on this environment covers, after an anonymous read: data names the origin, and the Forges step that adds one.",
});
export type ForgeAccountMissingError = z.infer<typeof ForgeAccountMissingError>;

/** Detection found GitLab, whose forge accounts are milestone 2's (ADR 0033). */
export const KindUnsupportedError = errorSchema(
  "kind_unsupported",
  z.object({
    origin: ForgeOrigin,
    kind: ForgeKind.meta({ description: "The kind detection found: gitlab, which no forge account may be added for before milestone 2." }),
  }),
).meta({ description: "The URL is on a kind of forge the harness cannot add a forge account for yet (GitLab, milestone 2): data names the origin and the kind." });
export type KindUnsupportedError = z.infer<typeof KindUnsupportedError>;

/** The address answered, and none of detection's routes as a forge does. */
export const NotAForgeError = errorSchema("not_a_forge", z.object({ origin: ForgeOrigin })).meta({
  description:
    "The address answered, and as none of the forges the harness knows (GitHub, Forgejo, Gitea, GitLab) answers on its routes: data names the origin. Name the kind to add a forge account for it anyway.",
});
export type NotAForgeError = z.infer<typeof NotAForgeError>;

/** The forge did not answer, or answered that it could not now. */
export const ForgeUnreachableError = errorSchema(
  "unreachable",
  z.object({
    origin: ForgeOrigin.meta({ description: "The origin that did not answer." }),
    details: ForgeDetails.optional().meta({ description: "What failed, behind the message's plain line: no answer within ten seconds, a lost connection, HTTP 5xx or a rate limit." }),
  }),
).meta({
  description: "The forge could not be reached, or answered that it could not answer now (its own error, HTTP 5xx; a rate limit; no answer within ten seconds): the message says so plainly and data's details say which; data names the origin.",
});
export type ForgeUnreachableError = z.infer<typeof ForgeUnreachableError>;

/** The kinds a forge account is added with: GitLab is reserved for milestone 2 (ADR 0033). */
const AddableKind = ForgeKind.exclude(["gitlab"]).meta({
  description: `The kind of forge the URL is on: ${FORGE_KINDS.filter((kind) => kind !== "gitlab").join(", ")}; detected when absent. gitlab is reserved for milestone 2.`,
});

const forgeAccountResult = z.object({ account: ForgeAccountRecord });

/** The most aliases a forge account takes. */
export const MAX_FORGE_ALIASES = 16;

/** Alias origins, each given as `url` is: only its origin is kept. */
const Aliases = z
  .array(z.string().min(1).max(2048))
  .max(MAX_FORGE_ALIASES)
  .meta({
    description: `Other origins the same forge instance answers on (a tailnet or LAN address), each in any form url takes, of which only the origin is kept; at most ${MAX_FORGE_ALIASES}. Each is verified on its own origin with the credential and accepted only when it answers as the same login and user id; one that cannot be reached yet waits unverified, and is not served until a verification accepts it.`,
  });

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
 * `credential-unavailable`; a reference that cannot be read is rejected as
 * its resolve refuses it: `credential_source_unavailable` (its connection
 * not held, not signed in or not answering), `reference_not_found` or
 * `reference_denied`. Each alias is asked on its own origin
 * with the credential and accepted only when it answers as the same login
 * and user id, else `alias_identity_mismatch`; one that does not answer, or
 * any on a forge account that has no identity yet, waits unverified until a
 * verification accepts it. None asks nothing and keeps it with
 * problem `needs-credential`: a copy from another environment, which
 * `copiedFrom` names, awaiting a credential here. `gh` and a client's `gh`
 * are for GitHub forge accounts alone. The first
 * forge account becomes primary; `primary` makes another one primary,
 * clearing the one that was. The slug is derived from the host unless one
 * is given. An id already used is `conflict` (reason `exists`); an origin
 * or an alias another forge account holds as its origin or an alias is
 * `conflict` (reason `origin_held`); a slug in use is `conflict` (reason
 * `slug_taken`). A URL or an alias that is no remote, or an alias that is
 * the forge account's own origin, is `invalid_params`. Without a kind the
 * forge is detected as `forge.detect` detects it, before anything is
 * asked with the credential: GitLab is rejected `kind_unsupported`, an
 * address answering as no forge `not_a_forge` and one that does not answer
 * `unreachable`, and nothing is stored.
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
    aliases: Aliases.optional(),
    primary: z.boolean().optional().meta({ description: "Make it the primary forge, clearing the one that is. The first forge account is primary whatever this says." }),
    credential: ForgeAddCredential,
    copiedFrom: ForgeCopiedFrom.optional().meta({ description: "The environment a copy was made from, which the record keeps; absent for a forge account added here." }),
  }),
  result: forgeAccountResult,
  errors: [VerificationFailedError, AliasIdentityMismatchError, CredentialSourceUnavailableError, ReferenceNotFoundError, ReferenceDeniedError, ReferenceProviderUnavailableError, KindUnsupportedError, NotAForgeError, ForgeUnreachableError],
});

/**
 * Changes a forge account's slug, aliases or credential; what it has
 * already changes nothing. The aliases given replace its list: one it has
 * verified keeps its verification, and any other is asked on its own
 * origin with the credential (the new one when one is given), refused
 * `alias_identity_mismatch` when it answers as someone else, and waiting
 * unverified when it does not answer. An alias another forge account holds
 * is `conflict` (reason `origin_held`). A new credential is checked on the forge's identity
 * endpoint first: a refusal is `verification_failed`, another user id than
 * the forge account's is `identity_mismatch`, a reference that cannot be
 * read is refused as its resolve refuses it (`credential_source_unavailable`,
 * `reference_not_found`, `reference_denied`), and each changes nothing; a
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
    aliases: Aliases.optional().meta({ description: "The aliases the forge account keeps from now on, replacing its list: one it already has keeps its verification; a new one, or one not yet verified, is verified with the credential." }),
    credential: ForgeCredentialInput.optional().meta({ description: "The new credential, which must answer as the forge account's identity." }),
  }),
  result: forgeAccountResult,
  errors: [VerificationFailedError, IdentityMismatchError, AliasIdentityMismatchError, CredentialSourceUnavailableError, ReferenceNotFoundError, ReferenceDeniedError, ReferenceProviderUnavailableError],
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
 * Verifies one forge account now, or every one (forge spec, "Verification";
 * ADR 0020): its credential read, the identity endpoint called, the token's
 * kind, scopes and expiry read, and the two read capabilities probed, then
 * what changed recorded as `forge.account.verified`, as `accounts.refresh`
 * records its reads; a forge account being verified already is joined, not
 * verified twice. Answers every forge account's record after it. A copy
 * with no credential, and one whose credential answers as another user
 * until that credential is replaced, is not verified. At `admin`, since it
 * calls the forges with the environment's credentials.
 */
export const forgeAccountsVerify = defineMethod({
  name: "forge.accounts.verify",
  scope: "admin",
  kind: "query",
  params: z.object({ forgeAccountId: ForgeAccountId.optional().meta({ description: "The forge account to verify; every one when absent." }) }),
  result: z.object({ accounts: z.array(ForgeAccountRecord) }),
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

/**
 * Which forge a URL is on, and which token to mint there (forge spec,
 * "Providers" and "Wire methods"): the origin a URL in any form names, its
 * kind and version, and the token pages with what the token must be
 * granted, the one to offer first. Detection asks the address, with no
 * credential, in order: github.com is GitHub by its name; Forgejo's own
 * version route; the Gitea API's (a version carrying `+gitea-` is
 * Forgejo's); GitHub Enterprise's meta route; then GitLab's discovery
 * document, version route and project list (ADR 0033), answering
 * `kind_unsupported`. A Forgejo or Gitea whose API asks every caller to
 * sign in is known by that refusal, with no version. An address that
 * answers none of them as a forge is `not_a_forge`; one that does not
 * answer, or answers that it cannot now, is `unreachable`. A URL that is no
 * remote is `invalid_params`. At `admin`, since the environment calls an
 * address the caller chose.
 */
export const forgeDetect = defineMethod({
  name: "forge.detect",
  scope: "admin",
  kind: "query",
  params: z.object({ url: z.string().min(1).max(2048).meta({ description: "The forge's URL in any form git takes, or a repository's on it: only its origin is asked." }) }),
  result: z.object({
    origin: ForgeOrigin,
    kind: AddableKind.meta({ description: "The kind of forge the origin is: github, forgejo or gitea." }),
    version: z.string().min(1).nullable().meta({
      description: "The version the forge answered (16.0.3+gitea-1.22.0, 3.19.0); null where it gives none: github.com, and a Forgejo or Gitea that asks every caller to sign in.",
    }),
    tokenPages: z.array(ForgeTokenPage).min(1).meta({ description: "Where to mint the token and what to grant it, the page to offer first at the head." }),
  }),
  errors: [KindUnsupportedError, NotAForgeError, ForgeUnreachableError],
});

/** An owner a repository may be created under: the forge account's user, or an organisation it belongs to. */
export const ForgeOwner = z
  .object({
    login: z.string().min(1).meta({ description: "The user's login, or the organisation's name, as the forge answers it." }),
    kind: z.enum(["user", "organisation"]).meta({ description: "user: the forge account's own; organisation: one it is a member of." }),
  })
  .meta({ description: "An owner a repository may be created under on a forge: the user, or an organisation." });
export type ForgeOwner = z.infer<typeof ForgeOwner>;

/**
 * The owners a forge account may create a repository under (forge spec,
 * "Wire methods"; ADR 0020): its user first, then the organisations it is
 * a member of, read from the forge now and never stored. GitHub's come
 * from the memberships endpoint, active ones only, since its list of
 * organisations answers a fine-grained token with none; Forgejo's and
 * Gitea's from their own list. A credential that cannot be read, or that
 * answers as another user, is `credential_unavailable`; the forge refusing
 * it or answering no list is `verification_failed`; one that does not
 * answer `unreachable`. At `read`: it reads what the forge account's own
 * identity sees.
 */
export const forgeOrgsList = defineMethod({
  name: "forge.orgs.list",
  scope: "read",
  kind: "query",
  params: z.object({ forgeAccountId: ForgeAccountId }),
  result: z.object({ owners: z.array(ForgeOwner).meta({ description: "The user first, then each organisation in the order the forge lists them." }) }),
  errors: [CredentialUnavailableError, VerificationFailedError, ForgeUnreachableError],
});

/** A URL that is no pull request's web address a provider reads. */
export const NotAPullRequestError = errorSchema(
  "not_a_pull_request",
  z.object({
    origin: ForgeOrigin.nullable().meta({ description: "The origin the URL is on; null for a URL that names no forge." }),
  }),
).meta({
  description:
    "The URL is no pull request's web address on a forge a provider reads (GitHub's /<owner>/<repository>/pull/<number>, Forgejo's and Gitea's /<owner>/<repository>/pulls/<number>, on the kind of the forge account serving its origin): nothing was linked. data names its origin, when it has one.",
});
export type NotAPullRequestError = z.infer<typeof NotAPullRequestError>;

/** A pull request's web URL as a person gives it: any page of it, a query or a fragment, on any origin that serves it. */
const PullRequestUrlInput = z
  .string()
  .min(1)
  .max(2048)
  .meta({ description: "The pull request's web URL, or any page of it (its files, with a query or a fragment), on the forge's canonical origin or an alias of it." });

const summaryResult = z.object({ summary: SessionSummary.meta({ description: "The session as the command left it." }) });

/**
 * Links a pull request to a session (forge spec, "Pull-request links and
 * status"; ADR 0012): a prepared command that reads the pull request from
 * the forge first, with the forge account serving the URL's origin, or
 * anonymously where none does, and appends `session.pull-request-linked`
 * with what it read, as the linking client session. The session keeps it by
 * its web URL on the origin it was read from, the pull request's own page
 * however the URL was given. A URL no provider reads as a pull request is
 * `not_a_pull_request`; one the forge answers 404 with a forge account is
 * `not_found` (data kind `pull_request`); an anonymous read the forge
 * refuses (401, 403, or a 404, behind which a private repository hides) is
 * `forge_account_missing`; a credential that cannot be read is
 * `credential_unavailable`; the forge refusing the read otherwise, or
 * answering no pull request, is `verification_failed`; one that does not
 * answer is `unreachable`. A session that is not on this environment, or is
 * deleted, is `not_found` (data kind `session`). Linking one linked already
 * with the state read changes nothing; a link after an unlink links it
 * again, which discovery never does.
 */
export const forgePullRequestsLink = defineMethod({
  name: "forge.pullRequests.link",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ sessionId: SessionId, url: PullRequestUrlInput }),
  result: summaryResult,
  errors: [NotAPullRequestError, ForgeAccountMissingError, CredentialUnavailableError, VerificationFailedError, ForgeUnreachableError],
});

/**
 * Unlinks a pull request from a session: `session.pull-request-unlinked`,
 * as the client session, for the linked pull request the URL names (any
 * page of it, on any origin that serves it). The unlink sticks: discovery
 * never links a URL again whose latest event is an unlink, and only a
 * person's link does. A URL no pull request of the session answers to
 * changes nothing. A session that is not on this environment, or is
 * deleted, is `not_found` (data kind `session`).
 */
export const forgePullRequestsUnlink = defineMethod({
  name: "forge.pullRequests.unlink",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ sessionId: SessionId, url: PullRequestUrlInput }),
  result: summaryResult,
  errors: [],
});

/**
 * Reads a session's pull requests from the forge now, each that has not
 * merged (a merged one never changes), and appends
 * `session.pull-request-synced` for each whose state, merged-at or
 * closed-at changed, as `system:forge`; answers them after. A read that
 * fails keeps what the session held. A session that is not on this
 * environment, or is deleted, is `not_found` (data kind `session`).
 */
export const forgePullRequestsRefresh = defineMethod({
  name: "forge.pullRequests.refresh",
  scope: "read",
  kind: "query",
  params: z.object({ sessionId: SessionId }),
  result: z.object({ pullRequests: z.array(PullRequest).meta({ description: "The session's pull requests after the reads, in the order they were first linked." }) }),
  errors: [],
});
