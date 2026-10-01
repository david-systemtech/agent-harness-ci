import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { bankValidatorStamp } from "../../src/banks.js";

/**
 * The bank validator's build (banks spec, "Bank CI"; #1023): the
 * contracts' own validator, with the YAML and schema libraries it reads,
 * bundled into one Node file a bank vendors and runs with nothing
 * installed, its first line the stamp of the rules it carries
 * (`// bank-validator 1`), which a bank's vendored copy is compared by.
 */

const PACKAGE_DIR = join(import.meta.dirname, "..", "..");

/** The file a bank vendors, `.agent-harness/validate.mjs` in it. */
export const BANK_VALIDATOR_FILE = "validate.mjs";

/** Where the package's build puts it. */
export const BANK_VALIDATOR_DIST = join(PACKAGE_DIR, "dist", "bank-validator", BANK_VALIDATOR_FILE);

/** Builds `validate.mjs` to `outFile`, replacing what was there. */
export const buildBankValidator = async ({ outFile }: { readonly outFile: string }): Promise<void> => {
  const scratch = mkdtempSync(join(tmpdir(), "agent-harness-bank-validator-"));
  try {
    await build({
      root: PACKAGE_DIR,
      configFile: false,
      logLevel: "warn",
      publicDir: false,
      resolve: { conditions: ["@agent-harness/source", "module", "node", "development|production"] },
      // Everything it imports is bundled: a bank's CI installs nothing.
      ssr: { noExternal: true, target: "node" },
      build: {
        ssr: join(import.meta.dirname, "main.ts"),
        outDir: scratch,
        emptyOutDir: true,
        minify: true,
        rolldownOptions: {
          output: { format: "es", entryFileNames: BANK_VALIDATOR_FILE, codeSplitting: false },
          // A contracts module's top level only defines, so what the validator takes nothing from is left out.
          treeshake: { moduleSideEffects: (id: string) => !id.includes("/packages/contracts/") },
        },
      },
    });
    const code = readFileSync(join(scratch, BANK_VALIDATOR_FILE), "utf8");
    writeFileSync(outFile, `${bankValidatorStamp()}\n${code}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
