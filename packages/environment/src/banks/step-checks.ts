import type { BankRuleId, SetupAction, SetupTarget, StateCheckId } from "@agent-harness/contracts";
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
 * the check's action. The lines are setup-copy.md §5.8's (#1854): one plain
 * line per bank and problem, the raw facts (the forge's words, a path, a
 * rule's id, a pull request's address) in details, each by its bank's name.
 */

/** The Memory bank step's state checks, by id. */
type MemoryBankStateCheckId = Extract<StateCheckId, `memory-bank.${string}`>;

/** One bank's failure of a check: its line, the raw facts behind it, and the bank as its action's target when the check has an action. */
interface Finding {
  readonly line: string;
  readonly details: readonly string[];
  readonly bank: BankRecord;
}

/** What a check finds of one bank: a line and its raw facts, or null where the bank passes. */
type Found = { readonly line: string; readonly details?: readonly string[] } | null;

/** A check over the enabled banks: each finding's line, its details, and the bank its action applies to; it holds with none. */
const perEnabledBank =
  (action: SetupAction | null, find: (bank: BankRecord) => Found) =>
  (banks: readonly BankRecord[]): StateCheckAnswer => {
    const findings = banks.filter((bank) => bank.enabled).flatMap((bank): Finding[] => {
      const found = find(bank);
      return found === null ? [] : [{ line: found.line, details: found.details ?? [], bank }];
    });
    if (findings.length === 0) return true;
    const reason = findings.map((finding) => finding.line).join(" ");
    const details = findings.flatMap((finding) => finding.details);
    const facts = { reason, ...(details.length > 0 && { details }) };
    if (action === null) return facts;
    return { ...facts, targets: findings.map(({ bank }): SetupTarget => ({ action, kind: "bank", id: bank.id, label: bank.name })) };
  };

/** Lines a check holds with, each naming a pull request awaiting the person's approval, whose addresses go in details. */
const holdingWith = (lines: readonly { readonly line: string; readonly pullRequest: string }[]): StateCheckAnswer =>
  lines.length === 0 ? true : { holds: true, reason: lines.map(({ line }) => line).join(" "), details: lines.map(({ pullRequest }) => pullRequest) };

/** The unreachable bank's one cause in a line: its folder, its forge account (here, or on the computer it was copied from), its repository, else a plain could-not-reach. */
const unreachableLine = ({ name, host, copiedFrom, status: { reachable } }: BankRecord): string => {
  const cause = reachable.state === "unreachable" ? reachable.cause : undefined;
  if (cause === "folder-missing") return `${name}'s folder on this computer is missing.`;
  if (cause === "no-forge-account" && host !== null) {
    return copiedFrom === null ? `${name} needs a forge account for ${host} on this computer.` : `Your ${host} account is connected on ${copiedFrom}, not here. Connect it here too.`;
  }
  if (cause === "repository-missing" && host !== null) return `The repository for ${name} is missing on ${host}.`;
  return `agent-harness cannot reach ${name}. Choose Check again.`;
};

/** Its remote answers, or a local-only bank's repository is there (`check-again`). */
const reachable = perEnabledBank("check-again", (bank) =>
  bank.status.reachable.state === "reachable" ? null : { line: unreachableLine(bank), details: [`${bank.name}: ${bank.status.reachable.reason}`] },
);

/** Each validator rule a `BANK.md` can fail, in words: what follows "has a problem:" (the rule's id and message are the details). */
const PLAIN_RULES: { readonly [Rule in BankRuleId]: string } = {
  unreadable: "agent-harness cannot read one of its files",
  manifest_missing: "it is missing",
  manifest_malformed: "its settings at the top cannot be read",
  manifest_fact_missing: "it leaves out something every notebook needs",
  manifest_fact_invalid: "one of its entries is not in the right form",
  retired_key: "it uses keys from an older layout",
  unknown_scope_label: "it names a kind of folder agent-harness does not know",
  orientation_over_cap: "its summary names more than five notes",
  orientation_missing: "its summary names a note that does not exist",
  orientation_too_large: "the notes its summary names are too long",
  scope_file_missing: "a folder has no file saying what it holds",
  scope_file_malformed: "a folder's settings cannot be read",
  scope_line: "a folder's one-line summary is missing or too long",
  scope_topics: "a folder's list of topics is missing or not in the right form",
  unknown_scope: "a file is in a folder where notes do not go",
  undeclared_topic: "a note is in a topic its folder does not list",
  repository_identity: "it names a repository in the wrong form",
  index_over_cap: "a folder or topic lists too many notes",
  root_over_cap: "it lists too many projects at the top",
  memory_malformed: "a note's settings cannot be read",
  memory_name: "a note's name is missing or does not match its file",
  memory_name_taken: "two notes have the same name",
  memory_type: "a note's kind is missing or not one agent-harness knows",
  description_length: "a note's description is missing, too short or too long",
  description_is_name: "a note's description only repeats its name",
  description_duplicate: "two notes in one place have the same description",
  body_too_long: "a note is too long",
  secret_shaped: "it holds something that looks like a password",
  description_trigger: "a note's description does not say when to read it",
  unresolved_link: "a note links to a note that does not exist",
};

/** A rule's words; a rule this build does not know (a newer validator's) reads as any rule broken. */
const plainRule = (rule: string): string => (Object.hasOwn(PLAIN_RULES, rule) ? PLAIN_RULES[rule as BankRuleId] : "it does not follow the notebook's rules");

/** Its `BANK.md` on main passes the validator, or an open pull request holds it on a reviewed bank (ADR 0019); else what is wrong in words (`revise`). */
const manifestOnMain = perEnabledBank("revise", ({ name, status: { manifest } }): Found => {
  switch (manifest.state) {
    case "valid":
    case "awaiting-review":
      return null;
    case "missing":
      return { line: `${name} needs a description.` };
    case "invalid":
      return { line: `${name}'s description has a problem: ${plainRule(manifest.rule)}.`, details: [`${name}: ${manifest.rule}: ${manifest.message}`] };
  }
});

/** The host a pull request is on, as a line names it. */
const hostOf = (pullRequest: string): string => {
  try {
    return new URL(pullRequest).host;
  } catch {
    return pullRequest;
  }
};

/**
 * The manifest check, which holds for a `BANK.md` awaiting review but says
 * it waits for the person's approval (#1698): the review is what the person
 * does next. A landing awaiting review in that same pull request is this
 * line too, so `memory-bank.landing` leaves it out.
 */
const manifest = (banks: readonly BankRecord[]): StateCheckAnswer => {
  const answer = manifestOnMain(banks);
  if (answer !== true) return answer;
  return holdingWith(
    banks.filter((bank) => bank.enabled).flatMap(({ name, status: { manifest: held } }) =>
      held.state === "awaiting-review" ? [{ line: `${name}'s description is waiting for your approval on ${hostOf(held.pullRequest)}.`, pullRequest: held.pullRequest }] : [],
    ),
  );
};

/** Every orientation name it lists names a memory in it: the summary's notes, the missing names in details. */
const orientation = perEnabledBank(null, ({ name, status: { orientation: { missing } } }) =>
  missing.length === 0 ? null : { line: `${name}'s summary names notes that do not exist.`, details: [`${name}: ${missing.join(", ")}`] },
);

/** A team bank's owners resolve on its forge: one line per owner it does not know. */
const owners = perEnabledBank(null, ({ name, kind, host, status: { owners: { unresolved } } }) => {
  if (kind !== "team" || host === null || unresolved.length === 0) return null;
  return { line: unresolved.map((login) => `${host} does not know ${login}, listed as an owner of ${name}.`).join(" ") };
});

/** A description awaiting its owner's review has landed (ADR 0019); only a failed landing offers `check-again`. */
const landing = (banks: readonly BankRecord[]): StateCheckAnswer => {
  const answer = perEnabledBank("check-again", ({ name, host, status: { landing } }) =>
    landing.state === "failed"
      ? { line: host === null ? `The last change to ${name} could not be saved.` : `The last change to ${name} could not be saved to ${host}.`, details: [`${name}: ${landing.step}: ${landing.reason}`] }
      : null,
  )(banks);
  if (answer !== true) return answer;
  return holdingWith(
    banks.filter((bank) => bank.enabled).flatMap(({ name, status: { manifest: held, landing } }) =>
      landing.state === "awaiting-review" && !(held.state === "awaiting-review" && held.pullRequest === landing.pullRequest)
        ? [{ line: `${name}'s latest changes are waiting for your approval on ${hostOf(landing.pullRequest)}.`, pullRequest: landing.pullRequest }]
        : [],
    ),
  );
};

export const memoryBankStateChecks = (banks: BankRecords): { readonly [Id in MemoryBankStateCheckId]: StateChecker } => ({
  "memory-bank.present": () => banks.list().length > 0 || { reason: "No notebook yet. Optional." },
  "memory-bank.reachable": async () => reachable(await banks.verify()),
  "memory-bank.manifest": async () => manifest(await banks.verify()),
  "memory-bank.orientation": async () => orientation(await banks.verify()),
  "memory-bank.owners": async () => owners(await banks.verify()),
  "memory-bank.landing": async () => landing(await banks.verify()),
});
