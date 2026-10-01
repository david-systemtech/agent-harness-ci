/**
 * What Set up's Memory bank step needs of the memory bank vocabulary (banks
 * spec, "BANK.md and the folders" and "The validator"; ADR 0010, ADR 0013,
 * ADR 0035, ADR 0037; #586), ahead of the banks build (#90), which grows
 * this module: a bank's two kinds, the orientation caps the validator
 * enforces, and the validator's name and version, which the describe
 * prompt is written for and carries.
 */

/** A bank's kind, from its `BANK.md`: one person's own, or a team's, which names its owners (ADR 0035, ADR 0037). */
export const BANK_KINDS = ["personal", "team"] as const;
export type BankKind = (typeof BANK_KINDS)[number];

/**
 * The orientation caps (ADR 0013), which the validator enforces when a
 * bank's orientation is written: at most five memory names, each memory at
 * most 600 bytes, and 1,500 bytes in all.
 */
export const ORIENTATION_CAPS = { names: 5, bytesEach: 600, bytesInAll: 1_500 } as const;

/**
 * The bank validator (ADR 0013: one validator, at draft, promote, the
 * bank's CI and the BankService), by name and the version of its rules. A
 * prompt is written for one version: the describe prompt carries it, and
 * the version moves with the rules.
 */
export const BANK_VALIDATOR = { name: "bank-validator", version: 1 } as const;
