import { execFile, fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HARNESS_VERSION, PREPARED_MESSAGE, ROOT_REFUSAL } from "@agent-harness/environment";
import { afterEach, describe, expect, it } from "vitest";

const spawnCli = promisify(execFile);
const entry = new URL("./main.ts", import.meta.url).pathname;
const privilegedEntry = new URL("../test/serve-privileged.ts", import.meta.url).pathname;
const tsx = createRequire(import.meta.url).resolve("tsx");
const runningAsRoot = process.geteuid?.() === 0;

// Runs an entry point in its own process, as a user's shell would.
const run = (script: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnCli(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx, script, ...args], { env });
const cli = (...args: string[]) => run(entry, args);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe("agent-harness", () => {
  it("prints the placeholder name and the harness version the environment reports, for --version", async () => {
    const { stdout } = await cli("--version");
    expect(stdout).toBe(`agent-harness ${HARNESS_VERSION}\n`);
  });

  it("prints its usage and fails on anything else", async () => {
    await expect(cli("--no-such-flag")).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("usage: agent-harness") });
  });

});

describe("agent-harness serve, as a privileged user", () => {
  it("prints one sentence and exits 1 before creating its data directory, whatever the environment says", async () => {
    const dataDir = join(tempDir(), "data");
    const env = { ...process.env, IS_SANDBOX: "1", CLAUDE_CODE_BUBBLEWRAP: "1", container: "docker" };
    const refused = run(privilegedEntry, ["serve", "--data-dir", dataDir, "--port", "0"], env);
    await expect(refused).rejects.toMatchObject({ code: 1, stdout: "", stderr: `${ROOT_REFUSAL}\n` });
    expect(existsSync(dataDir)).toBe(false);
  });

  it("refuses before reading its arguments, so no flag lifts the refusal or gets past it", async () => {
    for (const flag of ["--allow-root", "--no-root-check", "--unsafe", "--container", "--port=http"]) {
      await expect(run(privilegedEntry, ["serve", flag]), flag).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: `${ROOT_REFUSAL}\n`,
      });
    }
  });

  it.runIf(runningAsRoot)("refuses through the shipped entry when this test runs as root", async () => {
    const dataDir = join(tempDir(), "data");
    await expect(cli("serve", "--data-dir", dataDir, "--port", "0")).rejects.toMatchObject({
      code: 1,
      stderr: `${ROOT_REFUSAL}\n`,
    });
    await expect(cli("serve", "--allow-root")).rejects.toMatchObject({ code: 1, stderr: `${ROOT_REFUSAL}\n` });
    expect(existsSync(dataDir)).toBe(false);
  });
});

// Windows has no SIGTERM handling: kill() terminates the child outright, so the exit code proves nothing there.
describe.skipIf(runningAsRoot || process.platform === "win32")("agent-harness serve, as the ordinary user running this test", () => {
  it("tells the launcher it is prepared over IPC, prints the discovery address, and exits 0 on SIGTERM", async () => {
    const child = fork(entry, ["serve", "--data-dir", join(tempDir(), "data"), "--port", "0"], {
      execArgv: ["--conditions=@agent-harness/source", "--import", tsx],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    cleanups.push(() => void child.kill("SIGKILL"));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const prepared = new Promise<unknown>((resolve) => child.once("message", resolve));
    let stdout = "";
    const printed = new Promise<string>((resolve) =>
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.endsWith("\n")) resolve(stdout.trim());
      }),
    );

    expect(await prepared).toEqual(PREPARED_MESSAGE);
    const address = await printed;
    expect(await (await fetch(address)).json()).toMatchObject({ readiness: "ready" });
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });

  it("answers the launcher's idle query over IPC, and drains and exits 0 on its drain query", async () => {
    const child = fork(entry, ["serve", "--data-dir", join(tempDir(), "data"), "--port", "0"], {
      execArgv: ["--conditions=@agent-harness/source", "--import", tsx],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    cleanups.push(() => void child.kill("SIGKILL"));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const received: unknown[] = [];
    let heard: (() => void) | undefined;
    child.on("message", (message) => {
      received.push(message);
      heard?.();
    });
    const nth = (n: number) =>
      new Promise<unknown>((resolve) => {
        const look = () => (received.length > n ? resolve(received[n]) : undefined);
        heard = look;
        look();
      });

    expect(await nth(0)).toEqual(PREPARED_MESSAGE);
    child.send({ type: "idle?" });
    // A launcher is present, so updates are not managed outside, container or not.
    expect(await nth(1)).toEqual({ type: "idle", readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false });
    child.send({ type: "drain?" });
    expect(await nth(2)).toMatchObject({ type: "draining", drainingSince: expect.any(String) as string, trigger: "launcher" });
    expect(await exited).toBe(0);
  });
});
