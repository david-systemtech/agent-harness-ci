import type { BankKind } from "@agent-harness/contracts";

/**
 * The memory banks as Set up's Memory bank step reads them (setup spec, "6.
 * Memory bank"; banks spec, "The registry" and "The Memory bank step and the
 * orientation block"; #586): each registered bank's record, what its
 * `BANK.md` names, and its status as the BankService's last verification
 * recorded it. This is the seam the banks build fills (#90) with its
 * BankRegistry and its verification (`banks.verify`, which records what it
 * finds as `system:banks`; #937); until it does, the environment registers
 * no bank, and the step answers skipped.
 */

/** A bank's status as its last verification recorded it: what the step's checks answer from. */
export interface BankStatus {
  /** Whether its remote answered, or a local-only bank's repository is there; why not, when not. */
  readonly reachable: { readonly state: "reachable" } | { readonly state: "unreachable"; readonly reason: string };
  /**
   * Its `BANK.md` on main: passing the validator; held by an open pull
   * request on a bank whose merges are reviewed, which counts as landed and
   * awaiting review (ADR 0019); not there; or failing the validator, with
   * the rule's id and message.
   */
  readonly manifest:
    | { readonly state: "valid" }
    | { readonly state: "awaiting-review"; readonly pullRequest: string }
    | { readonly state: "missing" }
    | { readonly state: "invalid"; readonly rule: string; readonly message: string };
  /** The orientation names its `BANK.md` lists that name no memory in the bank. */
  readonly missingOrientation: readonly string[];
  /** A team bank's owners that do not resolve on its forge; none on a personal bank. */
  readonly unresolvedOwners: readonly string[];
  /** Its last landing, when it failed: the Lander's step it failed at and why; null otherwise. */
  readonly landingFailed: { readonly step: string; readonly reason: string } | null;
}

/** One registered bank, as the Memory bank step reads it. */
export interface BankRecord {
  readonly id: string;
  /** Its name, from `BANK.md`: what a person reads it by. */
  readonly name: string;
  readonly kind: BankKind;
  /** Whether runs use it; a disabled bank is out of every check but `memory-bank.present`. */
  readonly enabled: boolean;
  /** Its checkout on this machine, which a describe session's worktree is made from. */
  readonly checkout: string;
  /** The entities its `BANK.md` names, each with its aliases. */
  readonly entities: readonly { readonly name: string; readonly aliases: readonly string[] }[];
  /** Its scope folders, `projects/{org}/{project}/` with an area or not. */
  readonly scopes: readonly string[];
  readonly status: BankStatus;
}

/** The banks this environment registers. */
export interface BankRecords {
  /** The banks registered now, each with the status last recorded. */
  list(): readonly BankRecord[];
  /** Verifies every enabled bank, joining a verification running, recording what it finds; answers the records after. */
  verify(): Promise<readonly BankRecord[]>;
}

/** No bank: what the environment registers until the banks build's registry does (#937). */
export const NO_BANKS: BankRecords = { list: () => [], verify: async () => [] };
