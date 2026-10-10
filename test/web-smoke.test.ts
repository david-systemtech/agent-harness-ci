import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeTree } from "../packages/filesystem/src/index.js";
import { expect, it, onTestFinished } from "vitest";
import { smokeProcess } from "./smoke-process.js";
async function phase(name: string, args: string[], cwd: string, signal: AbortSignal, env = process.env, privilegedCleanup = false, stallMs?: number) {
  const started = performance.now();
  console.log(`WEB-SMOKE PHASE ${name}: start (uid=${process.getuid?.()}, pnpm ${args.join(" ")})`);
  const execution = smokeProcess("pnpm", args, { cwd, env, signal, privilegedCleanup, ...(stallMs === undefined ? {} : { stallMs }) });
  try {
    const result = await execution;
    console.log(`WEB-SMOKE PHASE ${name}: complete (${Math.round(performance.now() - started)} ms)`);
    return result;
  } catch (error) {
    console.error(`WEB-SMOKE PHASE ${name}: failed (${Math.round(performance.now() - started)} ms, ${signal.aborted ? String(signal.reason) : String(error)})`);
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
    // apt fetches these from the runner's Ubuntu mirror: 39 s on a good day, but at its slowest the
    // mirror needs about 10 minutes for the 126 MB (run 37627174245). An install that still writes
    // its progress may take that long; one that goes quiet for three minutes has stalled (#1802).
    await phase("browser system dependencies", ["exec", "playwright", "install-deps", "chromium", "webkit"], cwd, deadline(720_000), process.env, true, 180_000);
    await phase("browser downloads", ["exec", "playwright", "install", "chromium", "webkit"], cwd, deadline(240_000));
    await phase("production build", ["exec", "vite", "build", "--outDir", join(out, "web")], cwd, deadline(120_000));
    const result = await phase("conversation", ["exec", "tsx", "--conditions=@agent-harness/source", "scripts/web-smoke.ts"], cwd, deadline(240_000),
      { ...process.env, WEB_SMOKE_BUNDLE: join(out, "web"), WEB_SMOKE_OUTPUT: out });
    expect(result.stdout).toContain("WEB-SMOKE PASS chromium");
    expect(result.stdout).toContain("WEB-SMOKE PASS webkit");
    expect(result.stdout).toContain("PHONE-INSTALL PASS chromium");
    expect(result.stdout).toContain("PHONE-INSTALL PASS webkit");
    expectFrameChecks(result.stdout);
    expectSessionRouteChecks(result.stdout);
    for (const engine of ["chromium", "webkit"]) {
      for (const regression of ["PHONE-PANES", "PHONE-FALLBACK"]) {
        expect(result.stdout).toContain(`${regression} PASS ${engine}`);
      }
    }
    expect(result.stdout).toContain("PHONE-REFUSAL PASS chromium");
    expect(result.stdout).toContain("PHONE-REFUSAL PASS webkit");
    expect(result.stdout).toContain("PHONE-RUN-PICKER PASS chromium");
    expect(result.stdout).toContain("PHONE-RUN-PICKER PASS webkit");
  } finally { controller.abort(); await removeTree(out); }
}, 1_440_000);

function expectFrameChecks(stdout: string) {
  for (const engine of ["chromium", "webkit"]) {
    expect(stdout).toContain(`PHONE-FRAME PASS ${engine}:`);
    expect(stdout).toContain(`PHONE-SAFE-AREA PASS ${engine}:`);
    expect(stdout).toContain(`PHONE-SAFE-AREA PASS ${engine} full grant:`);
  }
}

// Completed stdout is the boundary: omitting any helper must fail the hosted gate.
const frameOutput = [
  { path: "frame chromium", line: "PHONE-FRAME PASS chromium: touch targets, drawer focus, grant restrictions" },
  { path: "frame webkit", line: "PHONE-FRAME PASS webkit: touch targets, drawer focus, grant restrictions" },
  { path: "safe area chromium", line: "PHONE-SAFE-AREA PASS chromium: safe area, grant wrapping, no overlap, touch focus" },
  { path: "safe area webkit", line: "PHONE-SAFE-AREA PASS webkit: safe area, grant wrapping, no overlap, touch focus" },
  { path: "safe area chromium full grant", line: "PHONE-SAFE-AREA PASS chromium full grant: safe area, grant wrapping, no overlap, touch focus" },
  { path: "safe area webkit full grant", line: "PHONE-SAFE-AREA PASS webkit full grant: safe area, grant wrapping, no overlap, touch focus" },
];
it.each(frameOutput)("rejects hosted stdout missing $path", ({ path }) => {
  expectFrameChecks(frameOutput.map(output => output.line).join("\n"));
  const incomplete = frameOutput.filter(output => output.path !== path).map(output => output.line).join("\n");
  expect(() => expectFrameChecks(incomplete)).toThrow();
});

function expectSessionRouteChecks(stdout: string) {
  for (const engine of ["chromium", "webkit"]) {
    for (const grant of [engine, `${engine} live run`, `${engine} full grant`]) {
      expect(stdout).toContain(`WEB-SESSION-ROUTE PASS ${grant}:`);
    }
  }
}

const routeOutput = ["chromium", "webkit"].flatMap(engine => [engine, `${engine} live run`, `${engine} full grant`]);
it.each(routeOutput)("rejects hosted stdout missing the same-document session route check for %s", missing => {
  expectSessionRouteChecks(routeOutput.map(path => `WEB-SESSION-ROUTE PASS ${path}:`).join("\n"));
  expect(() => expectSessionRouteChecks(routeOutput.filter(path => path !== missing).map(path => `WEB-SESSION-ROUTE PASS ${path}:`).join("\n"))).toThrow();
});
