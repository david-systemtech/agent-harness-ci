import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_GRANT_FILE,
  BootstrapGrant,
  DISCOVERY_PATH,
  PAIR_PATH,
  PROTOCOL_VERSION,
  formatPairingCode,
  parsePairingLink,
  type LauncherQuery,
  type LauncherReply,
} from "@agent-harness/contracts";
import { HARNESS_VERSION, NO_LAUNCHER, createRunRegistry, systemClock, type ContainerDetector, type ContainmentProbe } from "@agent-harness/environment";
import { renderUnicodeCompact } from "uqr";
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

/** What the containment probe finds: no bubblewrap, so a test never probes the machine it runs on. */
const NO_BUBBLEWRAP: ContainmentProbe = {
  mechanism: null,
  levels: {
    workspace: { available: false, reason: "bubblewrap is not installed.", cause: "binary_missing" },
    "workspace-no-network": { available: false, reason: "bubblewrap is not installed.", cause: "binary_missing" },
  },
  container: { declared: false, detected: false },
};

/** The CLI in-process, as an ordinary user under a scripted launcher, outside any container unless `containerDetector` says otherwise, stopped when the test says. */
const harness = (containerDetector: ContainerDetector = { inContainer: () => false }) => {
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
      launcher: { present: () => true, prepared, close, onQuery: (respond) => void (answer = respond), request: () => Promise.resolve(NO_LAUNCHER) },
      runs,
      interfaces: { tailscaleAddress: async () => undefined, tailnetName: async () => undefined, lanAddresses: () => [] },
      probeContainment: async () => NO_BUBBLEWRAP,
      containerDetector,
      // The extension's listener on any free port, never 47615 (#547).
      browser: { ports: { preferred: 0, last: 0 } },
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
    expect(cli.prepared).toHaveBeenCalledWith(HARNESS_VERSION);
    const discovery = (await (await fetch(address)).json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({ environmentName: "cli", readiness: "ready" });

    expect(cli.close).not.toHaveBeenCalled();
    cli.stop();
    expect(await exit).toBe(0);
    expect(cli.close).toHaveBeenCalledOnce();
    await expect(fetch(address)).rejects.toThrow();
    expect(cli.err()).toBe("");
  });

  it("prints the discovery address only once the launcher has committed the version serve said it runs", async () => {
    const cli = harness();
    let commit!: () => void;
    cli.prepared.mockImplementation(() => new Promise<void>((resolve) => (commit = resolve)));
    const dataDir = join(tempDir(), "data");
    const exit = runCli(["serve", "--data-dir", dataDir, "--port", "0"], cli.context);
    await vi.waitFor(() => expect(cli.prepared).toHaveBeenCalledWith(HARNESS_VERSION), SERVE_WAIT);

    const { address } = BootstrapGrant.parse(JSON.parse(readFileSync(join(dataDir, BOOTSTRAP_GRANT_FILE), "utf8")));
    const discovery = `http://${address.host}:${address.port}${DISCOVERY_PATH}`;
    expect(await (await fetch(discovery)).json()).toMatchObject({ readiness: "starting" });
    expect(cli.out()).toBe("");

    commit();
    await vi.waitFor(() => expect(cli.out()).toBe(`${discovery}\n`), SERVE_WAIT);
    expect(await (await fetch(discovery)).json()).toMatchObject({ readiness: "ready" });
    cli.stop();
    expect(await exit).toBe(0);
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
      binding: { tailnet: null, lan: null, lanAddresses: [] },
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

  it("in a declared container no client has paired with, prints pair's link, QR and code after the discovery address, for its log (#349)", async () => {
    const cli = harness({ inContainer: () => true, declared: () => true });
    const dataDir = join(tempDir(), "data");
    const exit = runCli(["serve", "--data-dir", dataDir, "--port", "0"], cli.context);
    await vi.waitFor(() => expect(cli.out()).toMatch(/Code: .+\n[^]*\n$/), SERVE_WAIT);

    const [address = "", intro, ...pairing] = cli.out().split("\n");
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\.well-known\//);
    expect(intro).toBe(`No client has paired with this environment yet. Pair one with this code, or run agent-harness pair --data-dir ${dataDir} in the container for a new one.`);
    const printed = pairing.join("\n");
    const link = /http:\/\/\S+\/pair#\S+/.exec(printed)?.[0] ?? "";
    const code = parsePairingLink(link)?.code ?? "";
    expect(printed).toContain(renderUnicodeCompact(link, { border: 2 }));
    expect(printed).toContain(`Code: ${formatPairingCode(code)}`);
    const exchanged = await fetch(`${new URL(address).origin}${PAIR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, kind: "web", label: "phone", protocolVersion: PROTOCOL_VERSION }),
    });
    expect(exchanged.status).toBe(200);

    cli.stop();
    expect(await exit).toBe(0);
    expect(cli.err()).toBe("");
  });
});
