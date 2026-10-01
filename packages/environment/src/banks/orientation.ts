import type { BankEntry } from "@agent-harness/contracts";
import { utcMinute, type OrientationSection } from "../instructions/orientation.js";

/**
 * The orientation block's banks section (banks spec, "The Memory bank step
 * and the orientation block"; key-managers spec, "The orientation block";
 * #1025): each enabled bank in the run's scope, by the account and the
 * repository identity of its instruction scope, named with its kind, its
 * role and whether landing on it works, as a status with when it began
 * (`since`), in UTC to the minute, never a time the clock gives, so the
 * same registry gives the same bytes. A run with no bank in scope gets no
 * section.
 */

/** `held` names `one`, or every one; a run with no repository identity is in a scope of every repository alone. */
const inScope = (held: "all" | readonly string[], one: string | null): boolean => held === "all" || (one !== null && held.includes(one));

/** Whether landing on the bank works, since when. */
const landingOf = ({ status: { landing } }: BankEntry): string =>
  landing.state === "ok"
    ? `landing works, unchanged since ${utcMinute(landing.since)}.`
    : `landing failed at its ${landing.step} step since ${utcMinute(landing.since)}. ${/[.!?]$/.test(landing.reason) ? landing.reason : `${landing.reason}.`}`;

const bankLine = (bank: BankEntry): string => `${bank.name} (${bank.kind ?? "kind not named yet"}, ${bank.role}): ${landingOf(bank)}`;

/** The banks section's provider, over the registry as the read model holds it now. */
export const banksSection = (banks: () => readonly BankEntry[]): OrientationSection => ({
  name: "banks",
  title: "Memory banks",
  render: (scope) => [
    {
      heading: "The memory banks this run reads, each with its kind and role, and whether landing on it works:",
      items: banks()
        .filter((bank) => bank.enabled && inScope(bank.accounts, scope.accountId) && inScope(bank.repositories, scope.repositoryIdentity))
        .map(bankLine),
    },
  ],
});
