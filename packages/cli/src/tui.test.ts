import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { BOOTSTRAP_GRANT_FILE, DISCOVERY_PATH, PROTOCOL_VERSION } from "@agent-harness/contracts";
import { defaultDataDirectory, HARNESS_VERSION, ROOT_REFUSAL } from "@agent-harness/environment";
import type { TuiOptions } from "@agent-harness/tui";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { bundledVersion, installContextAt, makeTempDir, stubRunner, type Answer } from "../test/service-helpers.js";
import { runCli, type CliContext } from "./cli.js";
import { selectEnvironment } from "./tui.js";

// The terminal UI is a recorder here, and its screenless entry draws nothing: Ink loaded by anything this file runs fails.
vi.mock("ink", () => {
  throw new Error("The CLI loaded Ink.");
});

/**
 * `agent-harness tui` (docs/specs/tui.md, "The entry point and the
 * platform"): a verb of the same CLI as `serve`, which parses its flags and
 * hands the terminal UI the local environment's data directory, the harness
 * version and the CLI's own `service` verbs (#113), so `y` on the
 * service-down offer runs `service start`, or `service install` then
 * `service start`. The terminal UI itself is a seam here; its own tests
 * render it.
 */

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const tempHome = (): string => {
  const dir = makeTempDir();
  cleanups.push(dir.remove);
  return dir.path;
};

const refused = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
const answering =
  (readiness: string, asked: string[] = []) =>
  (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response(
      JSON.stringify({
        environmentId: "0b6f3c1e-7d5a-4c2b-9e8f-1a2b3c4d5e6f",
        environmentName: "box",
        harnessVersion: HARNESS_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [],
        authPolicy: "local-only",
        readiness,
      }),
    );
  }) as typeof fetch;

/** The CLI in-process on Linux with a temp home and a stubbed service manager, the terminal UI replaced by a recorder. */
const harness = (options: { answer?: Answer; fetch?: typeof fetch; privileged?: boolean; exitCode?: number } = {}) => {
  const home = tempHome();
  const installContext = installContextAt("linux", home);
  const stub = stubRunner(options.answer);
  const launched: TuiOptions[] = [];
  let out = "";
  let err = "";
  const context: Partial<CliContext> = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    fetch: options.fetch ?? refused,
    environment: { user: { isPrivileged: () => options.privileged ?? false } },
    service: { installContext, runner: stub.runner, cliEntry: bundledVersion(home) },
    tui: async (tuiOptions) => {
      launched.push(tuiOptions);
      return options.exitCode ?? 0;
    },
  };
  const run = (...args: string[]) => runCli(args, context);
  /** Runs `tui` and answers what the terminal UI was handed. */
  const launch = async (...args: string[]): Promise<TuiOptions> => {
    const code = await run("tui", ...args);
    expect(code, err).toBe(options.exitCode ?? 0);
    const handed = launched.at(-1);
    if (!handed) throw new Error("tui did not start the terminal UI");
    return handed;
  };
  return { home, installContext, run, launch, launched, calls: stub.calls, out: () => out, err: () => err };
};

const unitPath = (home: string) => join(home, ".config", "systemd", "user", "agent-harness.service");

describe("agent-harness tui", () => {
  it("starts the terminal UI with the local environment's data directory, the harness version and nothing else set", async () => {
    const cli = harness();
    const handed = await cli.launch();
    expect(handed).toMatchObject({ dataDir: defaultDataDirectory(cli.installContext), version: HARNESS_VERSION, continueLatest: false });
    for (const flag of ["environment", "session", "cwd", "keybindings"] as const) expect(handed[flag], flag).toBeUndefined();
    expect(cli.out()).toBe("");
  });

  it("hands over --environment, --session, --cwd and --keybindings, the paths made absolute", async () => {
    const handed = await harness().launch(
      "--environment",
      "laptop",
      "--session",
      "0199aa00-0000-4000-8000-000000000001",
      "--cwd",
      "code/brandsolidate",
      "--keybindings",
      "keys.json",
    );
    expect(handed).toMatchObject({
      environment: "laptop",
      session: "0199aa00-0000-4000-8000-000000000001",
      cwd: resolve("code/brandsolidate"),
      keybindings: resolve("keys.json"),
      continueLatest: false,
    });
  });

  it("takes -c, and --continue, for the newest session whose workspace is the current directory", async () => {
    expect(await harness().launch("-c")).toMatchObject({ continueLatest: true });
    expect(await harness().launch("--continue")).toMatchObject({ continueLatest: true });
  });

  it("exits with the terminal UI's exit code", async () => {
    const cli = harness({ exitCode: 1 });
    expect(await cli.run("tui")).toBe(1);
  });

  it("prints its usage and exits 2 on arguments it cannot parse, and carries neither -p nor ls", async () => {
    for (const args of [
      ["tui", "-p", "hello"],
      ["tui", "ls"],
      ["tui", "--session"],
      ["tui", "--environment", ""],
      ["tui", "--session", "0199aa00-0000-4000-8000-000000000001", "-c"],
      ["tui", "--no-such-flag"],
      ["tui", "--data-dir", "other"],
    ]) {
      const cli = harness();
      expect(await cli.run(...args), args.join(" ")).toBe(2);
      expect(cli.err(), args.join(" ")).toContain(
        "agent-harness tui [--environment <name or id>] [--session <id> | -c] [--cwd <path>] [--keybindings <file>]",
      );
      expect(cli.launched).toEqual([]);
    }
  });
});

