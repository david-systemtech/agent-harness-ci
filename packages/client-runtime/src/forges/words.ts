import {
  FORGE_CAPABILITIES,
  PRODUCT_NAME,
  forgeOriginHost,
  normaliseRemote,
  type ForgeAccountRecord,
  type ForgeAlias,
  type ForgeCapabilities,
  type ForgeCapability,
  type ForgeCapabilityName,
  type ForgeCredentialSource,
  type ForgeIdentity,
  type ForgeKind,
  type ForgeProblem,
  type ForgeProblemKind,
  type ForgeTokenPage,
  type ForgeTokenPermission,
  type GhProbe,
  type PullRequest,
  type PullRequestState,
} from "@agent-harness/contracts";
import type { CopyReport } from "../copies.js";
import { KEY_MANAGER_PROVIDER_WORDS, listWords } from "../key-managers/words.js";
import { whenWords } from "../transcript/format.js";
import { plainRefusal, type PlainRefusal, type RefusedAnswer } from "../words/refusal.js";

/**
 * A forge account and a session's pull requests in words, as both
 * renderers say them (forge spec, "The forge account record" and
 * "Pull-request links and status"; ADR 0020, ADR 0032; #419): each fact of
 * `forge.accounts.list`'s record a card shows, the token pages
 * `forge.detect` names, what a copy came to, and a pull request's state;
 * and the Forges step's row (#589): each capability with its state, each
 * alias with its verification, what fixes a problem, and what the
 * environment's own `gh` offers. Nothing here reads a secret: the record
 * holds none.
 */

/** What each kind of forge is called. */
export const FORGE_KIND_WORDS: Readonly<Record<ForgeKind, string>> = { github: "GitHub", forgejo: "Forgejo", gitea: "Gitea", gitlab: "GitLab" };

/** What each problem is called, before its since-time. */
export const FORGE_PROBLEM_WORDS: Readonly<Record<ForgeProblemKind, string>> = {
  "needs-credential": "Awaiting a credential",
  "credential-rejected": "Credential rejected",
  "credential-unavailable": "Credential unavailable",
  "identity-changed": "Answering as someone else",
  unreachable: "Unreachable",
  expiring: "Token expiring",
};

/** A forge account's status with the time it last changed, where the client is: `Connected since 09:14`, `Credential rejected since 12 Oct 09:14`. */
export const forgeStatusWords = (account: Pick<ForgeAccountRecord, "problem" | "statusSince">, now: Date): string =>
  `${account.problem === null ? "Connected" : FORGE_PROBLEM_WORDS[account.problem.kind]} since ${whenWords(account.statusSince, now)}`;

/** Who the credential answers as: its login and the forge's user id, or that the forge has not answered yet. */
export const forgeIdentityWords = (identity: ForgeIdentity | null): string => (identity === null ? "Not known until the forge answers." : `${identity.login} (user ${identity.userId})`);

/** Where the credential comes from, never the secret: the environment's `gh`, a stored token and where it came from, a key-manager reference, or none. */
export const credentialWords = (source: ForgeCredentialSource): string => {
  switch (source.kind) {
    case "gh":
      return `This environment's gh, as ${source.login}: it follows gh's rotations.`;
    case "reference":
      return `A reference in ${KEY_MANAGER_PROVIDER_WORDS[source.reference.provider]}, read on every use.`;
    case "none":
      return "None yet: a copy awaiting a credential on this environment.";
    case "stored":
      switch (source.provenance) {
        case "client-gh":
          return `The gh token ${source.handedOverBy.label} handed over once: it will not follow gh's rotations.`;
        case "pasted":
          return "A pasted token, kept in this environment's vault.";
        case "imported":
          return "A token the state import carried over, kept in this environment's vault.";
        case "oauth":
          return "A token from signing in on the forge, kept in this environment's vault.";
      }
  }
};

/** What each capability is called in a list (setup-copy.md §5.6). */
const CAPABILITY_WORDS: Readonly<Record<ForgeCapabilityName, string>> = {
  readRepository: "read code",
  writeIssues: "write issues",
  pullRequests: "open pull requests",
  createRepository: "create repositories",
  readReleases: "read releases",
};

