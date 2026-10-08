import { AccountLabel, type AccountCatalogue, type AccountRecord } from "@agent-harness/contracts";
import type { Runtime } from "../runtime.js";
import { adminCall } from "../status/actions.js";
import { modelDisplayName } from "../status/words.js";
import { plainRefusal, type PlainRefusal, type RefusedAnswer } from "../words/refusal.js";
import { familyChoices } from "./words.js";

/**
 * What the Accounts pane and the Account step send, as both renderers send
 * it and say it (claude-adapter spec, "Wire methods" and "The account store";
 * ADR 0018; #414; setup-copy.md §5.1, #1842): using the computer's own Claude
 * Code sign-in, renaming and removing an account, each an `admin` command
 * sent as a direct request (`adminCall`), never the outbox's, so one made
 * while the environment cannot be reached fails at once. Signing in is the
 * sign-in card's (`status/sign-in.ts`); the name a new account starts with,
 * and the email it takes once signed in, are here. Each answers what it did,
 * or why not, in one line, the raw words in Details. The Account step's
 * preset of the default model (#575) is here too.
 */

/** What a command did, in one line, with the raw words behind a refusal for Details. */
export interface AccountOutcome {
  readonly ok: boolean;
  readonly line: string;
  readonly details?: readonly string[];
}

/** The name a new account is added under until it signs in (setup-copy.md §5.1), numbered from 2 past the names taken. */
export const NEW_ACCOUNT_LABEL = "Claude account";

/** `Claude account`, or `Claude account 2` and on: the first no account has, ignoring case, as the environment compares labels. */
export const newAccountLabel = (accounts: readonly Pick<AccountRecord, "label">[]): string => {
  const taken = new Set(accounts.map((account) => account.label.toLowerCase()));
  let label = NEW_ACCOUNT_LABEL;
  for (let number = 2; taken.has(label.toLowerCase()); number++) label = `${NEW_ACCOUNT_LABEL} ${number}`;
  return label;
};

/** A name `newAccountLabel` gives, which no person typed. */
const GIVEN_NAME = new RegExp(`^${NEW_ACCOUNT_LABEL}( [2-9]| [1-9][0-9]+)?$`);

/**
 * The email an account added by Sign in with Claude is renamed to once it is
 * signed in (setup-copy.md §5.1): while it still has the name it was added
 * under, so a name the person gave it stays; undefined otherwise. Claude
 * Code's own sign-in takes its email as it is used, so it is never renamed.
 */
export const emailLabel = (account: Pick<AccountRecord, "label" | "directory" | "identity" | "status">): string | undefined =>
  account.directory.kind === "owned" && account.status.state === "signed-in" && GIVEN_NAME.test(account.label) ? account.identity?.email : undefined;

/** What to do about a name an account cannot have, trimmed as it is sent (setup-copy.md §5.1); undefined for one it can. */
export const nameProblem = (label: string): string | undefined => {
  const typed = label.trim();
  if (typed === "") return "Enter a name.";
  if (typed.length > 200) return "Use 200 characters or fewer.";
  return AccountLabel.safeParse(typed).success ? undefined : "Use one line.";
};

/** The account store's own refusals, which the environment words for a person (setup-copy.md §5.1): said as it says them. */
const STORE_REASONS: ReadonlySet<string> = new Set(["ambient_unavailable", "already_added", "label_taken"]);

/**
 * A refused account command in plain words, for the button `verb` names: the
 * account store's refusals in the environment's own words, its folder in
 * Details; anything else through the refusal mapper.
 */
const refusedWords = (refusal: RefusedAnswer, verb: string): PlainRefusal => {
  const { data } = refusal;
  const reason = data?.["reason"];
  if (refusal.code !== "conflict" || typeof reason !== "string" || !STORE_REASONS.has(reason)) return plainRefusal(refusal, verb);
  const directory = data?.["directory"];
  return { line: refusal.message, details: [`conflict (${reason}): ${refusal.message}`, ...(typeof directory === "string" ? [`Folder: ${directory}`] : [])] };
};

/** A refused command's outcome, for the button `verb` names. */
const refused = ({ refusal }: { readonly refusal: RefusedAnswer }, verb: string): AccountOutcome => ({ ok: false, ...refusedWords(refusal, verb) });

/**
 * Uses the computer's own Claude Code sign-in (`accounts.adopt`), named
 * `label`, or by the email it signs in as when `label` is empty.
 */
