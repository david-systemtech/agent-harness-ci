import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { validateBank } from "../../src/bank-validator.js";
import { BANK_VALIDATOR } from "../../src/banks.js";

/**
 * `validate.mjs`, the bank validator as the one Node file a bank vendors at
 * `.agent-harness/validate.mjs` (banks spec, "Bank CI"): `node
 * .agent-harness/validate.mjs [bank]` validates the bank at `bank` (the
 * working directory by default) with the contracts' own functions, prints
 * each finding with its rule id and message, and exits 1 when one refuses.
 * `--json` prints the verdict as the functions give it; `--version` prints
 * the validator and the version of its rules.
 */

const USAGE = "Usage: node validate.mjs [bank directory] [--json] [--version]";

/** The files the validator reads, by path from the bank's root: `BANK.md` and the Markdown under `projects/`. */
const bankFiles = (root: string): Record<string, string> => {
  const files: Record<string, string> = {};
  try {
    files["BANK.md"] = readFileSync(join(root, "BANK.md"), "utf8");
  } catch {
    // No BANK.md: the verdict refuses it.
  }
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files[relative(root, path).split(sep).join("/")] = readFileSync(path, "utf8");
    }
  };
  walk(join(root, "projects"));
  return files;
};

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
  const verdict = validateBank({ files: bankFiles(resolve(positionals[0] ?? ".")) });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
  } else {
    for (const finding of verdict.findings) {
      process.stdout.write(`${finding.severity === "refusal" ? "refused" : "warning"} ${finding.rule}: ${finding.message}\n`);
    }
    const refused = verdict.findings.filter((finding) => finding.severity === "refusal").length;
    const warned = verdict.findings.length - refused;
    process.stdout.write(`${BANK_VALIDATOR.name} ${BANK_VALIDATOR.version}: ${verdict.valid ? "valid" : `${refused} refused`}${warned === 0 ? "" : `, ${warned} warning${warned === 1 ? "" : "s"}`}\n`);
  }
  return verdict.valid ? 0 : 1;
};

process.exitCode = main();
