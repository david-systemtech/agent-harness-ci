import { BANK_VALIDATOR, type BankFinding, type BankVerdict } from "./banks.js";

/**
 * A bank's working tree as the validator reads it, and its verdict as a
 * bank's author reads it: what `validate.mjs` in each bank's CI and the
 * CLI's `bank validate` share (banks spec, "Bank CI"; #1023, #1044), so the
 * two read the same files and print the same lines. The file system is the
 * caller's (Node's `fs`), so the validator's entry imports none.
 */

/** A folder's entry as Node's `fs.readdirSync(path, { withFileTypes: true })` gives it. */
export interface BankFolderEntry {
  readonly name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** What reading a bank's working tree needs of a file system: Node's `fs` answers it. Each throws an error with a `code` (ENOENT, EACCES, ELOOP) when it cannot answer. */
export interface BankFolderSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string, options: { withFileTypes: true }): readonly BankFolderEntry[];
  realpathSync(path: string): string;
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
}

/** What the validator is handed of a bank's working tree. */
export interface BankFolderReading {
  /** `BANK.md` and the Markdown under `projects/`, by path from the bank's root, `/`-separated. */
  readonly files: Record<string, string>;
  /** The files and folders there that could not be read, each with its error's code, which the verdict refuses. */
  readonly unreadable: Record<string, string>;
}

/** An error's code (ENOENT, EACCES), or the error itself where it has none. */
const codeOf = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : String(error));

/**
 * What the validator reads of the bank whose working tree is at `root` (an
 * absolute path): `BANK.md` and the Markdown under `projects/`, and the
 * files and folders there that could not be read. A link is followed to what
 * it points at, as a reader of the checkout follows it; a link that resolves
 * to nothing, whatever its name, and a link back to a folder it is in are
 * refused, not passed over.
 */
export const readBankFolder = (root: string, fs: BankFolderSystem): BankFolderReading => {
  const files: Record<string, string> = {};
  const unreadable: Record<string, string> = {};
  /** What `path` points at, or the error's code where it points at nothing (ENOENT) or round a loop (ELOOP). */
  const statOf = (path: string): { isDirectory(): boolean; isFile(): boolean } | string => {
    try {
      return fs.statSync(path);
    } catch (error) {
      return codeOf(error);
    }
  };
  const read = (path: string, name: string): void => {
    try {
      files[name] = fs.readFileSync(path, "utf8");
    } catch (error) {
      const code = codeOf(error);
      // No BANK.md: the verdict refuses it as missing.
      if (name !== "BANK.md" || code !== "ENOENT") unreadable[name] = code;
    }
  };
  /** Reads what the folder at `path` (`name` from the root) holds; `ancestors` are the real paths of the folders it is in, so a link back to one is not followed round. */
  const walk = (path: string, name: string, ancestors: readonly string[]): void => {
    let real: string;
    let entries: readonly BankFolderEntry[];
    try {
      real = fs.realpathSync(path);
      entries = fs.readdirSync(path, { withFileTypes: true });
    } catch (error) {
      // No projects/ folder: nothing to read. A folder that cannot be listed is refused, not passed over.
      const code = codeOf(error);
      if (code !== "ENOENT") unreadable[`${name}/`] = code;
      return;
    }
    if (ancestors.includes(real)) {
      unreadable[`${name}/`] = "ELOOP";
      return;
    }
    for (const entry of entries) {
      const entryPath = `${path}/${entry.name}`;
      const entryName = `${name}/${entry.name}`;
      const kind = entry.isSymbolicLink() ? statOf(entryPath) : entry;
      if (typeof kind === "string") unreadable[entryName] = kind;
      else if (kind.isDirectory()) walk(entryPath, entryName, [...ancestors, real]);
      else if (kind.isFile() && entry.name.endsWith(".md")) read(entryPath, entryName);
    }
  };
  read(`${root}/BANK.md`, "BANK.md");
  walk(`${root}/projects`, "projects", []);
  return { files, unreadable };
};

/** A finding as a bank's author reads it: refused or warning, the rule's id, and its sentence. */
export const bankFindingLine = (finding: BankFinding): string => `${finding.severity === "refusal" ? "refused" : "warning"} ${finding.rule}: ${finding.message}\n`;

/** A verdict as `validate.mjs` prints it: each finding's line, then the validator's stamp with the verdict and the counts. */
export const bankVerdictText = (verdict: BankVerdict): string => {
  const refused = verdict.findings.filter((finding) => finding.severity === "refusal").length;
  const warned = verdict.findings.length - refused;
  const counts = `${verdict.valid ? "valid" : `${refused} refused`}${warned === 0 ? "" : `, ${warned} warning${warned === 1 ? "" : "s"}`}`;
  return `${verdict.findings.map(bankFindingLine).join("")}${BANK_VALIDATOR.name} ${BANK_VALIDATOR.version}: ${counts}\n`;
};
