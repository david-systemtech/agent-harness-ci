import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { join, resolve } from "node:path";
import { BOOTSTRAP_GRANT_FILE, DISCOVERY_PATH, PROTOCOL_VERSION } from "@agent-harness/contracts";
import { defaultDataDirectory, HARNESS_VERSION, ROOT_REFUSAL } from "@agent-harness/environment";
import type { TuiOptions } from "@agent-harness/tui";
import * as screenless from "@agent-harness/tui/screenless";
import { chunkOf, fakeCompletions, listed } from "../../tui/test/fake-completions.js";
import { machine, noneOpen, openSockets } from "../../tui/test/machine.js";
import { selectOn } from "../../tui/src/startup/selection.js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { bundledVersion, installContextAt, makeTempDir, stubRunner, type Answer } from "../test/service-helpers.js";
import { runCli, type CliContext } from "./cli.js";
import { outputClosedOn } from "./process-context.js";
import { selectEnvironment, TUI_USAGE } from "./tui.js";

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
const harness = (options: { answer?: Answer; fetch?: typeof fetch; privileged?: boolean; exitCode?: number; env?: Record<string, string> } = {}) => {
  const home = tempHome();
  const installContext = installContextAt("linux", home, options.env);
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
  return { home, installContext, context, run, launch, launched, calls: stub.calls, out: () => out, err: () => err };
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

  it("starts the terminal UI on the image's /data in a container the install declared, where serve keeps the grant, not the image user's XDG state (#1725)", async () => {
    const cli = harness({ env: { AGENT_HARNESS_CONTAINER: "1" } });
    expect((await cli.launch()).dataDir).toBe("/data");
  });

  it("hands over --environment, --session, --cwd and --keybindings, the paths made absolute", async () => {
    const handed = await harness().launch(
      "--environment",
      "laptop",
      "--session",
      "0199aa00-0000-4000-8000-000000000001",
      "--cwd",
      "code/meadowstudios",
      "--keybindings",
      "keys.json",
    );
    expect(handed).toMatchObject({
      environment: "laptop",
      session: "0199aa00-0000-4000-8000-000000000001",
      cwd: resolve("code/meadowstudios"),
      keybindings: resolve("keys.json"),
      continueLatest: false,
    });
  });

  it("accepts --import-terminal-state and supplies the local source reader only on request", async () => {
    expect((await harness().launch()).terminalSource).toBeUndefined();
    expect((await harness().launch("--import-terminal-state")).terminalSource).toBeTypeOf("function");
  });

  it("takes -c, and --continue, for the newest session whose workspace is the current directory", async () => {
    expect(await harness().launch("-c")).toMatchObject({ continueLatest: true });
    expect(await harness().launch("--continue")).toMatchObject({ continueLatest: true });
  });

  it("exits with the terminal UI's exit code", async () => {
    const cli = harness({ exitCode: 1 });
    expect(await cli.run("tui")).toBe(1);
  });

  it("prints its usage and exits 2 on arguments it cannot parse, and carries no ls", async () => {
    for (const args of [
      ["tui", "ls"],
      ["tui", "--session"],
      ["tui", "--environment", ""],
      ["tui", "--session", "0199aa00-0000-4000-8000-000000000001", "-c"],
      ["tui", "--no-such-flag"],
      ["tui", "--data-dir", "other"],
    ]) {
      const cli = harness();
      expect(await cli.run(...args), args.join(" ")).toBe(2);
      expect(cli.err(), args.join(" ")).toContain(TUI_USAGE);
      expect(cli.launched).toEqual([]);
    }
  });
});

