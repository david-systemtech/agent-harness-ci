import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("answers the first message after restart through the packaged resume smoke entry", async () => {
  const root = join(import.meta.dirname, "..");
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const result = await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx,
    join(root, "scripts/check-packaged-resume.mjs"), root, "--source"]);
  expect(result.stdout).toContain("Verified packaged resume: persisted history, empty startup completion, first message answered in one turn");
});
