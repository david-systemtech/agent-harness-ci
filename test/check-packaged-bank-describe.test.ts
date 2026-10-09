import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("runs the packaged bank describe check over real git, event persistence and bank landing", async () => {
  const root = join(import.meta.dirname, "..");
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const result = await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx,
    join(root, "scripts/check-packaged-bank-describe.mjs"), root]);
  expect(result.stdout).toContain("Verified packaged local-only bank describe: canonical repository, committed main, refreshed purpose and landing status");
});