describe("agent-harness tui -p", () => {
  /** The CLI as `harness` makes it, with no signal and no closing of standard output to hear, and the terminal UI's state under its home. */
  const printing = () => {
    const cli = harness();
    vi.stubEnv("AGENT_HARNESS_TUI_STATE_DIR", join(cli.home, "tui-state"));
    onTestFinished(() => void vi.unstubAllEnvs());
    const never = () => new Promise<never>(() => undefined);
    const run = (...args: string[]) => runCli(["tui", ...args], { ...cli.context, stopRequested: never, outputClosed: never });
    return { ...cli, run };
  };

  /** CLI argv and output over the selection seam, with the selected Environment answering on the typed wire. */
  const onEnvironment = async (reach: "local" | "paired", directory: string) => {
    const cli = printing();
    const account = { id: "account-1", label: "Work" };
    const on = await machine({ environments: [{
      name: "laptop", reach,
      environmentId: "0199aa00-0000-7000-8000-0000000014a7",
      accounts: [{ ...account, identity: { provider: "claude", email: "milo@work.test", organisation: null } }],
      models: [{ accountId: account.id, live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: [], label: "Opus 5" }] }],
      sessions: [{ workspace: { kind: "directory", path: directory } }],
    }] });
    const selection = vi.spyOn(screenless, "selectTerminalEnvironment").mockImplementation((options) =>
      selectOn(on.platform, { ...options, currentDirectory: process.cwd() }));
    onTestFinished(() => selection.mockRestore());
    const environment = on.world.environment("laptop");
    const http = fakeCompletions(environment.wire.origin, [listed("work", "claude-opus-5", "opus", 3, account)]);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = http.fetch(input, init);
      if (init?.method === "POST") {
        const answer = (await http.turn()).open();
        answer.chunk(chunkOf(1, { finish: "stop", ext: { ended: { reason: "completed", cause: null } } }));
        answer.done();
      }
      return response;
    };
    const never = () => new Promise<never>(() => undefined);
    const run = (...args: string[]) => runCli(["tui", "-p", "Say hello", ...args], { ...cli.context, fetch, stopRequested: never, outputClosed: never });
    return { ...cli, run, on, http, environment };
  };

  it.each([
    "/srv/Code/../Code/",
    String.raw`C:\Users\Milo\Code`,
    "C:/Users/Milo/Code/",
    String.raw`\\server\share\Milo\Code/`,
  ])("keeps the paired directory %s intact for a new workspace and -c matching", async (directory) => {
    for (const selectors of [[], ["--environment", "laptop", "-c"]]) {
      const cli = await onEnvironment("paired", directory);
      expect(await cli.run(...selectors, "--cwd", directory), cli.err()).toBe(0);
      expect(cli.http.sent().find((request) => request.method === "POST")?.body?.["agent-harness"]).toEqual(
        selectors.length === 0 ? { workspace: directory, attended: false } : { sessionId: cli.environment.sessionId(0), attended: false },
      );
      expect(cli.err()).toBe("");
      expect(openSockets(cli.on)).toEqual(noneOpen(cli.on));
    }
  });

  it.each(["code", "code/../code/", join(process.cwd(), "code")])("resolves the local directory %s for a new workspace and -c matching", async (directory) => {
    for (const selectors of [[], ["--environment", "laptop", "-c"]]) {
      const absolute = join(process.cwd(), "code");
      const cli = await onEnvironment("local", absolute);
      expect(await cli.run(...selectors, "--cwd", directory), cli.err()).toBe(0);
      expect(cli.http.sent().find((request) => request.method === "POST")?.body?.["agent-harness"]).toEqual(
        selectors.length === 0 ? { workspace: absolute, attended: false } : { sessionId: cli.environment.sessionId(0), attended: false },
      );
      expect(cli.err()).toBe("");
      expect(openSockets(cli.on)).toEqual(noneOpen(cli.on));
    }
  });

  it.each(["code", "~", "C:code", String.raw`\code`])("refuses the paired relative directory %s with exit 2 and one line before sending a turn", async (directory) => {
    for (const selectors of [[], ["--environment", "laptop", "-c"]]) {
      for (const format of ["text", "json", "stream-json"]) {
        const cli = await onEnvironment("paired", "/srv/code");
        const message = `--cwd names a directory on laptop by its absolute path there; got ${directory}.`;
        expect(await cli.run(...selectors, "--cwd", directory, "--output-format", format)).toBe(2);
        expect(cli.err()).toBe(`${message}\n`);
        if (format === "text") expect(cli.out()).toBe("");
        else {
          expect(cli.out().trim().split("\n")).toHaveLength(1);
          expect(JSON.parse(cli.out())).toMatchObject({ type: "result", environmentId: "0199aa00-0000-7000-8000-0000000014a7", sessionId: null, runId: null, text: "", reason: "error", error: message });
        }
        expect(cli.http.sent()).toEqual([]);
        expect(openSockets(cli.on)).toEqual(noneOpen(cli.on));
      }
    }
  });

  it("prints on the environment tui would choose, in the format asked for, and says why there is none, the screen never loaded", async () => {
    const cli = printing();
    const message = "No environment is known here: `agent-harness service install` sets up this machine's, and `/pair` in `agent-harness tui` adds another.";

    expect(await cli.run("-p", "Say hello", "--output-format", "json")).toBe(1);
    expect(JSON.parse(cli.out())).toEqual({
      type: "result",
      environmentId: null,
      sessionId: null,
      runId: null,
      text: "",
      usage: null,
      durationMs: expect.any(Number),
      reason: "error",
      error: message,
    });
    expect(cli.err()).toBe(`${message}\n`);
    expect(cli.launched).toEqual([]);
  });

  it("exits 2 on a print it cannot make, before choosing anything, with a JSON result when the format asked for one", async () => {
    for (const [args, said] of [
      [["--print", ""], "-p takes the prompt; got an empty one."],
      [["-p", "  "], "-p takes the prompt; got an empty one."],
      [["-p", "hi", "--output-format", "yaml"], "--output-format takes text, json or stream-json; got yaml."],
      [["-p", "hi", "--mode", "yolo"], "--mode takes plan, acceptEdits, auto or bypassPermissions; got yolo."],
      [["-p", "hi", "--session", "0199aa00-0000-4000-8000-000000000001", "-c"], "--session and -c each name the session to open; give one."],
      [["-p", "hi", "--session", "0199aa00-0000-4000-8000-000000000001", "--cwd", "/srv"], "--cwd names a new session's directory, or the one -c looks in; --session continues a session in its own."],
      [["-p", "hi", "--keybindings", "keys.json"], "--keybindings is the screen's; -p draws none."],
      [["-p", "hi", "--import-terminal-state"], "--import-terminal-state is the screen's; -p draws none."],
      [["--model", "opus"], "--model, --mode, --effort and --output-format go with -p."],
      [["--output-format", "json"], "--model, --mode, --effort and --output-format go with -p."],
      [["-p", "hi", "--model", ""], "--model takes a value; got an empty one."],
    ] as const) {
      const cli = printing();
      expect(await cli.run(...args), args.join(" ")).toBe(2);
      expect(cli.err().split("\n")[0], args.join(" ")).toBe(said);
      expect(cli.err(), args.join(" ")).toContain(TUI_USAGE);
      expect(cli.out(), args.join(" ")).toBe("");
      expect(cli.launched).toEqual([]);
    }

    const json = printing();
    expect(await json.run("-p", "", "--output-format", "stream-json")).toBe(2);
    expect(JSON.parse(json.out())).toMatchObject({ type: "result", environmentId: null, text: "", usage: null, reason: "error", error: "-p takes the prompt; got an empty one." });
  });
});

describe("standard output closing", () => {
  it("is heard as the stream's error, a closed pipe's or any other", async () => {
    const stream = new PassThrough();
    const closed = outputClosedOn(stream);
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await expect(closed).resolves.toBeUndefined();
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