/** What a forge account can do: the capabilities verified, those refused with their HTTP status, and those not tried yet, a sentence each. */
export const capabilitiesWords = (capabilities: ForgeCapabilities): string => {
  const names = (state: "verified" | "failed" | "unknown") => FORGE_CAPABILITIES.filter((name) => capabilities[name].state === state);
  const refused = names("failed").map((name) => {
    const { status } = capabilities[name];
    return status === null ? CAPABILITY_WORDS[name] : `${CAPABILITY_WORDS[name]} (HTTP ${String(status)})`;
  });
  const parts = [
    names("verified").length > 0 && `Can ${listWords(names("verified").map((name) => CAPABILITY_WORDS[name]))}.`,
    refused.length > 0 && `Refused: ${listWords(refused)}.`,
    names("unknown").length > 0 && `Not tried yet: ${listWords(names("unknown").map((name) => CAPABILITY_WORDS[name]))}.`,
  ];
  return parts.filter((part) => part !== false).join(" ");
};

/** A capability as a list of them names it on its own: `Read code`. */
export const capabilityName = (name: ForgeCapabilityName): string => `${CAPABILITY_WORDS[name].charAt(0).toUpperCase()}${CAPABILITY_WORDS[name].slice(1)}`;

/** Where a capability stands, in words (setup-copy.md §5.6): it works, the forge does not allow it, or it is not checked yet; an HTTP status stays out. */
export const capabilityStateWords = ({ state }: Pick<ForgeCapability, "state">): string => {
  switch (state) {
    case "verified":
      return "Works";
    case "failed":
      return "Not allowed";
    case "unknown":
      return "Not checked yet";
  }
};

/** A forge account's row as a state word names it (setup-copy.md §3): needing a fix while it has a problem the row draws, checking until its code is read, else done. */
export const forgeRowState = (account: Pick<ForgeAccountRecord, "problem" | "capabilities">): "done" | "needs-attention" | "pending" => {
  if (forgeRowProblem(account) !== null) return "needs-attention";
  return account.capabilities.readRepository.state === "unknown" ? "pending" : "done";
};

/** Where an alias stands (ADR 0020): when the credential last answered there as the forge account's identity, or that it is not used until it does. */
export const forgeAliasWords = (alias: ForgeAlias, account: Pick<ForgeAccountRecord, "identity">, now: Date): string =>
  alias.verifiedAt === null
    ? `not verified yet, so not used until it answers as ${account.identity?.login ?? "the forge account's login"}`
    : `last verified ${whenWords(alias.verifiedAt, now)}`;

/**
 * The problem the Forges step's row draws: any but `expiring`, since the
 * card's expiry warning is milestone 2's (ADR 0033); the step's own line,
 * from its `forges.expiry` check, still says it. Null for none.
 */
export const forgeRowProblem = (account: Pick<ForgeAccountRecord, "problem">): ForgeProblem | null => (account.problem?.kind === "expiring" ? null : account.problem);

/**
 * What fixes the problem a forge account's row draws (forge spec, "The
 * Forges step": `forges.identity` offers Check again on an unreachable
 * forge and Sign in again on the rest): `check-again` verifies it now;
 * `key-manager` is the Key manager step, for a reference whose key manager
 * cannot be read, since a new token there would replace the reference;
 * `sign-in-again` a new token in its place. Null where the row draws none.
 */
export type ForgeProblemAction = "check-again" | "key-manager" | "sign-in-again";

export const forgeProblemAction = (account: Pick<ForgeAccountRecord, "problem" | "credential">): ForgeProblemAction | null => {
  const problem = forgeRowProblem(account);
  if (problem === null) return null;
  if (problem.kind === "unreachable") return "check-again";
  return problem.kind === "credential-unavailable" && account.credential.kind === "reference" ? "key-manager" : "sign-in-again";
};

/** The host the gh routes offer first: GitHub's own. */
const GITHUB_HOST = "github.com";

/**
 * What the environment's own `gh` (`forge.gh.probe`; ADR 0032) offers the
 * Forges card first (setup-copy.md §5.6): Use gh with the login it is signed
 * in as, github.com's active one first; else Install gh where it is missing,
 * Update gh where it is older than the minimum, or that it is signed in to
 * no site, the command that signs it in in details. `computer` is where gh
 * runs, as the line names it.
 */
