import type { SetupAction, SetupTarget, StateCheckId } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { StateChecker } from "../setup/check.js";
import type { BankRecord, BankRecords } from "./records.js";

/**
 * The Memory bank step's state checks (setup spec, "6. Memory bank" and
 * "Skipped"; banks spec, "The Memory bank step and the orientation block";
 * ADR 0019, ADR 0031; #586), answered from the banks the environment
 * registers. `memory-bank.present` is the step's skip check: with no
 * registered bank the step answers skipped and asks nothing else. The other
 * five await a verification of every bank, which they share (the seam joins
 * one running, `records.ts`), and answer from the status it recorded, for
 * the enabled banks alone: a bank runs do not use cannot hold a run up. A
 * failing line names each bank, by its name, and the bank is the target of
 * the check's action.
 */

/** The Memory bank step's state checks, by id. */
type MemoryBankStateCheckId = Extract<StateCheckId, `memory-bank.${string}`>;

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** A line ending in a full stop once: a reason the record gives is put in a sentence as it is, its own full stop kept. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** One bank's failure of a check: its line, and the bank as its action's target when the check has an action. */
interface Finding {
  readonly line: string;
  readonly bank: BankRecord;
}

/** A check over the enabled banks: each finding's line and the bank its action applies to; it holds with none. */
const perEnabledBank =
  (action: SetupAction | null, find: (bank: BankRecord) => string | null) =>
  (banks: readonly BankRecord[]): StateCheckAnswer => {
    const findings = banks.filter((bank) => bank.enabled).flatMap((bank): Finding[] => {
      const line = find(bank);
      return line === null ? [] : [{ line, bank }];
    });
    if (findings.length === 0) return true;
    const reason = findings.map((finding) => finding.line).join(" ");
    if (action === null) return { reason };
    return { reason, targets: findings.map(({ bank }): SetupTarget => ({ action, kind: "bank", id: bank.id, label: bank.name })) };
  };

/** Its remote answers, or a local-only bank's repository is there (`check-again`). */
const reachable = perEnabledBank("check-again", ({ name, status }) =>
  status.reachable.state === "reachable" ? null : `${name} cannot be reached: ${sentence(status.reachable.reason)} Check again once it answers.`,
);

/** Its `BANK.md` on main passes the validator, or an open pull request holds it on a reviewed bank (ADR 0019); else the rule it fails (`revise`). */
const manifestOnMain = perEnabledBank("revise", ({ name, status }) => {
  switch (status.manifest.state) {
    case "valid":
    case "awaiting-review":
      return null;
    case "missing":
      return `${name} has no BANK.md on main: Revise to write one.`;
    case "invalid":
      return `The BANK.md of ${name} on main fails the validator's rule ${status.manifest.rule}: ${sentence(status.manifest.message)} Revise it.`;
  }
});

/**
 * The manifest check, which holds for a `BANK.md` awaiting review but says
 * which pull request holds it (#1698): the review is what the person does
 * next. A landing awaiting review in that same pull request leaves it to
 * `memory-bank.landing`'s line, which names it already.
 */
const manifest = (banks: readonly BankRecord[]): StateCheckAnswer => {
  const answer = manifestOnMain(banks);
  if (answer !== true) return answer;
  const reviews = banks.filter((bank) => bank.enabled).flatMap(({ name, status: { manifest: held, landing } }) =>
    held.state === "awaiting-review" && !(landing.state === "awaiting-review" && landing.pullRequest === held.pullRequest)
      ? [`The BANK.md of ${name} waits for your review: ${held.pullRequest}.`]
      : [],
  );
  return reviews.length === 0 ? true : { holds: true, reason: reviews.join(" ") };
};

/** Every orientation name it lists names a memory in it. */
const orientation = perEnabledBank(null, ({ name, status: { orientation: { missing } } }) =>
  missing.length === 0 ? null : `The orientation of ${name} names ${listed(missing)}, which ${missing.length === 1 ? "is" : "are"} no memory in the bank.`,
);

/** A team bank's owners resolve on its forge. */
const owners = perEnabledBank(null, ({ name, kind, status: { owners: { unresolved } } }) => {
  if (kind !== "team" || unresolved.length === 0) return null;
  return unresolved.length === 1
    ? `The owner ${unresolved[0]} of the team bank ${name} does not resolve on its forge.`
    : `The owners ${listed(unresolved)} of the team bank ${name} do not resolve on its forge.`;
});

/** A description awaiting its owner's review has landed (ADR 0019); only a failed landing offers `check-again`. */
const landing = (banks: readonly BankRecord[]): StateCheckAnswer => {
  const answer = perEnabledBank("check-again", ({ name, status: { landing } }) =>
    landing.state === "failed" ? `The last landing on ${name} failed at its ${landing.step} step: ${sentence(landing.reason)} Check again once a landing passes.` : null,
  )(banks);
  if (answer !== true) return answer;
  const reviews = banks.filter((bank) => bank.enabled).flatMap(({ name, status: { landing } }) =>
    landing.state === "awaiting-review" ? [`${name} is landed and awaiting your review: ${landing.pullRequest}.`] : [],
  );
  return reviews.length === 0 ? true : { holds: true, reason: reviews.join(" ") };
};

export const memoryBankStateChecks = (banks: BankRecords): { readonly [Id in MemoryBankStateCheckId]: StateChecker } => ({
  "memory-bank.present": () => banks.list().length > 0 || { reason: "No memory bank is registered on this environment." },
  "memory-bank.reachable": async () => reachable(await banks.verify()),
  "memory-bank.manifest": async () => manifest(await banks.verify()),
  "memory-bank.orientation": async () => orientation(await banks.verify()),
  "memory-bank.owners": async () => owners(await banks.verify()),
  "memory-bank.landing": async () => landing(await banks.verify()),
});
