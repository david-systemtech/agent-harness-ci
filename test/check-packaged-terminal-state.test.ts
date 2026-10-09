import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("runs the release terminal-state check over real persistence modules and files", async () => {
  const root = join(import.meta.dirname, "..");
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const result = await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx,
    join(root, "scripts/check-packaged-terminal-state.mjs"), root]);
  expect(result.stdout).toContain("Verified packaged terminal document write and committed recovery replay");
});