export type GhRoute =
  | { readonly kind: "use"; readonly host: string; readonly login: string; readonly line: string }
  | { readonly kind: "install" | "update" | "signed-out"; readonly line: string; readonly details: readonly string[] };

export const ghRoute = (probe: GhProbe, computer: string): GhRoute => {
  if (!probe.installed) return { kind: "install", line: "The gh tool is not installed. Install it to use your GitHub sign-in.", details: [`Needs gh ${probe.minimum} or later.`] };
  if (!probe.meetsMinimum) return { kind: "update", line: "The gh tool is out of date.", details: [`${probe.version === null ? "gh reports no version" : `gh ${probe.version}`} (needs ${probe.minimum} or later)`] };
  const github = probe.accounts.filter((account) => account.host === GITHUB_HOST);
  const chosen = github.find((account) => account.active) ?? github[0] ?? probe.accounts.find((account) => account.active) ?? probe.accounts[0];
  if (chosen === undefined) {
    return { kind: "signed-out", line: `The gh tool is not signed in to ${GITHUB_HOST}. Run gh auth login on ${computer}, or add a token instead.`, details: [`gh auth login --hostname ${GITHUB_HOST}`] };
  }
  return { kind: "use", host: chosen.host, login: chosen.login, line: `Use your GitHub sign-in from the gh tool (${chosen.login})` };
};

/** The login the environment's own `gh` reads a token for on `host`, as `gh` names a host: the host's active account, else its first; null where it is signed in to none there. */
export const machineGhLogin = (probe: GhProbe, host: string): string | null => {
  const there = probe.accounts.filter((account) => account.host === host);
  return (there.find((account) => account.active) ?? there[0])?.login ?? null;
};

/** Whether the forge account is the primary forge, which new repositories go to. */
export const primaryWords = (primary: boolean): string => (primary ? "Yes: repositories go here unless another forge is named." : "No.");

/** The environment a forge account was copied from, when it was not added here. */
export const forgeOriginWords = (account: Pick<ForgeAccountRecord, "copiedFrom">): string | null => account.copiedFrom?.environmentName ?? null;

/** What a forge account is called: its login on its origin's host, the host alone while it has no identity. */
export const forgeAccountName = (account: Pick<ForgeAccountRecord, "origin" | "identity">): string => {
  const host = forgeOriginHost(account.origin);
  return account.identity === null ? host : `${account.identity.login} on ${host}`;
};

/** What GitHub's fine-grained token page calls each access. */
const ACCESS_WORDS: Readonly<Record<ForgeTokenPermission["access"], string>> = { read: "Read-only", write: "Read and write" };

/** What Forgejo's and Gitea's token page calls an access a scope grants. */
const SCOPE_ACCESS_WORDS: Readonly<Record<string, string>> = { read: "Read", write: "Read and write" };

/**
 * The permissions to give a token on its page, in the words that page shows
 * (setup-copy.md §5.6, `Give it these permissions: {plain list}.`): a
 * fine-grained GitHub token's repositories and each permission's access, a
 * classic one's scopes as it lists them, and Forgejo's or Gitea's areas,
 * each with its access.
 */
export const tokenPermissionWords = (page: ForgeTokenPage): string => {
  switch (page.kind) {
    case "fine-grained":
      return `All repositories, with ${listWords(page.permissions.map((permission) => `${permission.name}: ${ACCESS_WORDS[permission.access]}`))}`;
    case "classic":
      return listWords(page.scopes);
    case "access-token":
      return listWords(
        page.scopes.map((scope) => {
          const [access = "", area = scope] = scope.split(":");
          return `${area.charAt(0).toUpperCase()}${area.slice(1)}: ${SCOPE_ACCESS_WORDS[access] ?? access}`;
        }),
      );
  }
};

