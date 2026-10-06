import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Server, request } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { hostname, tmpdir } from "node:os";
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
import { HARNESS_VERSION, NO_LAUNCHER, createRunRegistry, systemClock, tailscaleDetector, type ContainerDetector, type ContainmentProbe } from "@agent-harness/environment";
import { renderUnicodeCompact } from "uqr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliContext } from "./cli.js";
import { withLocalSession } from "./local-session.js";

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
    workspace: { available: false, reason: "bubblewrap is not installed.", cause: "binary_missing", detail: null },
    "workspace-no-network": { available: false, reason: "bubblewrap is not installed.", cause: "binary_missing", detail: null },
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

  it("drains and exits 0 when the launcher's channel asks it to, having answered its idle query: busy for the idle window after the start (#445)", async () => {
    const cli = harness();
    const exit = runCli(["serve", "--data-dir", join(tempDir(), "data"), "--port", "0"], cli.context);
    await vi.waitFor(() => expect(cli.out()).toMatch(/\n$/), SERVE_WAIT);
    expect(cli.ask({ type: "idle?" })).toEqual({
      type: "idle",
      readiness: "ready",
      activity: { state: "busy", reason: "recent-activity", busyUntil: expect.any(String) as unknown as string },
      updatesManagedOutside: false,
      binding: { tailnet: null, tailnetFound: null, lan: null, lanAddresses: [] },
    });
    expect(cli.ask({ type: "drain?" })).toMatchObject({ type: "draining", trigger: "launcher" });
    expect(await exit).toBe(0);
    expect(cli.close).toHaveBeenCalledOnce();
    expect(cli.err()).toBe("");
  });

  /** Serves `dataDir` with `args` and the variables `env` until ready; the name its discovery reports and the channel its settings hold, then stopped. */
  const servedWith = async (args: readonly string[], env: Readonly<Record<string, string>>) => {
    const cli = harness();
    const dataDir = join(tempDir(), "data");
    const exit = runCli(["serve", "--data-dir", dataDir, "--port", "0", ...args], { ...cli.context, env });
    await vi.waitFor(() => expect(cli.out()).toMatch(/\n$/), SERVE_WAIT);
    const { environmentName } = (await (await fetch(cli.out().trim())).json()) as { environmentName: string };
    const net = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
    const { values } = await withLocalSession({ dataDir }, net, "a test", (call) => call("settings.get", {}));
    cli.stop();
    expect(await exit).toBe(0);
    return { name: environmentName, channel: values["updates.channel"] };
  };

  it("names a new environment and sets its channel from AGENT_HARNESS_NAME and AGENT_HARNESS_CHANNEL, as the compose file passes them (#846)", async () => {
    expect(await servedWith([], { AGENT_HARNESS_NAME: "Build box", AGENT_HARNESS_CHANNEL: "beta" })).toEqual({ name: "Build box", channel: "beta" });
  });

  it("reads each variable blank, as the compose file passes one unset, as not given: the hostname's first label and the preset channel", async () => {
    const { name, channel } = await servedWith([], { AGENT_HARNESS_NAME: "", AGENT_HARNESS_CHANNEL: " " });
    expect(hostname().startsWith(name)).toBe(true);
    expect(channel).toBe("stable");
  });

  it("takes --name over AGENT_HARNESS_NAME", async () => {
    expect(await servedWith(["--name", "cli"], { AGENT_HARNESS_NAME: "Build box" })).toMatchObject({ name: "cli" });
  });

  it("prints its usage and exits 2 on a channel variable that is neither stable nor beta, before starting anything", async () => {
    const cli = harness();
    expect(await runCli(["serve", "--data-dir", join(tempDir(), "data"), "--port", "0"], { ...cli.context, env: { AGENT_HARNESS_CHANNEL: "nightly" } })).toBe(2);
    expect(cli.err()).toContain("AGENT_HARNESS_CHANNEL takes stable or beta; got nightly.");
    expect(cli.err()).toContain("agent-harness serve [--data-dir <path>] [--port <n>] [--name <name>]");
    expect(cli.prepared).not.toHaveBeenCalled();
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

  it.each([undefined, "tailscale0", "tailscale1"])("in a declared container, prints a working pairing link, QR and code with kernel interface %s", async (interfaceName) => {
    const cli = harness({ inContainer: () => true, declared: () => true });
    const tailnetAddress = "100.64.0.9";
    let context = cli.context;
    if (interfaceName !== undefined) {
      const entry: NetworkInterfaceInfo = { address: tailnetAddress, family: "IPv4", internal: false, netmask: "255.192.0.0", cidr: "100.64.0.9/10", mac: "00:00:00:00:00:00" };
      context = { ...cli.context, environment: { ...cli.context.environment, interfaces: tailscaleDetector(async () => undefined, () => ({ [interfaceName]: [entry] })) } };
      // At the OS socket boundary, bind a loopback alias in place of the
      // scripted tailnet address; report the requested address to the environment.
      const listen = Server.prototype.listen;
      const spy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args) {
        const options = args[0];
        if (typeof options === "object" && options !== null && "host" in options && options.host === tailnetAddress) {
          const address = this.address.bind(this);
          vi.spyOn(this, "address").mockImplementation(() => {
            const bound = address();
            return typeof bound === "object" && bound !== null ? { ...bound, address: tailnetAddress } : bound;
          });
          args[0] = { ...options, host: "127.0.0.2" };
        }
        return Reflect.apply(listen, this, args);
      });
      cleanups.push(() => spy.mockRestore());
    }
    const dataDir = join(tempDir(), "data");
    const exit = runCli(["serve", "--data-dir", dataDir, "--port", "0"], context);
    await vi.waitFor(() => expect(cli.out()).toMatch(/Code: .+\n[^]*\n$/), SERVE_WAIT);

    const [address = "", intro, ...pairing] = cli.out().split("\n");
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\.well-known\//);
    expect(intro).toBe(`No client has paired with this environment yet. Pair one with this code, or run agent-harness pair --preset own-client --data-dir ${dataDir} in the container for a new one.`);
    const printed = pairing.join("\n");
    const link = /http:\/\/\S+\/pair#\S+/.exec(printed)?.[0] ?? "";
    const port = new URL(address).port;
    expect(parsePairingLink(link)?.origin).toBe(`http://${interfaceName === undefined ? "127.0.0.1" : tailnetAddress}:${port}`);
    const code = parsePairingLink(link)?.code ?? "";
    expect(printed).toContain(renderUnicodeCompact(link, { border: 2 }));
    expect(printed).toContain(`Code: ${formatPairingCode(code)}`);
    const origin = interfaceName === undefined ? new URL(address).origin : `http://127.0.0.2:${port}`;
    const exchanged = await new Promise<number>((resolve, reject) => {
      const req = request(`${origin}${PAIR_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: new URL(link).host },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ code, kind: "web", label: "phone", protocolVersion: PROTOCOL_VERSION }));
    });
    expect(exchanged).toBe(200);

    cli.stop();
    expect(await exit).toBe(0);
    expect(cli.err()).toBe("");
  });
});
