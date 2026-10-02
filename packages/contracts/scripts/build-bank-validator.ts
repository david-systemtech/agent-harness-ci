import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BANK_VALIDATOR_DIST, buildBankValidator } from "./bank-validator/build.js";

/**
 * `pnpm --filter @agent-harness/contracts build-validator`: the bank
 * validator's `validate.mjs` into the package's `dist/bank-validator/`, or
 * to `--out`.
 */

const { values } = parseArgs({ options: { out: { type: "string" } } });
const outFile = resolve(values.out ?? BANK_VALIDATOR_DIST);
mkdirSync(dirname(outFile), { recursive: true });
await buildBankValidator({ outFile });
process.stdout.write(`Built the bank validator in ${outFile}.\n`);
