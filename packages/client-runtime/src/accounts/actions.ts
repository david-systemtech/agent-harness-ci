import type { AccountCatalogue, AccountRecord } from "@agent-harness/contracts";
import type { Runtime } from "../runtime.js";
import { adminCall } from "../status/actions.js";
import { LABEL_RULE, labelProblem } from "../status/sign-in.js";
import { familyChoices } from "./words.js";

/**
 * What the Accounts pane sends, as both renderers send it and say it
 * (claude-adapter spec, "Wire methods" and "The account store"; ADR 0018;
 * #414): adopting the machine's own directory, relabelling and removing an
 * account, each an `admin` command sent as a direct request (`adminCall`),
 * never the outbox's, so one made while the environment cannot be reached
 * fails at once. Adding and signing in are the sign-in card's
 * (`status/sign-in.ts`). Each answers what it did, or why not, in one line.
 * The Account step's preset of the default model (#575) is here too.
 */

/** What a command did, in one line. */
export interface AccountOutcome {
  readonly ok: boolean;
  readonly line: string;
}

/**
 * Adopts the machine's own Claude Code directory in place (`accounts.adopt`),
 * labelled `label`, or with the email it signs in as when `label` is empty.
 */
export const adoptAccount = async (runtime: Pick<Runtime, "requests">, environmentId: string, label: string, commandId: string, environment: string): Promise<AccountOutcome> => {
  const typed = label.trim();
  if (typed !== "" && labelProblem(typed) !== undefined) return { ok: false, line: `Not adopted: ${LABEL_RULE}` };
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.adopt", { commandId, ...(typed !== "" && { label: typed }) }));
  if (!answer.ok) return { ok: false, line: `Not adopted: ${answer.line}` };
  return { ok: true, line: `Adopted ${answer.result?.account.label ?? "the Claude Code sign-in"} on ${environment}.` };
};

/** Relabels the account (`accounts.relabel`) with `label`, trimmed; a label that breaks the rule is said and not sent. */
export const relabelAccount = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  account: Pick<AccountRecord, "id" | "label">,
  label: string,
  commandId: string,
): Promise<AccountOutcome> => {
  const typed = label.trim();
  if (labelProblem(typed) !== undefined) return { ok: false, line: `Not relabelled: ${LABEL_RULE}` };
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.relabel", { commandId, accountId: account.id, label: typed }));
  if (!answer.ok) return { ok: false, line: `Not relabelled: ${answer.line}` };
  return { ok: true, line: `Relabelled ${account.label} to ${answer.result?.account.label ?? typed}.` };
};

/**
 * Removes the account (`accounts.remove`). Its directory stays unless
 * `deleteDirectory`, the explicit second choice, which only an owned one
 * takes (the environment refuses it on an adopted one).
 */
export const removeAccount = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  account: Pick<AccountRecord, "id" | "label" | "directory">,
  deleteDirectory: boolean,
  commandId: string,
  environment: string,
): Promise<AccountOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.remove", { commandId, accountId: account.id, ...(deleteDirectory && { deleteDirectory }) }));
  if (!answer.ok) return { ok: false, line: `Not removed: ${answer.line}` };
  const deleted = answer.result?.directoryDeleted ?? deleteDirectory;
  return {
    ok: true,
    line: deleted ? `Removed ${account.label} from ${environment} and deleted its sign-in and history.` : `Removed ${account.label} from ${environment}; its directory stays at ${account.directory.path}.`,
  };
};

/** The default model family and effort the Account step presets (ADR 0018). */
export interface ModelPreset {
  readonly family: string;
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
  return strongest === undefined ? undefined : { family: strongest.family, effort: "high" };
};

/**
 * Writes the preset (`settings.update`, both keys in one command) when the
 * default model family and effort are both unset as `settings.get` reads
 * them just before, so it never writes over a value set; undefined when one
 * was set and nothing was written. `label` is the account's whose catalogue
 * it came from.
 */
export const presetModelDefaults = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  preset: ModelPreset,
  label: string,
  commandId: string,
): Promise<AccountOutcome | undefined> => {
  const notPreset = (why: string): AccountOutcome => ({ ok: false, line: `The model family and effort were not preset: ${why}` });
  const read = await runtime.requests.call(environmentId, "settings.get", { keys: ["accounts.defaultModelFamily", "accounts.defaultEffort"] });
  if (!read.ok) return notPreset(read.error.message);
  const { values } = read.result;
  if ((values["accounts.defaultModelFamily"] ?? null) !== null || (values["accounts.defaultEffort"] ?? null) !== null) return undefined;
  const written = await adminCall(() =>
    runtime.requests.call(environmentId, "settings.update", { commandId, values: { "accounts.defaultModelFamily": preset.family, "accounts.defaultEffort": preset.effort } }),
  );
  if (!written.ok) return notPreset(written.line);
  return { ok: true, line: `Model family set to ${preset.family} at ${preset.effort} effort, the strongest ${label} offers.` };
};
