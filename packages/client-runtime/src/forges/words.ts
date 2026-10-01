import {
  FORGE_CAPABILITIES,
  forgeOriginHost,
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
  type GhProbe,
  type PullRequest,
  type PullRequestState,
} from "@agent-harness/contracts";
import type { CopyReport } from "../copies.js";
import { KEY_MANAGER_PROVIDER_WORDS, listWords } from "../key-managers/words.js";
import { whenWords } from "../transcript/format.js";

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

/** What each capability is called in a list. */
const CAPABILITY_WORDS: Readonly<Record<ForgeCapabilityName, string>> = {
  readRepository: "read repositories",
  writeIssues: "write issues",
  pullRequests: "pull requests",
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

/** A capability as a list of them names it on its own: `Read repositories`. */
export const capabilityName = (name: ForgeCapabilityName): string => `${CAPABILITY_WORDS[name].charAt(0).toUpperCase()}${CAPABILITY_WORDS[name].slice(1)}`;

/** Where a capability stands: verified, refused with the HTTP status a failure answered, or not tried yet. */
export const capabilityStateWords = ({ state, status }: Pick<ForgeCapability, "state" | "status">): string => {
  switch (state) {
    case "verified":
      return "verified";
    case "failed":
      return status === null ? "refused" : `refused (HTTP ${String(status)})`;
    case "unknown":
      return "not tried yet";
  }
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

/**
 * Why the environment's own `gh` (`forge.gh.probe`; ADR 0032) cannot give
 * a forge account its token: not installed, older than the minimum, or
 * signed in to no host; null when it can be offered.
 */
export const machineGhAbsence = (probe: GhProbe, environmentName: string): string | null => {
  if (!probe.installed) return `${environmentName} has no gh to read a token from.`;
  if (!probe.meetsMinimum) return `The gh on ${environmentName} is ${probe.version ?? "of a version it does not say"}, older than ${probe.minimum}, the oldest a forge account reads.`;
  if (probe.accounts.length === 0) return `The gh on ${environmentName} is signed in to no host: run gh auth login there, or paste a token.`;
  return null;
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

/** Where to mint a token and what to grant it, as `forge.detect` names a token page. */
export const tokenPageWords = (page: ForgeTokenPage): string => {
  switch (page.kind) {
    case "fine-grained":
      return `A fine-grained token with access to all repositories and ${listWords(page.permissions.map((permission) => `${permission.name} (${permission.access})`))}`;
    case "classic":
      return `A classic token with ${listWords(page.scopes)}`;
    case "access-token":
      return `An access token with ${listWords(page.scopes)}`;
  }
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
