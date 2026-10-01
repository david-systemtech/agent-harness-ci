import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memory, PERSONAL_BANK, RULE_FIXTURES, TEAM_BANK, type FixtureBank } from "../../test/fixture-banks.js";
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
/**
 * `bank` on disk with the built validator vendored at
 * `.agent-harness/validate.mjs`, as a bank's CI checks it out, and each of
 * its `unreadable` files a link to nothing.
 */
const onDisk = (bank: FixtureBank, unreadable: Readonly<Record<string, string>> = {}): string => {
  const root = join(scratch, `bank-${(banks += 1)}`);
  for (const [path, text] of Object.entries({ ...bank, ".agent-harness/validate.mjs": readFileSync(built, "utf8") })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const path of Object.keys(unreadable)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(join(root, "nowhere.md"), join(root, path));
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

  const cases: readonly (readonly [string, FixtureBank, Readonly<Record<string, string>>])[] = [
    ["the personal bank", PERSONAL_BANK, {}],
    ["the team bank", TEAM_BANK, {}],
    ...Object.entries(RULE_FIXTURES).map(([rule, { bank, unreadable = {} }]) => [`the bank breaking ${rule}`, bank, unreadable] as const),
  ];
  it.each(cases)("gives %s the verdict the functions give, exiting 1 only on a refusal", async (_, bank, unreadable) => {
    const expected = validateBank({ files: bank, unreadable });
    const { code, stdout } = await validate(onDisk(bank, unreadable), "--json");
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

  it("gives a verdict on a Markdown file it cannot read, not a stack trace, and reads a link to a file as the file", async () => {
    const { bank, unreadable, path } = RULE_FIXTURES.unreadable;
    const root = onDisk(bank, unreadable);
    expect(await validate(root)).toEqual({
      code: 1,
      stdout: `refused unreadable: ${path} could not be read (ENOENT), so the verdict is on the bank without it: make it readable, or remove it.\nbank-validator 1: 1 refused\n`,
    });
    writeFileSync(join(root, "nowhere.md"), memory("restore-drill"));
    expect(await validate(root)).toEqual({ code: 0, stdout: "bank-validator 1: valid\n" });
  });

  it("refuses a folder it cannot list and a link back to a folder it is in, and reads a linked folder as the folder", async () => {
    const manifest = { "BANK.md": PERSONAL_BANK["BANK.md"] ?? "" };
    const flat = await validate(onDisk({ ...manifest, projects: "A file where the projects/ folder goes.\n" }), "--json");
    expect(JSON.parse(flat.stdout)).toEqual(validateBank({ files: manifest, unreadable: { "projects/": "ENOTDIR" } }));
    expect(flat.code).toBe(1);
    const looped = onDisk(PERSONAL_BANK);
    symlinkSync("..", join(looped, "projects/personal/homelab/memories/loop"));
    expect((await validate(looped)).stdout).toBe(
      "refused unreadable: projects/personal/homelab/memories/loop/ could not be read (ELOOP), so the verdict is on the bank without it: make it readable, or remove it.\nbank-validator 1: 1 refused\n",
    );
    const nas = "projects/personal/homelab/nas";
    const linked = onDisk(Object.fromEntries(Object.entries(PERSONAL_BANK).map(([path, text]) => [path.replace(`${nas}/`, "elsewhere/nas/"), text])));
    symlinkSync("../../../elsewhere/nas", join(linked, nas));
    expect(await validate(linked)).toEqual({ code: 0, stdout: "bank-validator 1: valid\n" });
  });

  it("validates the bank a path names, from anywhere", async () => {
    const root = onDisk(TEAM_BANK);
    const { stdout } = await run(process.execPath, [join(root, ".agent-harness/validate.mjs"), root], { cwd: scratch });
    expect(stdout).toBe("bank-validator 1: valid\n");
  });
});