/** The site a forge refusal names: an origin's host, with its port. */
const siteOf = (origin: string): string => origin.replace(/^https?:\/\//, "");

/** The login an identity in a refusal's data names, if any. */
const loginIn = (identity: unknown): string | undefined => {
  const login = (identity as { readonly login?: unknown } | null | undefined)?.login;
  return typeof login === "string" ? login : undefined;
};

/** The forge's own refusals in setup-copy.md §5.6's words, naming `site`; undefined for one the shared mapper words. */
const forgeRefusalLine = ({ code, data }: RefusedAnswer, site: string): string | undefined => {
  switch (code) {
    case "kind_unsupported":
      return "GitLab is not supported yet.";
    case "not_a_forge":
      return `${PRODUCT_NAME} does not recognise this site. Choose what it runs.`;
    case "unreachable":
      // This client's own `unreachable` is a lost connection to the computer, which the shared mapper words.
      return data === undefined ? undefined : `${PRODUCT_NAME} could not reach ${site}. Check the address and the internet connection.`;
    case "conflict":
      return data?.["reason"] === "origin_held" ? `${site} is already connected.` : undefined;
    case "verification_failed":
      return `${site} did not accept this token. Check that you copied all of it, or create a new one.`;
    case "gh-unavailable":
      return `The gh tool is not signed in to ${site}.`;
    case "gh-failed":
      return `The gh tool did not give a token for ${site}.`;
    case "identity_mismatch": {
      const found = loginIn(data?.["found"]);
      const expected = loginIn(data?.["expected"]);
      return found === undefined || expected === undefined ? undefined : `This token belongs to ${found}, not ${expected}. Add a token for ${expected}.`;
    }
    case "alias_identity_mismatch": {
      const expected = loginIn(data?.["expected"]);
      if (expected === undefined) return undefined;
      return `${data?.["found"] === null ? `${site} did not accept the token for ${expected}` : `${site} knows this token as another user`}, so it is not another address for this site. Nothing was changed.`;
    }
    default:
      return undefined;
  }
};

/**
 * A forge command's refusal in plain words (setup-copy.md §5.6, "Add
 * messages"; §3, raw refusals): the forge's own refusals worded from their
 * code and data, naming `site` (the host a person typed, or the forge
 * account's); every other through `plainRefusal` for the button `verb`.
 * Details hold the raw refusal, then the raw facts the environment gave.
 */
export const forgeRefusal = (refusal: RefusedAnswer, site: string, verb: string): PlainRefusal => {
  const plain = plainRefusal(refusal, verb);
  return { line: forgeRefusalLine(refusal, site) ?? plain.line, details: plain.details };
};

/** The site a typed address names, as a line names it: its origin's host, or what was typed where it names no forge. */
export const typedSite = (typed: string): string => {
  const origin = normaliseRemote(typed.trim())?.origin;
  return origin === undefined ? typed.trim() : siteOf(origin);
};

/** What a copy of a forge account came to on one environment, named as this client names it: copied and where it stands there, or refused and why. */
export const forgeCopyLine = (report: CopyReport<ForgeAccountRecord | null>, environmentName: string): string => {
  if (report.status === "refused") return `${environmentName}: not copied: ${report.error.message}`;
  const problem = report.result?.problem ?? null;
  return problem === null ? `${environmentName}: copied.` : `${environmentName}: copied: ${problem.message}`;
};

/** What each pull-request state is called. */
export const PULL_REQUEST_STATE_WORDS: Readonly<Record<PullRequestState, string>> = { open: "open", merged: "merged", closed: "closed" };

/** A pull request's number, read off its web URL's last part (the URL a session keeps is the pull request's own page); null for a URL that ends in none. */
export const pullRequestNumber = (url: string): string | null => /\/(\d+)\/?(?:[?#].*)?$/.exec(url)?.[1] ?? null;

/** A pull request as a person names it: `Pull request #12, open`. */
export const pullRequestWords = (pullRequest: PullRequest): string => {
  const number = pullRequestNumber(pullRequest.url);
  return `Pull request${number === null ? "" : ` #${number}`}, ${PULL_REQUEST_STATE_WORDS[pullRequest.state]}`;
};

/**
 * The pull request a session's row shows the state of: the latest linked
 * (`pullRequests` keeps them in the order they were first linked); null
 * for a session with none.
 */
export const shownPullRequest = (pullRequests: readonly PullRequest[]): PullRequest | null => pullRequests.at(-1) ?? null;
