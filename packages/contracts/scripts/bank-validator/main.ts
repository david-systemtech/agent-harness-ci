import * as fs from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { bankVerdictText, readBankFolder, validateBank } from "../../src/bank-validator.js";
import { BANK_VALIDATOR } from "../../src/banks.js";

/**
 * `validate.mjs`, the bank validator as the one Node file a bank vendors at
 * `.agent-harness/validate.mjs` (banks spec, "Bank CI"): `node
 * .agent-harness/validate.mjs [bank]` validates the bank at `bank` (the
 * working directory by default) with the contracts' own functions, prints
 * each finding with its rule id and message, and exits 1 when one refuses.
 * `--json` prints the verdict as the functions give it; `--version` prints
 * the validator and the version of its rules. It reads the bank and prints
 * the verdict as the CLI's `bank validate` does (`readBankFolder`,
 * `bankVerdictText`).
 */

const USAGE = "Usage: node validate.mjs [bank directory] [--json] [--version]";

const main = (): number => {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { json: { type: "boolean" }, version: { type: "boolean" } } });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${BANK_VALIDATOR.name} ${BANK_VALIDATOR.version}\n`);
    return 0;
  }
  if (positionals.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const verdict = validateBank(readBankFolder(resolve(positionals[0] ?? "."), fs));
  process.stdout.write(values.json ? `${JSON.stringify(verdict)}\n` : bankVerdictText(verdict));
  return verdict.valid ? 0 : 1;
};

process.exitCode = main();
