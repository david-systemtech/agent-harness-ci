import type { AccountCatalogue, AccountRecord, AmbientProbe, ModelEntry } from "@agent-harness/contracts";
import type { UsageGauge } from "../projections/accounts.js";
import { ACCOUNT_STATUS_WORDS, effortName, modelName, readingWords } from "../status/words.js";
import { clockTime } from "../transcript/format.js";

/**
 * What the Accounts rows say, as both renderers say it (docs/specs/gui.md,
 * "Settings"; claude-adapter spec, "The account store"; ADR 0018; #414): an
 * account's directory and plan reading, the offer of the machine's own
 * Claude Code sign-in, what removing an account does to its directory, the
 * choices of the Account step's defaults, and a pooled gauge's parts. Pure.
 */

/** Whose an account's directory is, after where it is: the machine's own adopted in place, or one the environment made. */
export const directoryWords = (account: Pick<AccountRecord, "directory">): string =>
  `${account.directory.path}, ${account.directory.kind === "adopted" ? "adopted in place" : "the environment's own"}`;

/** An account's status in words, with why when the read said (an unreadable read's error). */
export const accountStatusWords = (status: Pick<AccountRecord["status"], "state" | "detail">): string =>
  status.detail === null ? ACCOUNT_STATUS_WORDS[status.state] : `${ACCOUNT_STATUS_WORDS[status.state]}: ${status.detail}`;

/** An account's plan reading in one line: its gauge's windows, else why it has none, else that none was read yet. */
export const planWords = (gauge: UsageGauge | undefined): string => readingWords(gauge) ?? "no reading yet";

/**
 * The offer of the machine's own Claude Code directory, as `accounts.probe`
 * read it (the Set up specification, "Account"): made while it is there,
 * signed in and adopted by no account, naming who it signs in as (its path
 * when the login has no email); undefined otherwise, since `accounts.adopt`
 * refuses it then.
 */
export const ambientOffer = (probe: AmbientProbe | null | undefined, environment: string): string | undefined => {
  if (!probe || probe.directory === null || !probe.present || !probe.signedIn || probe.accountId !== null) return undefined;
  return `Use the Claude Code sign-in on ${environment}'s machine (${probe.identity?.email ?? probe.directory})`;
};

/** What removing an account does to its directory, as the confirmation says it (ADR 0018: an adopted directory is never touched). */
export const removalWords = (account: Pick<AccountRecord, "directory">): string =>
  account.directory.kind === "adopted"
    ? `Its directory, ${account.directory.path}, is the machine's own Claude Code directory, adopted in place: removing the account leaves it as it is.`
    : `Its directory, ${account.directory.path}, stays unless you delete it too, with its sign-in and history.`;

/** An account as the default account's picker lists it: its label, with its status when it is not signed in. */
export const accountChoiceWords = (account: Pick<AccountRecord, "label" | "status">): string =>
  account.status.state === "signed-in" ? account.label : `${account.label} (${ACCOUNT_STATUS_WORDS[account.status.state]})`;

/** A family runs can default to, with the strongest model of it the accounts offer, which a run then takes. */
export interface FamilyChoice {
  readonly family: string;
  readonly model: ModelEntry;
}

/**
 * The families `accounts.defaultModelFamily` can name: every family the
 * accounts' catalogues offer, strongest first by tier, each with its
 * strongest model.
 */
export const familyChoices = (catalogues: readonly AccountCatalogue[]): readonly FamilyChoice[] => {
  const strongest = new Map<string, ModelEntry>();
  for (const model of catalogues.flatMap((catalogue) => catalogue.models)) {
    const held = strongest.get(model.family);
    if (held === undefined || model.tier > held.tier) strongest.set(model.family, model);
  }
  return [...strongest].map(([family, model]) => ({ family, model })).sort((a, b) => b.model.tier - a.model.tier);
};

/** A family as its picker lists it: its name and the model a run takes of it. */
export const familyWords = (choice: FamilyChoice): string => `${choice.family}: ${modelName(choice.model)}`;

/**
 * The efforts `accounts.defaultEffort` can name: those of the model a run
 * with no model of its own takes, the family's strongest, or the strongest
 * of all while no family offered is set.
 */
export const effortChoices = (catalogues: readonly AccountCatalogue[], family: string | null): readonly string[] => {
  const families = familyChoices(catalogues);
  return (families.find((choice) => choice.family === family) ?? families[0])?.model.efforts ?? [];
};

/** What each default's picker says of it unset (null), and of a value set that it no longer offers, with what runs take instead. */
export const DEFAULT_CHOICE_WORDS = {
  "accounts.defaultAccount": { unset: "The first account adopted or added", missing: (id: string) => `${id} (no longer held: runs take the first account)` },
  "accounts.defaultModelFamily": { unset: "The account's strongest model", missing: (family: string) => `${family} (not offered: runs take the strongest model)` },
  "accounts.defaultEffort": { unset: "The model's own", missing: (effort: string) => `${effortName(effort)} (not offered: runs take the model's own)` },
} as const;

/** Who a gauge pools, as it is headed: the identity's email, or an account never read, which is a gauge of its own. */
export const gaugeWho = (gauge: Pick<UsageGauge, "identity">): string => gauge.identity?.email ?? "An account never read";

/** An account a gauge pools: its label on its environment. */
export const pooledWords = (label: string, environment: string): string => `${label} on ${environment}`;

/** When a window rolls over, on this client's clock; undefined when the provider does not say. */
export const resetWords = (resetsAt: string | null): string | undefined => (resetsAt === null ? undefined : `resets ${clockTime(resetsAt)}`);

/** A gauge with no window, whose reading gives no reason. */
export const NO_WINDOWS_READ = "No plan windows read yet.";

/** Usage with no gauge at all. */
export const NO_PLAN_READING = "No account has a plan reading yet.";
