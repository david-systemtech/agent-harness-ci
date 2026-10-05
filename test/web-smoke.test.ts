import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { removeTree } from "../packages/filesystem/src/index.js";
import { expect, it } from "vitest";
const run = promisify(execFile);
async function phase(name: string, args: string[], cwd: string, env = process.env) {
  console.log(`WEB-SMOKE PHASE ${name}: start`);
  const execution = run("pnpm", args, { cwd, env, maxBuffer: 8 * 1024 * 1024 });
  execution.child.stdout?.pipe(process.stdout, { end: false });
  execution.child.stderr?.pipe(process.stderr, { end: false });
  try {
    const result = await execution;
    console.log(`WEB-SMOKE PHASE ${name}: complete`);
    return result;
  } catch (error) {
    console.error(`WEB-SMOKE PHASE ${name}: failed`);
    throw error;
  }
}
const hosted = process.env["GITHUB_ACTIONS"] === "true" && process.env["RUNNER_ENVIRONMENT"] === "github-hosted" && process.getuid?.() !== 0;

// The ordinary-user hosted suite executes this file; local runs never launch a browser or server.
it.skipIf(!hosted)("the served production client completes the phone conversation over HTTPS in Chromium and WebKit", async () => {
  const out = mkdtempSync(join(tmpdir(), "web-smoke-"));
  try {
    const cwd = resolve("packages/gui");
    await phase("browser installation", ["exec", "playwright", "install", "--with-deps", "chromium", "webkit"], cwd);
    await phase("production build", ["exec", "vite", "build", "--outDir", join(out, "web")], cwd);
    const result = await phase("conversation", ["exec", "tsx", "--conditions=@agent-harness/source", "scripts/web-smoke.ts"], cwd,
      { ...process.env, WEB_SMOKE_BUNDLE: join(out, "web"), WEB_SMOKE_OUTPUT: out });
    expect(result.stdout).toContain("WEB-SMOKE PASS chromium");
    expect(result.stdout).toContain("WEB-SMOKE PASS webkit");
    expect(result.stdout).toContain("PHONE-INSTALL PASS chromium");
    expect(result.stdout).toContain("PHONE-INSTALL PASS webkit");
    expect(result.stdout).toContain("PHONE-REFUSAL PASS chromium");
    expect(result.stdout).toContain("PHONE-REFUSAL PASS webkit");
  } finally { await removeTree(out); }
}, 600_000);
