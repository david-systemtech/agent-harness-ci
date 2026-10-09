import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { BANK_VALIDATOR_DIST, buildBankValidator } from "../packages/contracts/scripts/bank-validator/build.js";

it("creates a local-only bank with its shipped validator before checking describe and landing", async () => {
  mkdirSync(join(BANK_VALIDATOR_DIST, ".."), { recursive: true });
  await buildBankValidator({ outFile: BANK_VALIDATOR_DIST });
  const root = join(import.meta.dirname, "..");
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const result = await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx,
    join(root, "scripts/check-packaged-bank-describe.mjs"), root]);
  expect(result.stdout).toContain("Verified packaged local-only bank describe: canonical repository, committed main, refreshed purpose and landing status");
  expect(result.stdout).toContain("Verified packaged local-only bank creation: registered bank and matching executable validator");
});
