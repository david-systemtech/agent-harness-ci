import type { AccountCatalogue, AccountRecord, AmbientProbe, ModelEntry } from "@agent-harness/contracts";
import type { UsageGauge } from "../projections/accounts.js";
import { ACCOUNT_STATUS_WORDS, effortName, modelName, readingWords } from "../status/words.js";
import { daysBetween, weekdayWords } from "../sidebar/when.js";
import { clockTime, whenWords } from "../transcript/format.js";

/**
 * What the Accounts rows say, as both renderers say it (docs/specs/gui.md,
 * "Settings"; claude-adapter spec, "The account store"; ADR 0018; #414): an
 * account's directory and plan reading, the offer of the machine's own
 * Claude Code sign-in, what removing an account does to its directory, the
 * choices of the Account step's defaults, and a pooled gauge's parts. Pure.
 */

/** An account's folder, for its Details (setup-copy.md §5.1): where it is, and whose it is. */
export const directoryWords = (account: Pick<AccountRecord, "directory">): string =>
  `Folder: ${account.directory.path} (${account.directory.kind === "adopted" ? "Claude Code's own, used in place" : "made by agent-harness"})`;

/** An account's state as its row says it (setup-copy.md §5.1); an unreadable read's error is for Details. */
const ACCOUNT_STATE_WORDS: Readonly<Record<AccountRecord["status"]["state"], string>> = {
  "signed-in": "Signed in",
  "signed-out": "Signed out",
  expired: "Sign-in ran out",
  unreadable: "Cannot read the sign-in",
  unavailable: "Temporarily unavailable — checking again",
};

/** An account's state in a word or two, as its row says it. */
export const accountStatusWords = (status: Pick<AccountRecord["status"], "state">): string => ACCOUNT_STATE_WORDS[status.state];

/** An account's plan reading in one line: its gauge's windows, else why it has none, else that none was read yet. */
export const planWords = (gauge: UsageGauge | undefined): string => readingWords(gauge) ?? "no reading yet";

/** What the Account step says of the computer's own Claude Code sign-in: the choice to use it, or that it is signed out. */
export type AmbientSignIn = { readonly kind: "offer"; readonly choice: string } | { readonly kind: "signed-out"; readonly line: string };

/**
 * The computer's own Claude Code sign-in, as `accounts.probe` read it
 * (setup-copy.md §5.1), while no account holds it: the choice to use it while
 * it is signed in, named by its email (never its folder); the line saying it
 * is signed out, so Sign in with Claude is the way; undefined while it is not
 * there or not read. `computer` is "this computer" or the computer's name.
 */
export const ambientSignIn = (probe: AmbientProbe | null | undefined, computer: string): AmbientSignIn | undefined => {
  if (!probe || probe.directory === null || !probe.present || probe.accountId !== null) return undefined;
  if (!probe.signedIn) return { kind: "signed-out", line: `Claude Code is on ${computer} but not signed in. Sign in below instead.` };
  const email = probe.identity?.email;
  return { kind: "offer", choice: `Use the Claude Code sign-in on ${computer}${email === undefined ? "" : ` (${email})`}` };
};

/** What removing an account leaves, as the confirmation says it, with no folder path (ADR 0018: Claude Code's own folder is never touched). */
export const removalWords = (account: Pick<AccountRecord, "directory">, computer: string): string =>
  account.directory.kind === "adopted" ? `Claude Code stays signed in on ${computer}.` : `Its sign-in and history stay on ${computer} unless you delete them too.`;

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
  "accounts.defaultAccount": { unset: "Your first account", missing: () => "The account you chose was removed. New sessions use your first account." },
  "accounts.defaultModelFamily": { unset: "The account's strongest model", missing: (family: string) => `${family} (not offered: runs take the strongest model)` },
  "accounts.defaultEffort": { unset: "The model's own", missing: (effort: string) => `${effortName(effort)} (not offered: runs take the model's own)` },
} as const;

/** Who a gauge pools, as it is headed: the identity's email, or an account never read, which is a gauge of its own. */
export const gaugeWho = (gauge: Pick<UsageGauge, "identity">): string => gauge.identity?.email ?? "An account never read";

/** An account a gauge pools: its label on its environment. */
export const pooledWords = (label: string, environment: string): string => `${label} on ${environment}`;

/**
 * When a window rolls over, on this client's calendar from `now` (#1955): the
 * clock time today, `tomorrow` and the time on the next day, the weekday and
 * time within the week, else the date and time; undefined when the provider
 * does not say.
 */
export const resetWords = (resetsAt: string | null, now: Date): string | undefined => {
  if (resetsAt === null) return undefined;
  const at = new Date(resetsAt);
  const days = daysBetween(now, at);
  if (days === 1) return `resets tomorrow ${clockTime(resetsAt)}`;
  if (days > 1 && days < 7) return `resets ${weekdayWords(at)} ${clockTime(resetsAt)}`;
  return `resets ${whenWords(resetsAt, now)}`;
};

/** A gauge with no window, whose reading gives no reason. */
export const NO_WINDOWS_READ = "No plan windows read yet.";

/** Usage with no gauge at all. */
export const NO_PLAN_READING = "No account has a plan reading yet.";
