import type { BankKind, BankStatus } from "@agent-harness/contracts";
import type { BankService } from "./bank-service.js";

/**
 * The memory banks as Set up's Memory bank step reads them (setup spec, "6.
 * Memory bank"; banks spec, "The registry" and "The Memory bank step and the
 * orientation block"; #586, #1025): each registered bank's record, what its
 * `BANK.md` names, and its status as the BankService's last verification
 * recorded it (`banks.verify`, which records what it finds as
 * `system:banks`). With no bank registered the step answers skipped.
 */

/** One registered bank, as the Memory bank step reads it. */
export interface BankRecord {
  readonly id: string;
  /** Its name, from `BANK.md`: what a person reads it by. */
  readonly name: string;
  /** personal or team, from `BANK.md`; null while it names none. */
  readonly kind: BankKind | null;
  /** Whether runs use it; a disabled bank is out of every check but `memory-bank.present`. */
  readonly enabled: boolean;
  /** Its checkout on this machine, which a describe session's worktree is made from. */
  readonly checkout: string;
  /** Local-only describe commits land through the environment rather than a remote push. */
  readonly localOnly?: boolean;
  /** The host of its forge, as a line names it; null for a bank kept on this machine only. */
  readonly host: string | null;
  /** The name of the environment its record was copied from, when it was copied. */
  readonly copiedFrom: string | null;
  /** The entities its `BANK.md` names, each with its aliases. */
  readonly entities: readonly { readonly name: string; readonly aliases: readonly string[] }[];
  /** Its scope folders holding memories, `projects/{org}/{project}/` with an area or not. */
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

/** The BankService's registry and verification as the Memory bank step reads them. */
export const bankRecords = (service: BankService): BankRecords => {
  const list = (): BankRecord[] =>
    service.entries().map(({ entry, index }) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      enabled: entry.enabled,
      checkout: entry.checkout,
      localOnly: entry.location.kind === "local",
      host: entry.location.kind === "remote" ? new URL(entry.location.origin).host : null,
      copiedFrom: entry.copiedFrom?.environmentName ?? null,
      entities: index?.entities.map(({ name, aliases }) => ({ name, aliases })) ?? [],
      scopes: index?.orgs.flatMap((org) => org.folders.map((folder) => `projects/${folder.path}`)) ?? [],
      status: entry.status,
    }));
  return {
    list,
    async verify() {
      await service.verify();
      return list();
    },
  };
};
