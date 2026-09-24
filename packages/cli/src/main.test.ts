import { execFile, fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PREPARED_MESSAGE, ROOT_REFUSAL } from "@agent-harness/environment";
import { afterEach, describe, expect, it } from "vitest";

const spawnCli = promisify(execFile);
const entry = new URL("./main.ts", import.meta.url).pathname;
const privilegedEntry = new URL("../test/serve-privileged.ts", import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
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
  it("prints the placeholder name and its version for --version", async () => {
    const { stdout } = await cli("--version");
    expect(stdout).toBe(`agent-harness ${version}\n`);
  });

  it("prints its usage and fails on anything else", async () => {
    await expect(cli("--no-such-flag")).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("usage: agent-harness") });
  });

  it("prints its usage and fails on a serve it cannot parse", async () => {
    for (const args of [["serve", "--port", "http"], ["serve", "--port", "70000"], ["serve", "extra"], ["serve", "--data-dir"]]) {
      await expect(cli(...args), args.join(" ")).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("agent-harness serve [--data-dir <path>] [--port <n>] [--name <name>]"),
      });
    }
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

  it("has no flag that lifts the refusal", async () => {
    for (const flag of ["--allow-root", "--no-root-check", "--unsafe", "--container"]) {
      await expect(run(privilegedEntry, ["serve", flag, "--port", "0"]), flag).rejects.toMatchObject({ code: 2 });
    }
  });

  it.runIf(runningAsRoot)("refuses through the shipped entry when this test runs as root", async () => {
    const dataDir = join(tempDir(), "data");
    await expect(cli("serve", "--data-dir", dataDir, "--port", "0")).rejects.toMatchObject({
      code: 1,
      stderr: `${ROOT_REFUSAL}\n`,
    });
    expect(existsSync(dataDir)).toBe(false);
  });
});

describe.skipIf(runningAsRoot)("agent-harness serve, as the ordinary user running this test", () => {
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
});
