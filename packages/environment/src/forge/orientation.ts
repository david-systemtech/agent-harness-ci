import { GITHUB_ORIGIN, forgeApiBase, type ForgeAccountRecord, type ForgeCapabilityName, type ForgeKind, type ForgeProblemKind } from "@agent-harness/contracts";
import type { OrientationSection } from "../instructions/orientation.js";
import { isInjected } from "./forge-store.js";
import { servedOrigins } from "./git-helper.js";
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

/** The writes a forge account may be able to make, as the section words them, in the order it names them: only use teaches them. */
const WRITES: readonly (readonly [ForgeCapabilityName, string])[] = [
  ["writeIssues", "writing issues"],
  ["pullRequests", "writing pull requests"],
  ["createRepository", "creating repositories"],
];

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

/** `A`, `A and B`, `A, B and C`. */
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** Which forge is primary, the rest also connected, and where repositories go. */
const primaryParagraph = (accounts: readonly ForgeAccountRecord[]): string => {
  const primary = accounts.find((account) => account.primary);
  const others = accounts.filter((account) => account !== primary).map(forgeName);
  const verb = others.length === 1 ? "is" : "are";
  if (primary === undefined) return `No forge is primary here; ${listed(others)} ${verb} connected. Ask the user which forge a new repository goes to.`;
  const alsoConnected = others.length === 0 ? "" : `; ${listed(others)} ${verb} also connected`;
  return `Your primary forge is ${forgeName(primary)}${alsoConnected}. Repositories go to the primary forge unless the user names another.`;
};

/** Each injected forge account's variables, by slug, with its forge's API base; none for a forge account runs are not given. */
const variablesList = (accounts: readonly ForgeAccountRecord[]): string | null => {
  const lines = accounts.flatMap(({ slug, kind, origin, variables }) => {
    const names = [...variables.url, ...variables.token, ...variables.kind];
    return names.length === 0 ? [] : [`- ${slug}: ${listed(names)}; API base ${forgeApiBase(kind, origin)}.`];
  });
  if (lines.length === 0) return null;
  return ["Variables each run is given, by slug (the origin in *_URL, the token in *_TOKEN, the kind in *_KIND), with each forge's API base:", ...lines].join("\n");
};

/** The writes a forge account has been refused, with the status, then those it has not made yet; null when every one is verified. */
const writesLine = ({ slug, capabilities }: ForgeAccountRecord): string | null => {
  const failed = WRITES.filter(([name]) => capabilities[name].state === "failed").map(([name, words]) => {
    const { status } = capabilities[name];
    return status === null ? `${words} failed` : `${words} failed (HTTP ${status})`;
  });
  const unknown = WRITES.filter(([name]) => capabilities[name].state === "unknown").map(([, words]) => words);
  const parts = [...failed, ...(unknown.length === 0 ? [] : [`${listed(unknown)} not known yet`])];
  return parts.length === 0 ? null : `- ${slug}: ${parts.join("; ")}.`;
};

/** Each injected forge account's writes not known to work; none for a forge account runs are not given. */
const writesList = (accounts: readonly ForgeAccountRecord[]): string | null => {
  const lines = accounts.filter(isInjected).flatMap((account) => writesLine(account) ?? []);
  return lines.length === 0 ? null : ["Writes not known to work, by slug:", ...lines].join("\n");
};

/** Why a forge account is left out of runs, or its token may be: the problems that keep it out, and a credential that could not be read. */
const LEFT_OUT: Partial<Readonly<Record<ForgeProblemKind, string>>> = {
  "needs-credential": "no credential on this environment yet, so runs get no variables or git credential for it",
  "identity-changed": "its credential now answers as another user, so runs get no variables or git credential for it",
  "credential-unavailable": "its credential could not be read when last checked, so runs may get no token or git credential for it",
};

/** Each forge account left out of runs, or whose token may be, with the reason. */
const leftOutList = (accounts: readonly ForgeAccountRecord[]): string | null => {
  const lines = accounts.flatMap(({ slug, problem }) => {
    const reason = problem === null ? undefined : LEFT_OUT[problem.kind];
    return reason === undefined ? [] : [`- ${slug}: ${reason}.`];
  });
  return lines.length === 0 ? null : ["Left out of runs, by slug:", ...lines].join("\n");
};

/** The standing lines: git over https to the origins git's helper is given just works, ssh is the user's own, and no other origin has a credential. */
const standingLines = (accounts: readonly ForgeAccountRecord[]): string => {
  const origins = accounts.filter(isInjected).flatMap(servedOrigins);
  if (origins.length === 0) return "Git over https has no credential here; ssh uses the user's own keys.";
  return `Git over https to these origins just works, the harness's credential helper answering for it: ${listed(origins)}. ssh uses the user's own keys. Other origins have no credential here.`;
};

/** With no forge account: none is connected, and where to connect one. */
const NONE_CONNECTED =
  "No forge is connected here: git over https has no credential here, and ssh uses the user's own keys. Ask the user to connect a forge in Set up, Forges rather than searching for a token.";

/** The section's lines for the forge accounts the environment holds, in the order they were added. */
export const renderForges = (accounts: readonly ForgeAccountRecord[]): string => {
  if (accounts.length === 0) return NONE_CONNECTED;
  const paragraphs = [
    accounts.map(accountLine).join("\n"),
    primaryParagraph(accounts),
    variablesList(accounts),
    writesList(accounts),
    leftOutList(accounts),
    standingLines(accounts),
  ];
  return paragraphs.filter((paragraph) => paragraph !== null).join("\n\n");
};

/** The forges section's provider, over the forge accounts as the read model holds them now. */
export const forgesSection = (accounts: () => readonly ForgeAccountRecord[]): OrientationSection => ({
  name: FORGES_SECTION,
  title: "Forges",
  render: () => renderForges(accounts()),
});
