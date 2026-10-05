import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeTree } from "../packages/filesystem/src/index.js";
import { expect, it, onTestFinished } from "vitest";
import { smokeProcess } from "./smoke-process.js";
async function phase(name: string, args: string[], cwd: string, signal: AbortSignal, env = process.env) {
  console.log(`WEB-SMOKE PHASE ${name}: start`);
  const execution = smokeProcess("pnpm", args, { cwd, env, signal });
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
  const controller = new AbortController();
  onTestFinished(() => { controller.abort(new Error("The hosted smoke test finished.")); });
  const deadline = (ms: number) => AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]);
  try {
    const cwd = resolve("packages/gui");
    await phase("browser installation", ["exec", "playwright", "install", "--with-deps", "chromium", "webkit"], cwd, deadline(180_000));
    await phase("production build", ["exec", "vite", "build", "--outDir", join(out, "web")], cwd, deadline(120_000));
    const result = await phase("conversation", ["exec", "tsx", "--conditions=@agent-harness/source", "scripts/web-smoke.ts"], cwd, deadline(240_000),
      { ...process.env, WEB_SMOKE_BUNDLE: join(out, "web"), WEB_SMOKE_OUTPUT: out });
    expect(result.stdout).toContain("WEB-SMOKE PASS chromium");
    expect(result.stdout).toContain("WEB-SMOKE PASS webkit");
    expect(result.stdout).toContain("PHONE-INSTALL PASS chromium");
    expect(result.stdout).toContain("PHONE-INSTALL PASS webkit");
    for (const engine of ["chromium", "webkit"]) {
      for (const regression of ["PHONE-FRAME", "PHONE-PANES", "PHONE-FALLBACK"]) {
        expect(result.stdout).toContain(`${regression} PASS ${engine}`);
      }
    }
    expect(result.stdout).toContain("PHONE-REFUSAL PASS chromium");
    expect(result.stdout).toContain("PHONE-REFUSAL PASS webkit");
    expect(result.stdout).toContain("PHONE-RUN-PICKER PASS chromium");
    expect(result.stdout).toContain("PHONE-RUN-PICKER PASS webkit");
  } finally { controller.abort(); await removeTree(out); }
}, 600_000);