export const adoptAccount = async (runtime: Pick<Runtime, "requests">, environmentId: string, label: string, commandId: string): Promise<AccountOutcome> => {
  const typed = label.trim();
  const problem = typed === "" ? undefined : nameProblem(typed);
  if (problem !== undefined) return { ok: false, line: problem };
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.adopt", { commandId, ...(typed !== "" && { label: typed }) }));
  if (!answer.ok) return refused(answer, "Use this sign-in");
  return { ok: true, line: `${answer.result?.account.label ?? (typed === "" ? "The Claude Code sign-in" : typed)} is signed in.` };
};

/** Renames the account (`accounts.relabel`) to `label`, trimmed; a name it cannot have is said and not sent. */
export const relabelAccount = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  account: Pick<AccountRecord, "id" | "label">,
  label: string,
  commandId: string,
): Promise<AccountOutcome> => {
  const problem = nameProblem(label);
  if (problem !== undefined) return { ok: false, line: problem };
  const typed = label.trim();
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.relabel", { commandId, accountId: account.id, label: typed }));
  if (!answer.ok) return refused(answer, "Rename");
  return { ok: true, line: `Renamed ${account.label} to ${answer.result?.account.label ?? typed}.` };
};

/**
 * Removes the account (`accounts.remove`). Its folder stays unless
 * `deleteDirectory`, the explicit second choice, which only one agent-harness
 * made takes (the environment refuses it on Claude Code's own).
 */
export const removeAccount = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  account: Pick<AccountRecord, "id" | "label">,
  deleteDirectory: boolean,
  commandId: string,
): Promise<AccountOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.remove", { commandId, accountId: account.id, ...(deleteDirectory && { deleteDirectory }) }));
  if (!answer.ok) return refused(answer, "Remove");
  const deleted = answer.result?.directoryDeleted ?? deleteDirectory;
  return { ok: true, line: deleted ? `Removed ${account.label} and deleted its sign-in and history.` : `Removed ${account.label}.` };
};

/** The default model family and effort the Account step presets (ADR 0018). */
export interface ModelPreset {
  readonly family: string;
  /** The name of the family's strongest model, which new sessions then take. */
  readonly model: string;
  readonly effort: "high";
}

/**
 * What the Account step presets once an account is the first signed in
 * (ADR 0018; claude-adapter spec, "The defaults"): the family of the
 * strongest model `accountId`'s catalogue offers, by tier, at `high`;
 * undefined while its catalogue offers none (not read yet, or empty).
 */
export const modelPreset = (catalogues: readonly AccountCatalogue[], accountId: string): ModelPreset | undefined => {
  const strongest = familyChoices(catalogues.filter((catalogue) => catalogue.accountId === accountId))[0];
  return strongest === undefined ? undefined : { family: strongest.family, model: modelDisplayName(strongest.model.id, strongest.model.label), effort: "high" };
};

/**
 * Writes the preset (`settings.update`, both keys in one command) when the
 * default model family and effort are both unset as `settings.get` reads
 * them just before, so it never writes over a value set; undefined when one
 * was set and nothing was written. It says the model new sessions will use
 * (setup-copy.md §5.1), or, when it could not write, to choose one.
 */
export const presetModelDefaults = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  preset: ModelPreset,
  commandId: string,
): Promise<AccountOutcome | undefined> => {
  const notPreset = (refusal: RefusedAnswer): AccountOutcome => ({ ok: false, line: "Choose a model for new sessions in More options.", details: plainRefusal(refusal, "Choose").details });
  const read = await runtime.requests.call(environmentId, "settings.get", { keys: ["accounts.defaultModelFamily", "accounts.defaultEffort"] });
  if (!read.ok) return notPreset(read.error);
  const { values } = read.result;
  if ((values["accounts.defaultModelFamily"] ?? null) !== null || (values["accounts.defaultEffort"] ?? null) !== null) return undefined;
  const written = await adminCall(() =>
    runtime.requests.call(environmentId, "settings.update", { commandId, values: { "accounts.defaultModelFamily": preset.family, "accounts.defaultEffort": preset.effort } }),
  );
  if (!written.ok) return notPreset(written.refusal);
  return { ok: true, line: `New sessions will use ${preset.model} with ${preset.effort} effort. You can change this in Settings.` };
};
