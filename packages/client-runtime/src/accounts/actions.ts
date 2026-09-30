import type { AccountRecord } from "@agent-harness/contracts";
import type { Runtime } from "../runtime.js";
import { adminCall } from "../status/actions.js";
import { LABEL_RULE, labelProblem } from "../status/sign-in.js";

/**
 * What the Accounts pane sends, as both renderers send it and say it
 * (claude-adapter spec, "Wire methods" and "The account store"; ADR 0018;
 * #414): adopting the machine's own directory, relabelling and removing an
 * account, each an `admin` command sent as a direct request (`adminCall`),
 * never the outbox's, so one made while the environment cannot be reached
 * fails at once. Adding and signing in are the sign-in card's
 * (`status/sign-in.ts`). Each answers what it did, or why not, in one line.
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
