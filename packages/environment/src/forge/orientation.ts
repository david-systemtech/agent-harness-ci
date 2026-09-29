import { GITHUB_ORIGIN, type ForgeAccountRecord, type ForgeKind, type ForgeProblemKind } from "@agent-harness/contracts";
import type { OrientationSection } from "../instructions/orientation.js";
import { readableMinute } from "./verification.js";

/**
 * The orientation block's forges section (forge spec, "Orientation";
 * key-managers spec, "The orientation block"; ADR 0012, ADR 0020; #318):
 * what every run is told of the forges connected here, so a session never
 * hunts for a credential.
 *
 * Every line renders from the forge accounts' read model, never from a
 * clock: a status is stated with the time it last changed
 * (`statusSince`), in UTC to the minute, never when it was last verified,
 * so a verification that finds nothing new leaves the text byte-identical.
 * Nothing in the text is a secret: the records hold none.
 */

/** The section's name, as the orientation seam's answer names it when it could not be read. */
export const FORGES_SECTION = "forges";

const KIND_NAMES: Readonly<Record<ForgeKind, string>> = { github: "GitHub", forgejo: "Forgejo", gitea: "Gitea", gitlab: "GitLab" };

const PROBLEM_WORDS: Readonly<Record<ForgeProblemKind, string>> = {
  "needs-credential": "needs a credential",
  "credential-rejected": "credential rejected",
  "credential-unavailable": "credential unavailable",
  "identity-changed": "identity changed",
  unreachable: "unreachable",
  expiring: "token expiring",
};

/** A forge as a person names it: GitHub for github.com, else its host and port with its kind. */
const forgeName = (account: Pick<ForgeAccountRecord, "origin" | "kind">): string =>
  account.origin === GITHUB_ORIGIN ? KIND_NAMES.github : `${account.origin.replace(/^https?:\/\//, "")} (${KIND_NAMES[account.kind]})`;

/** `text` ending as a sentence does. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Its status and since when it has held: verified, or its problem with the problem's own line. */
const statusOf = (account: ForgeAccountRecord): string => {
  const since = readableMinute(account.statusSince);
  if (account.problem === null) return `verified, unchanged since ${since}.`;
  return `${PROBLEM_WORDS[account.problem.kind]} since ${since}. ${sentence(account.problem.message)}`;
};

/** One forge account's line: its slug, the forge and its kind, its login and its status. */
const accountLine = (account: ForgeAccountRecord): string =>
  `- ${account.slug}: ${forgeName(account)}, ${account.identity === null ? "login not known yet" : `login ${account.identity.login}`}: ${statusOf(account)}`;

/** The section's lines for the forge accounts the environment holds, in the order they were added. */
export const renderForges = (accounts: readonly ForgeAccountRecord[]): string => accounts.map(accountLine).join("\n");

/** The forges section's provider, over the forge accounts as the read model holds them now. */
export const forgesSection = (accounts: () => readonly ForgeAccountRecord[]): OrientationSection => ({
  name: FORGES_SECTION,
  title: "Forges",
  render: () => renderForges(accounts()),
});
