import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OUTPUT_LIMIT, createSpawnSignInProcess, runToExit, type SignInChild } from "./signin-process.js";

/**
 * The real process seam (#135), against Node itself as the CLI
 * (`process.execPath -e`): stdin a pipe, stdout read as it comes, the end
 * read on exit even when a grandchild holds the output open, a stop that
 * escalates to SIGKILL for a process that ignores SIGTERM, and the probe's
 * output bounded.
 */

const env = { PATH: process.env["PATH"] ?? "" };
const cwd = tmpdir();

/** Resolves with how `child` ended, and the stdout it printed. */
const ending = (child: SignInChild): Promise<{ code: number | null; error: string | null; stdout: string }> =>
  new Promise((resolve) => {
    let stdout = "";
    child.onStdout((chunk) => (stdout += chunk));
    child.onExit((code, error) => resolve({ code, error, stdout }));
  });

/** Resolves once `child` has printed `text`. */
const printed = (child: SignInChild, text: string): Promise<void> =>
  new Promise((resolve) => {
    let seen = "";
    child.onStdout((chunk) => {
      seen += chunk;
      if (seen.includes(text)) resolve();
    });
  });

describe("the real sign-in process", () => {
  it("prints a prompt, reads the code written to stdin, and reports its exit", async () => {
    const spawn = createSpawnSignInProcess();
    const script = `process.stdout.write("Paste code here if prompted > "); process.stdin.once("data", (d) => { console.log("got " + String(d).trim()); process.exit(0); });`;
    const child = spawn(process.execPath, ["-e", script], { env, cwd });
    const end = ending(child);
    await printed(child, "Paste code here");
    child.write("abc#def\n");
    expect(await end).toEqual({ code: 0, error: null, stdout: "Paste code here if prompted > got abc#def\n" });
  });

  it("kills a process that ignores SIGTERM once the kill delay has passed", async () => {
    const spawn = createSpawnSignInProcess({ killAfterMs: 100 });
    const script = `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", script], { env, cwd });
    const end = ending(child);
    await printed(child, "ready");
    const at = Date.now();
    child.kill();
    const ended = await end;
    expect(ended.code).toBeNull();
    expect(ended.error).toBe("It was ended by SIGKILL.");
    expect(Date.now() - at).toBeGreaterThanOrEqual(90);
  });

  it("reports the exit within the grace when a process it started holds the output open", async () => {
    const spawn = createSpawnSignInProcess({ exitGraceMs: 50 });
    const script = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "inherit" }); setTimeout(() => process.exit(0), 50);`;
    const child = spawn(process.execPath, ["-e", script], { env, cwd });
    const at = Date.now();
    const ended = await ending(child);
    expect(ended.code).toBe(0);
    expect(Date.now() - at).toBeLessThan(1_200);
  });

  it("reports a command that cannot be run as never run, with why", async () => {
    const spawn = createSpawnSignInProcess();
    const ended = await ending(spawn("/nonexistent/agent-harness/claude", ["auth", "login"], { env, cwd }));
    expect(ended.code).toBeNull();
    expect(ended.error).toMatch(/ENOENT/);
  });
});

describe("the probe runner", () => {
  it("keeps the last 64 KiB of what a probe prints", async () => {
    const spawn = createSpawnSignInProcess();
    const script = `process.stdout.write("x".repeat(${OUTPUT_LIMIT * 2}) + "END");`;
    const result = await runToExit(spawn, process.execPath, ["-e", script], { env, cwd }, 10_000);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(OUTPUT_LIMIT);
    expect(result.stdout.endsWith("END")).toBe(true);
  });

  it("kills a probe in flight when the environment closes", async () => {
    const spawn = createSpawnSignInProcess({ killAfterMs: 100 });
    const closing = new AbortController();
    const running = runToExit(spawn, process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env, cwd }, 10_000, closing.signal);
    closing.abort();
    const result = await running;
    expect(result.code).toBeNull();
    expect(result.stderr).toMatch(/the environment is closing/);
  });
});