describe("the service verbs agent-harness tui hands the terminal UI", () => {
  it("says whether a service is installed", async () => {
    const cli = harness();
    const { services } = await cli.launch();
    expect(await services.installed()).toBe(false);
    expect(await cli.run("service", "install")).toBe(0);
    expect(await services.installed()).toBe(true);
  });

  it("starts the installed service with the service start verb, which the service manager records", async () => {
    const cli = harness();
    expect(await cli.run("service", "install")).toBe(0);
    const { services } = await cli.launch();
    const before = { calls: cli.calls.length, out: cli.out() };
    const outcome = await services.start();
    expect(outcome).toEqual({ ok: true, message: expect.stringContaining("Started.") });
    expect(cli.calls.slice(before.calls)).toEqual(["systemctl --user start agent-harness.service"]);
    // What the verb prints goes to the terminal UI's line, never over its screen.
    expect(cli.out()).toBe(before.out);
  });

  it("installs the service with the service install verb, into the data directory the terminal UI reads", async () => {
    const cli = harness();
    const { services, dataDir } = await cli.launch();
    expect(await services.install()).toMatchObject({ ok: true });
    expect(existsSync(unitPath(cli.home))).toBe(true);
    expect(readFileSync(unitPath(cli.home), "utf8")).toContain(`ExecStart=/bin/sh ${join(dataDir, "launcher-entry.sh")}\n`);
    expect(existsSync(join(dataDir, "service.json"))).toBe(true);
    expect(cli.calls).toContain("systemctl --user enable agent-harness.service");
  });

  it("answers a start with no service installed with the verb's sentence", async () => {
    const cli = harness();
    const { services } = await cli.launch();
    expect(await services.start()).toEqual({ ok: false, message: "No service is installed. `agent-harness service install` installs it." });
    expect(cli.calls).not.toContain("systemctl --user start agent-harness.service");
  });

  it("answers a service manager that refuses with what it said", async () => {
    const cli = harness({
      answer: (_, args) => (args[1] === "start" ? { code: 1, stderr: "Failed to connect to bus: No medium found" } : undefined),
    });
    expect(await cli.run("service", "install")).toBe(0);
    const { services } = await cli.launch();
    expect(await services.start()).toEqual({
      ok: false,
      message: "systemctl --user start agent-harness.service exited 1: Failed to connect to bus: No medium found",
    });
    expect(cli.err()).toBe("");
  });

  it("refuses to start or install as root, as the verbs do", async () => {
    const cli = harness({ privileged: true });
    const { services } = await cli.launch();
    expect(await services.start()).toEqual({ ok: false, message: ROOT_REFUSAL });
    expect(await services.install()).toEqual({ ok: false, message: ROOT_REFUSAL });
    expect(cli.calls).toEqual([]);
  });

  it("reads the environment's readiness from discovery on the port the service was installed on", async () => {
    const asked: string[] = [];
    const cli = harness({ fetch: answering("starting", asked) });
    expect(await cli.run("service", "install", "--port", "7501")).toBe(0);
    const { services } = await cli.launch();
    expect(await services.readiness()).toBe("starting");
    expect(asked).toEqual([`http://127.0.0.1:7501${DISCOVERY_PATH}`]);
  });

  it("reads nothing when nothing answers", async () => {
    const { services } = await harness().launch();
    expect(await services.readiness()).toBe("nothing");
  });
});

/** A loopback port nothing listens on: one the system handed out, closed again. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { readonly port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
};

describe("the environment agent-harness tui would show, chosen without a screen", () => {
  it("is chosen on the data directory tui hands over, with no terminal, and refused in one line when there is none to use", async () => {
    const cli = harness();
    // The terminal UI's own state directory, under the test's home rather than the user's.
    vi.stubEnv("AGENT_HARNESS_TUI_STATE_DIR", join(cli.home, "tui-state"));
    onTestFinished(() => void vi.unstubAllEnvs());
    const faults: string[] = [];
    const context = { seams: { installContext: cli.installContext }, report: (line: string) => void faults.push(line) };

    expect(await selectEnvironment({}, context)).toMatchObject({ ok: false, reason: "none" });

    // The local environment's grant file, where `tui` reads it, names a port nothing listens on: it is not running.
    const dataDir = defaultDataDirectory(cli.installContext);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, BOOTSTRAP_GRANT_FILE), JSON.stringify({ secret: "secret-for-tests", address: { host: "127.0.0.1", port: await closedPort() } }));
    expect(await selectEnvironment({ cwd: "/srv/notes" }, context)).toEqual({
      ok: false,
      reason: "unreachable",
      message: "The environment on this machine is not running. `agent-harness service start` starts it.",
    });
    expect(existsSync(join(cli.home, "tui-state"))).toBe(true);
    expect(faults).toEqual([]);
    expect(cli.out()).toBe("");
  });
});
