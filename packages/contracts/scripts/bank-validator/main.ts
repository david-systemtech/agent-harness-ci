import { readdirSync, readFileSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
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

/** An error's code (ENOENT, EACCES), or the error itself where it has none. */
const codeOf = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : String(error));

/** What `path` points at, or the error's code where it points at nothing (ENOENT) or round a loop (ELOOP). */
const statOf = (path: string): Stats | string => {
  try {
    return statSync(path);
  } catch (error) {
    return codeOf(error);
  }
};

/**
 * What the validator reads, by path from the bank's root: `BANK.md` and the
 * Markdown under `projects/`, and the files and folders there that could
 * not be read, each with its error's code, which the verdict refuses. A
 * link is followed to what it points at, as a reader of the checkout
 * follows it.
 */
const readBank = (root: string): { readonly files: Record<string, string>; readonly unreadable: Record<string, string> } => {
  const files: Record<string, string> = {};
  const unreadable: Record<string, string> = {};
  const nameOf = (path: string): string => relative(root, path).split(sep).join("/");
  const read = (path: string): void => {
    const name = nameOf(path);
    try {
      files[name] = readFileSync(path, "utf8");
    } catch (error) {
      const code = codeOf(error);
      // No BANK.md: the verdict refuses it as missing.
      if (name !== "BANK.md" || code !== "ENOENT") unreadable[name] = code;
    }
  };
  /** Reads what `directory` holds; `ancestors` are the real paths of the folders it is in, so a link back to one is not followed round. */
  const walk = (directory: string, ancestors: readonly string[]): void => {
    let real: string;
    let entries: Dirent[];
    try {
      real = realpathSync(directory);
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      // No projects/ folder: nothing to read. A folder that cannot be listed is refused, not passed over.
      const code = codeOf(error);
      if (code !== "ENOENT") unreadable[`${nameOf(directory)}/`] = code;
      return;
    }
    if (ancestors.includes(real)) {
      unreadable[`${nameOf(directory)}/`] = "ELOOP";
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      // What a link points at: a link that resolves to nothing, whatever its name, is refused, not passed over.
      const kind = entry.isSymbolicLink() ? statOf(path) : entry;
      if (typeof kind === "string") unreadable[nameOf(path)] = kind;
      else if (kind.isDirectory()) walk(path, [...ancestors, real]);
      else if (kind.isFile() && entry.name.endsWith(".md")) read(path);
    }
  };
  read(join(root, "BANK.md"));
  walk(join(root, "projects"), []);
  return { files, unreadable };
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
  const verdict = validateBank(readBank(resolve(positionals[0] ?? ".")));
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
