import type { JsonObject } from "../event-log/event-log.js";
import type { AccountFacts } from "../runs/run-decider.js";

/**
 * The account Carry over reads (ADR 0021, ADR 0018): one the environment
 * holds whose directory it adopted in place. Its sessions half (#578) and
 * its skills half (#513) refuse alike: an account the environment does not
 * hold is `not_found` (kind `account`), and one whose directory the
 * environment owns holds nothing to carry, `conflict` (reason
 * `not_adopted`).
 */

/** Why an account cannot be carried over: the environment does not hold it, or its directory is not adopted. */
export interface CarryOverRefusal {
  readonly code: "not_found" | "conflict";
  readonly message: string;
  readonly data: JsonObject;
}

/** An adopted account, with the directory it adopted. */
export type AdoptedAccount = AccountFacts & { readonly directory: string };

/** The adopted account `accountId` names, as `account` holds it, or why it cannot be carried over. */
export const adoptedAccount = (account: (id: string) => AccountFacts | null, accountId: string): AdoptedAccount | CarryOverRefusal => {
  const facts = account(accountId);
  if (facts === null) return { code: "not_found", message: `No account ${accountId} is on this environment.`, data: { kind: "account", accountId } };
  if (!facts.adopted || facts.directory === null) {
    const message = `The account ${accountId} has a directory of the environment's own, which holds nothing to carry over; only an adopted directory does.`;
    return { code: "conflict", message, data: { reason: "not_adopted", accountId } };
  }
  return { ...facts, directory: facts.directory };
};

/** Whether `found` is a refusal rather than an account. */
export const isCarryOverRefusal = (found: AdoptedAccount | CarryOverRefusal): found is CarryOverRefusal => "code" in found;
