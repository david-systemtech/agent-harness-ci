import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bankValidatorStamp } from "@agent-harness/contracts";
import { buildBankValidator } from "../../../contracts/scripts/bank-validator/build.js";
import { fixtureBuild, type FixtureBuild } from "../../test/release-fixtures.js";
import { buildRelease } from "./build.js";
import { artefactTargets } from "./targets.js";

let fixture: FixtureBuild;
afterEach(() => fixture?.remove());

it("ships the matching executable validator in every server archive", async () => {
  fixture = fixtureBuild();
  await buildRelease(fixture.options(), {
    ...fixture.seams,
    compile: async (root, version) => {
      await fixture.seams.compile!(root, version);
      const asset = join(root, "packages/contracts/dist/bank-validator/validate.mjs");
      mkdirSync(dirname(asset), { recursive: true });
      await buildBankValidator({ outFile: asset });
      const path = join(root, "packages/contracts/package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8")) as { exports: Record<string, unknown> };
      manifest.exports = { ...manifest.exports, "./bank-validator-file": "./dist/bank-validator/validate.mjs" };
      writeFileSync(path, JSON.stringify(manifest));
    },
  });
  for (const target of artefactTargets()) {
    const into = join(fixture.out, "unpacked", target.platform);
    mkdirSync(into, { recursive: true });
    const archive = join(fixture.out, target.name);
    if (archive.endsWith(".zip")) execFileSync("python3", ["-c", "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nz.extractall(sys.argv[2])", archive, into]);
    else execFileSync("tar", ["-xf", archive, "-C", into]);
    const resolved = execFileSync(process.execPath, ["--input-type=module", "-e", 'console.log(import.meta.resolve("@agent-harness/contracts/bank-validator-file"))'], { cwd: into, encoding: "utf8" }).trim();
    const asset = new URL(resolved);
    expect(readFileSync(asset, "utf8").startsWith(`${bankValidatorStamp()}\n`)).toBe(true);
    expect(execFileSync(process.execPath, [asset.pathname, "--version"], { encoding: "utf8" }).trim()).toBe("bank-validator 1");
  }
}, 120_000);
