import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { removeTree } from "../packages/filesystem/src/index.js";
import { expect, it } from "vitest";
const run = promisify(execFile);
const hosted = process.env["GITHUB_ACTIONS"] === "true" && process.env["RUNNER_ENVIRONMENT"] === "github-hosted" && process.getuid?.() !== 0;

// The ordinary-user hosted suite executes this file; local runs never launch a browser or server.
it.skipIf(!hosted)("the served production client completes the phone conversation over HTTPS in Chromium and WebKit", async () => {
  const out = mkdtempSync(join(tmpdir(), "web-smoke-"));
  try {
    const cwd = resolve("packages/gui");
    await run("pnpm", ["exec", "playwright", "install", "--with-deps", "chromium", "webkit"], { cwd, maxBuffer: 8 * 1024 * 1024 });
    await run("pnpm", ["exec", "vite", "build", "--outDir", join(out, "web")], { cwd, maxBuffer: 8 * 1024 * 1024 });
    const execution = run("pnpm", ["exec", "tsx", "--conditions=@agent-harness/source", "scripts/web-smoke.ts"], {
      cwd, env: { ...process.env, WEB_SMOKE_BUNDLE: join(out, "web"), WEB_SMOKE_OUTPUT: out }, maxBuffer: 8 * 1024 * 1024,
    });
    execution.child.stdout?.pipe(process.stdout, { end: false });
    execution.child.stderr?.pipe(process.stderr, { end: false });
    const result = await execution;
    expect(result.stdout).toContain("WEB-SMOKE PASS chromium");
    expect(result.stdout).toContain("WEB-SMOKE PASS webkit");
    expect(result.stdout).toContain("PHONE-INSTALL PASS chromium");
    expect(result.stdout).toContain("PHONE-INSTALL PASS webkit");
    expect(result.stdout).toContain("PHONE-FRAME PASS chromium:");
    expect(result.stdout).toContain("PHONE-FRAME PASS webkit:");
    expect(result.stdout).toContain("PHONE-FRAME PASS chromium full grant:");
    expect(result.stdout).toContain("PHONE-FRAME PASS webkit full grant:");
    expect(result.stdout).toContain("PHONE-REFUSAL PASS chromium");
    expect(result.stdout).toContain("PHONE-REFUSAL PASS webkit");
  } finally { await removeTree(out); }
}, 600_000);
