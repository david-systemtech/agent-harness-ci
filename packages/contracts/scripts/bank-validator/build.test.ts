import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERSONAL_BANK, RULE_FIXTURES, TEAM_BANK, type FixtureBank } from "../../test/fixture-banks.js";
import { validateBank } from "../../src/bank-validator.js";
import { BANK_VALIDATOR, readBankValidatorStamp, STEP_PROMPTS } from "../../src/index.js";
import { BANK_VALIDATOR_FILE, buildBankValidator } from "./build.js";

/**
 * The bank validator's build (#1023), run once into a scratch folder: the
 * one Node file a bank vendors, stamped with the rules it carries, run by
 * Node from inside each fixture bank with nothing installed, and giving the
 * verdicts the functions give.
 */

/** Vite bundling under a loaded runner: a cap for a hang, not a budget. */
const BUILD_MS = 120_000;

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "agent-harness-bank-validator-test-"));
const built = join(scratch, BANK_VALIDATOR_FILE);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeAll(() => buildBankValidator({ outFile: built }), BUILD_MS);

let banks = 0;
/** `bank` on disk with the built validator vendored at `.agent-harness/validate.mjs`, as a bank's CI checks it out. */
const onDisk = (bank: FixtureBank): string => {
  const root = join(scratch, `bank-${(banks += 1)}`);
  for (const [path, text] of Object.entries({ ...bank, ".agent-harness/validate.mjs": readFileSync(built, "utf8") })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

/** `node .agent-harness/validate.mjs ...args` in `root`: its exit code and output. */
const validate = async (root: string, ...args: string[]): Promise<{ readonly code: number; readonly stdout: string }> => {
  try {
    const { stdout } = await run(process.execPath, [".agent-harness/validate.mjs", ...args], { cwd: root });
    return { code: 0, stdout };
  } catch (error) {
    const { code, stdout } = error as { code: number; stdout: string };
    return { code, stdout };
  }
};

describe("the bank validator's validate.mjs", () => {
  it("opens with the stamp of the rules it carries, the version BANK_VALIDATOR and the describe prompt name", async () => {
    const stamp = readBankValidatorStamp(readFileSync(built, "utf8"));
    expect(stamp).toEqual({ name: "bank-validator", version: 1 });
    expect(stamp).toEqual(BANK_VALIDATOR);
    expect(STEP_PROMPTS.find((prompt) => prompt.id === "describe-bank")?.validator).toEqual(stamp);
    expect(await validate(onDisk(PERSONAL_BANK), "--version")).toEqual({ code: 0, stdout: "bank-validator 1\n" });
  });

  const cases: readonly (readonly [string, FixtureBank])[] = [
    ["the personal bank", PERSONAL_BANK],
    ["the team bank", TEAM_BANK],
    ...Object.entries(RULE_FIXTURES).map(([rule, { bank }]) => [`the bank breaking ${rule}`, bank] as const),
  ];
  it.each(cases)("gives %s the verdict the functions give, exiting 1 only on a refusal", async (_, bank) => {
    const expected = validateBank({ files: bank });
    const { code, stdout } = await validate(onDisk(bank), "--json");
    expect(JSON.parse(stdout)).toEqual(expected);
    expect(code).toBe(expected.valid ? 0 : 1);
  });

  it("prints each finding's rule and message for the bank's author, and a last line with the count", async () => {
    const { code, stdout } = await validate(onDisk(RULE_FIXTURES.orientation_missing.bank));
    expect(code).toBe(1);
    expect(stdout).toBe(
      [
        "refused orientation_missing: BANK.md's orientation names where-work-is-tracked, which no memory in the bank has: write it in the bank's home folder or take the name out.",
        "bank-validator 1: 1 refused",
        "",
      ].join("\n"),
    );
    const warned = await validate(onDisk(RULE_FIXTURES.description_trigger.bank));
    expect(warned.code).toBe(0);
    expect(warned.stdout).toMatch(/^warning description_trigger: .*\nbank-validator 1: valid, 1 warning\n$/);
  });

  it("validates the bank a path names, from anywhere", async () => {
    const root = onDisk(TEAM_BANK);
    const { stdout } = await run(process.execPath, [join(root, ".agent-harness/validate.mjs"), root], { cwd: scratch });
    expect(stdout).toBe("bank-validator 1: valid\n");
  });
});
