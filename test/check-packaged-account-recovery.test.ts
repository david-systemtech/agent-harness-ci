import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("checks two persisted accounts after update startup and restart through the packaged smoke entry", async () => {
  const root = join(import.meta.dirname, "..");
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const result = await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx,
    join(root, "scripts/check-packaged-account-recovery.mjs"), root, "--source"]);
  expect(result.stdout).toContain("Verified packaged account recovery: two persisted accounts, cancelled deadlines, strict readiness, automatic recovery after update startup and restart");
});
