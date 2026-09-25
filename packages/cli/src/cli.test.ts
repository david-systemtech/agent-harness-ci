import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCOVERY_PATH } from "@agent-harness/contracts";
import { createRunRegistry, systemClock, type LauncherQuery, type LauncherReply } from "@agent-harness/environment";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliContext } from "./cli.js";

/** How long a spawned serve may take to print or drain under a loaded runner: vi.waitFor presets one second, which the full suite exceeds. */
const SERVE_WAIT = { timeout: 15_000 };

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

/** The CLI in-process, as an ordinary user with no launcher, stopped when the test says. */
const harness = () => {
  let out = "";
  let err = "";
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  cleanups.push(() => stop());
  const prepared = vi.fn();
  const close = vi.fn();
  let answer: ((query: LauncherQuery) => LauncherReply) | undefined;
  const ask = (query: LauncherQuery): LauncherReply => {
    if (!answer) throw new Error("serve answers no launcher queries yet");
    return answer(query);
  };
  const runs = createRunRegistry({ clock: systemClock });
  const context: CliContext = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    stopRequested: () => stopped,
    environment: {
      user: { isPrivileged: () => false },
      launcher: { present: () => true, prepared, close, onQuery: (respond) => void (answer = respond) },
      runs,
      interfaces: { tailscaleAddress: async () => undefined, tailnetName: async () => undefined },
    },
  };
  return { context, stop, prepared, close, ask, runs, out: () => out, err: () => err };
};

describe("agent-harness serve", () => {
  it("prints the discovery address once ready, serves until stopped, then exits 0", async () => {
    const cli = harness();
    const exit = runCli(["serve", "--data-dir", join(tempDir(), "data"), "--port", "0", "--name", "cli"], cli.context);
    await vi.waitFor(() => expect(cli.out()).toMatch(/\n$/), SERVE_WAIT);

    const address = cli.out().trim();
    expect(address).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${DISCOVERY_PATH.replaceAll(".", "\\.")}$`));
    expect(cli.prepared).toHaveBeenCalledOnce();
    const discovery = (await (await fetch(address)).json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({ environmentName: "cli", readiness: "ready" });

    expect(cli.close).not.toHaveBeenCalled();
    cli.stop();
    expect(await exit).toBe(0);
    expect(cli.close).toHaveBeenCalledOnce();
    await expect(fetch(address)).rejects.toThrow();
    expect(cli.err()).toBe("");
  });

  it("drains on a stop request (SIGTERM): draining while a run holds it, then exits 0 once the run has ended", async () => {
    const cli = harness();
    cli.runs.start("r1");
    cli.runs.running("r1");
    let exited = false;
    const exit = runCli(["serve", "--data-dir", join(tempDir(), "data"), "--port", "0"], cli.context).finally(() => (exited = true));
    await vi.waitFor(() => expect(cli.out()).toMatch(/\n$/), SERVE_WAIT);
    const address = cli.out().trim();

    cli.stop();
    await vi.waitFor(async () => expect(await (await fetch(address)).json()).toMatchObject({ readiness: "draining" }), SERVE_WAIT);
    expect(exited).toBe(false);
    expect(cli.close).not.toHaveBeenCalled();
    cli.runs.end("r1");
    expect(await exit).toBe(0);
    expect(cli.close).toHaveBeenCalledOnce();
    await expect(fetch(address)).rejects.toThrow();
  });

  it("drains and exits 0 when the launcher's channel asks it to, having answered that it is idle", async () => {
    const cli = harness();
    const exit = runCli(["serve", "--data-dir", join(tempDir(), "data"), "--port", "0"], cli.context);
    await vi.waitFor(() => expect(cli.out()).toMatch(/\n$/), SERVE_WAIT);
    expect(cli.ask({ type: "idle?" })).toEqual({
      type: "idle",
      readiness: "ready",
      activity: { state: "idle" },
      updatesManagedOutside: false,
    });
    expect(cli.ask({ type: "drain?" })).toMatchObject({ type: "draining", trigger: "launcher" });
    expect(await exit).toBe(0);
    expect(cli.close).toHaveBeenCalledOnce();
    expect(cli.err()).toBe("");
  });

  it("prints its usage and exits 2 on arguments it cannot parse, as an ordinary user", async () => {
    for (const args of [
      ["serve", "--port", "http"],
      ["serve", "--port", "70000"],
      ["serve", "--port", ""],
      ["serve", "extra"],
      ["serve", "--data-dir"],
      ["serve", "--allow-root"],
    ]) {
      const cli = harness();
      expect(await runCli(args, cli.context), args.join(" ")).toBe(2);
      expect(cli.err()).toContain("agent-harness serve [--data-dir <path>] [--port <n>] [--name <name>]");
      expect(cli.prepared).not.toHaveBeenCalled();
    }
  });

  it("prints the failed step and exits 1 when startup fails", async () => {
    const first = harness();
    const running = runCli(["serve", "--data-dir", join(tempDir(), "one"), "--port", "0"], first.context);
    await vi.waitFor(() => expect(first.out()).toMatch(/\n$/), SERVE_WAIT);
    const port = new URL(first.out().trim()).port;

    const second = harness();
    const code = await runCli(["serve", "--data-dir", join(tempDir(), "two"), "--port", port], second.context);
    expect(code).toBe(1);
    expect(second.err()).toMatch(/^agent-harness could not start: Startup failed at the listen step: .+\n$/);
    expect(second.prepared).not.toHaveBeenCalled();

    first.stop();
    expect(await running).toBe(0);
  });
});
