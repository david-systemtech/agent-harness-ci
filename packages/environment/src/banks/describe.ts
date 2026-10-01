import { stat } from "node:fs/promises";
import type { Clock } from "../serve/clock.js";
import type { LlmStep, StepSubject, StepWorkspace } from "../setup/mint.js";
import { runGit } from "../workspace/git.js";
import type { BankRecord, BankRecords } from "./records.js";
import { DescribeGitError, describeRepositoryAt, prepareDescribeRepository } from "./describe-repository.js";

/**
 * The Memory bank step's describe conversation, its LLM step (ADR 0019,
 * ADR 0035, ADR 0037; setup spec, "The LLM step and minted sessions";
 * banks spec, "The Memory bank step and the orientation block"; #586). Its
 * subjects are the enabled banks. A session `setup.mint` mints for one
 * works in a writable worktree of a separate copy of the bank on a new branch
 * `setup/describe-<date>` (the environment's day, in UTC), `-2`, `-3` and on
 * when that day's is taken, made from the checkout's main by the resolver.
 * The copy's git metadata is outside the attached checkout and writable,
 * so nothing touches the checkout, which runs see read-only, until the
 * change is reviewed and landed. A bank whose checkout is not there, and a
 * call naming no bank, are `conflict`, reason `bank_missing`. Its prompt
 * renders from the bank's name, kind, entities and scope folders.
 */

/** What every describe session's branch is named from, before its day. */
const BRANCH_PREFIX = "setup/describe-";

/** The most of a branch listing read. */
const LISTING_BYTES = 64 * 1024;

/** The bank as `setup.mint`'s subject and a result's target name it. */
const subjectOf = (bank: BankRecord): StepSubject => ({ kind: "bank", id: bank.id, label: bank.name });

const bankMissing = (message: string, data: Readonly<Record<string, string>> = {}): StepWorkspace => ({
  refused: { code: "conflict", message, data: { reason: "bank_missing", ...data } },
});

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The first of `setup/describe-<day>`, then `-2`, `-3` and on, that the
 * repository has no local branch of. Creating the ref reserves the name
 * atomically, before a concurrent mint can choose it for another worktree.
 */
const freeBranch = async (checkout: string, day: string): Promise<string> => {
  const base = `${BRANCH_PREFIX}${day}`;
  const listing = await runGit(checkout, ["for-each-ref", "--format=%(refname)", `refs/heads/${base}`, `refs/heads/${base}-*`], { maxBytes: LISTING_BYTES });
  const taken = new Set(listing.ok ? listing.stdout.toString("utf8").split("\n") : []);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (taken.has(`refs/heads/${name}`)) continue;
    const created = await runGit(checkout, ["branch", "--", name, "refs/heads/main"], { maxBytes: 1024 });
    if (created.ok && !created.truncated) return name;
    const exists = await runGit(checkout, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { maxBytes: 1024 });
    if (!exists.ok) throw new DescribeGitError("branch", created);
  }
};

export interface DescribeBankOptions {
  readonly banks: BankRecords;
  readonly dataDir: string;
  /** The environment's clock, whose day names a session's branch. */
  readonly clock: Clock;
}

export const describeBankStep = ({ banks, clock, dataDir }: DescribeBankOptions): LlmStep => {
  const bankOf = (subject: StepSubject | null): BankRecord | undefined => (subject === null ? undefined : banks.list().find((bank) => bank.id === subject.id));
  return {
    subjects: () => banks.list().filter((bank) => bank.enabled).map(subjectOf),
    workspace: async (subject) => {
      const bank = bankOf(subject);
      if (bank === undefined) {
        return subject === null
          ? bankMissing("The Memory bank step's session describes one bank: name it as the subject.")
          : bankMissing(`The bank ${subject.label} is no longer registered on this environment.`, { bankId: subject.id });
      }
      if (!(await isDirectory(bank.checkout))) {
        return bankMissing(`The bank ${bank.name} has no checkout at ${bank.checkout} on this environment.`, { bankId: bank.id, path: bank.checkout });
      }
      const day = clock.now().toISOString().slice(0, 10);
      try {
        const repository = await prepareDescribeRepository(dataDir, bank.checkout);
        return { kind: "worktree", repository, branch: await freeBranch(repository, day) };
      } catch (error) {
        const errno = error instanceof Error && "code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/.test(error.code) ? error.code : undefined;
        const diagnostic = error instanceof DescribeGitError
          ? { reason: "git_failed", operation: error.operation, diagnostic: error.diagnostic }
          : errno === undefined ? { reason: "describe_repository_failed", diagnostic: "unexpected" } : { reason: "filesystem_failed", errno };
        return { refused: { code: "conflict", message: `The bank ${bank.name}'s describe repository could not be prepared.`, data: { ...diagnostic, bankId: bank.id, repository: describeRepositoryAt(dataDir, bank.checkout) } } };
      }
    },
    facts: (subject) => {
      const bank = bankOf(subject);
      if (bank === undefined) throw new Error("The Memory bank step's prompt renders from a registered bank.");
      // A bank whose BANK.md names no kind yet is described as a personal one, which the session may revise.
      return { name: bank.name, kind: bank.kind ?? "personal", entities: bank.entities, scopes: bank.scopes };
    },
  };
};
