import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { DISCOVERY_PATH, PROTOCOL_VERSION } from "@agent-harness/contracts";
import { defaultDataDirectory, HARNESS_VERSION, ROOT_REFUSAL } from "@agent-harness/environment";
import { afterEach, describe, expect, it } from "vitest";
import { bundledVersion, installContextAt, makeTempDir, snapshot, stubRunner, tree, type Answer } from "../../test/service-helpers.js";
import { runCli, type CliContext } from "../cli.js";
import { writeServiceState } from "../launch/state.js";
import { CommandTimeoutError, STOP_COMMAND_TIMEOUT_MS } from "./runner.js";

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
const discovery = (readiness: string) =>
  new Response(
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
const answering = (readiness: string) => (async () => discovery(readiness)) as typeof fetch;

/** The CLI in-process on `platform`, with a temp home, a stubbed runner and fetch, as an ordinary user unless told. */
const harness = (
  platform: NodeJS.Platform,
  options: { home?: string; answer?: Answer; fetch?: typeof fetch; privileged?: boolean; env?: Record<string, string> } = {},
) => {
  const home = options.home ?? tempHome();
  const stub = stubRunner(options.answer);
  let out = "";
  let err = "";
  const context: Partial<CliContext> = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    fetch: options.fetch ?? refused,
    environment: { user: { isPrivileged: () => options.privileged ?? false } },
    service: { installContext: installContextAt(platform, home, options.env), runner: stub.runner, cliEntry: bundledVersion(home) },
  };
  const run = (...args: string[]) => runCli(args, context);
  return { home, run, calls: stub.calls, out: () => out, err: () => err };
};

const unitPath = (home: string) => join(home, ".config", "systemd", "user", "agent-harness.service");

/** What the service managers say of a service that runs, and of one that does not (launchd: not loaded). */
const running: Answer = (_, args) => (args[0] === "print" ? { stdout: "gui/501/agent-harness = {\n\tstate = running\n}\n" } : undefined);
const stopped: Answer = (_, args) => (args[0] === "print" ? { code: 113 } : args.includes("is-active") ? { code: 3, stdout: "inactive\n" } : undefined);
/** Whether a command stops the service, waiting while it drains. */
const stopsTheService = (args: readonly string[]) => args.includes("--now") || args[0] === "bootout";

const DRAIN_NOTICE = "Stopping the service, waiting up to 30 minutes for any running runs to finish.\n";
const plistPath = (home: string) => join(home, "Library", "LaunchAgents", "agent-harness.plist");

/** The paths under `home` that are neither inside `dataDir` nor one of its ancestors. */
const outsideDataDir = (home: string, paths: string[], dataDir: string): string[] => {
  const inData = relative(home, dataDir);
  return paths.filter((path) => path !== inData && !path.startsWith(inData + sep) && !inData.startsWith(path + sep));
};

/** `path` relative to `home`, and each of its ancestors below `home`. */
const withAncestors = (home: string, path: string): string[] => {
  const parts = relative(home, path).split(sep);
  return parts.map((_, i) => parts.slice(0, i + 1).join(sep));
};

describe.each([
  ["linux", unitPath],
  ["darwin", plistPath],
] as const)("agent-harness service install on %s", (platform, definition) => {
  it("writes the service definition and nothing else outside the data directory", async () => {
    const cli = harness(platform, { answer: (_, args) => (args[0] === "print" ? { code: 113 } : undefined) });
    const before = tree(cli.home);

    expect(await cli.run("service", "install")).toBe(0);

    const dataDir = defaultDataDirectory(installContextAt(platform, cli.home));
    const added = tree(cli.home).filter((path) => !before.includes(path));
    expect(outsideDataDir(cli.home, added, dataDir).sort()).toEqual(
      outsideDataDir(cli.home, withAncestors(cli.home, definition(cli.home)), dataDir).sort(),
    );
    expect(added).toContain(join(relative(cli.home, dataDir), "logs"));
    expect(readFileSync(definition(cli.home), "utf8")).toContain(join(dataDir, "launcher-entry.sh"));
    expect(cli.out()).toContain(definition(cli.home));
    expect(cli.err()).toBe("");
  });

  it("uninstall leaves the home as it was before install, but for the versions, the service state and the launcher version file", async () => {
    const cli = harness(platform, { answer: (_, args) => (args[0] === "print" ? { code: 113 } : undefined) });
    writeFileSync(join(cli.home, ".profile"), "export PATH\n");
    const before = snapshot(cli.home);
    expect(await cli.run("service", "install")).toBe(0);
    expect(existsSync(definition(cli.home))).toBe(true);
    expect(await cli.run("service", "uninstall")).toBe(0);
    const dataDir = relative(cli.home, defaultDataDirectory(installContextAt(platform, cli.home)));
    const after = snapshot(cli.home);
    for (const [path, content] of Object.entries(before)) expect(after[path], path).toBe(content);
    const kept = (path: string) =>
      dataDir === path ||
      dataDir.startsWith(path + sep) ||
      path.startsWith(join(dataDir, "versions")) ||
      path === join(dataDir, "service-state.json") ||
      path === join(dataDir, "launcher-version");
    expect(Object.keys(after).filter((path) => !(path in before) && !kept(path))).toEqual([]);
    expect(Object.keys(after)).toContain(join(dataDir, "versions", "0.5.0", ".complete"));
  });

  it("uninstall keeps the data directory, and the folders above the definition, when something else lives in them", async () => {
    const cli = harness(platform, { answer: (_, args) => (args[0] === "print" ? { code: 113 } : undefined) });
    expect(await cli.run("service", "install")).toBe(0);
    const dataDir = defaultDataDirectory(installContextAt(platform, cli.home));
    writeFileSync(join(dataDir, "logs", "service.log"), "http://127.0.0.1:7433\n");
    writeFileSync(join(dirname(definition(cli.home)), "other"), "");
    expect(await cli.run("service", "uninstall")).toBe(0);
    expect(existsSync(definition(cli.home))).toBe(false);
    expect(existsSync(join(dataDir, "service.json"))).toBe(false);
    expect(readFileSync(join(dataDir, "logs", "service.log"), "utf8")).toBe("http://127.0.0.1:7433\n");
    expect(existsSync(join(dirname(definition(cli.home)), "other"))).toBe(true);
  });
});

describe("agent-harness service install", () => {
  it("records the platform, the definition, the port, the launcher entry and the folders it created in the data directory's service.json", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "install", "--port", "7500")).toBe(0);
    const dataDir = join(cli.home, ".local", "state", "agent-harness");
    expect(JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8"))).toEqual({
      platform: "systemd",
      definitionPath: unitPath(cli.home),
      port: 7500,
      launcherEntry: join(dataDir, "launcher-entry.sh"),
      createdDirectories: [
        join(cli.home, ".config"),
        join(cli.home, ".config", "systemd"),
        join(cli.home, ".config", "systemd", "user"),
        join(cli.home, ".local"),
        join(cli.home, ".local", "state"),
        dataDir,
        join(dataDir, "logs"),
        join(dataDir, "bin"),
      ],
    });
  });

  it("keeps the folders an earlier install created in the record when it installs again", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "install")).toBe(0);
    const record = join(cli.home, ".local", "state", "agent-harness", "service.json");
    const first = JSON.parse(readFileSync(record, "utf8")) as { createdDirectories: string[] };
    expect(await cli.run("service", "install", "--port", "7501")).toBe(0);
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ port: 7501, createdDirectories: first.createdDirectories });
  });

  it("leaves the home as it was when the service manager refuses the definition", async () => {
    const cli = harness("linux", { answer: (_, args) => (args.includes("enable") ? { code: 1, stderr: "Access denied" } : undefined) });
    const before = snapshot(cli.home);
    expect(await cli.run("service", "install")).toBe(1);
    expect(snapshot(cli.home)).toEqual(before);
  });

  it("runs the launcher entry in an absolute data directory, which passes launch the port given", async () => {
    const cli = harness("linux");
    // A relative --data-dir resolves against the working directory; point it into the temp home so nothing lands in the checkout.
    const dataDir = join(cli.home, "relative", "data");
    expect(await cli.run("service", "install", "--data-dir", relative(process.cwd(), dataDir), "--port", "7500")).toBe(0);
    const execStart = readFileSync(unitPath(cli.home), "utf8")
      .split("\n")
      .find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBe(`ExecStart=/bin/sh ${join(dataDir, "launcher-entry.sh")}`);
    expect(readFileSync(join(dataDir, "launcher-entry.sh"), "utf8")).toContain(` launch --data-dir "$data_dir" --port 7500\n`);
  });

  it("uses the default data directory and port when none is given", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "install")).toBe(0);
    const dataDir = join(cli.home, ".local", "state", "agent-harness");
    expect(readFileSync(unitPath(cli.home), "utf8")).toContain(`ExecStart=/bin/sh ${join(dataDir, "launcher-entry.sh")}\n`);
    expect(readFileSync(join(dataDir, "launcher-entry.sh"), "utf8")).toContain(" --port 7433\n");
  });

  it("refuses a privileged user before writing or running anything", async () => {
    const cli = harness("linux", { privileged: true });
    const before = tree(cli.home);
    expect(await cli.run("service", "install")).toBe(1);
    expect(cli.err()).toBe(`${ROOT_REFUSAL}\n`);
    expect(tree(cli.home)).toEqual(before);
    expect(cli.calls).toEqual([]);
  });

  it("prints what the service manager said and exits 1 when it refuses", async () => {
    const cli = harness("linux", {
      answer: (_, args) => (args.includes("daemon-reload") ? { code: 1, stderr: "Failed to connect to bus: No medium found" } : undefined),
    });
    expect(await cli.run("service", "install")).toBe(1);
    expect(cli.err()).toContain("Failed to connect to bus: No medium found");
    expect(existsSync(unitPath(cli.home))).toBe(false);
  });

  it("says in one sentence that it cannot install on an unsupported platform", async () => {
    const cli = harness("freebsd");
    expect(await cli.run("service", "install")).toBe(1);
    expect(cli.err()).toMatch(/^.*macOS.*Linux.*Windows.*\n$/);
  });
});

describe("agent-harness service uninstall", () => {
  it("says there is nothing to remove, runs nothing and exits 0 when no service is installed", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "uninstall")).toBe(0);
    expect(cli.out()).toBe("No service is installed.\n");
    expect(cli.calls).toEqual([]);
  });

  it.each(["linux", "darwin"] as const)(
    "on %s says, before it stops a running service, that it waits up to 30 minutes for running runs to finish",
    async (platform) => {
      const home = tempHome();
      expect(await harness(platform, { home, answer: stopped }).run("service", "install")).toBe(0);
      let saidBeforeTheStop: string | undefined;
      const cli = harness(platform, {
        home,
        answer: (command, args) => {
          if (stopsTheService(args)) saidBeforeTheStop = cli.out();
          return running(command, args);
        },
      });

      expect(await cli.run("service", "uninstall")).toBe(0);

      expect(saidBeforeTheStop).toBe(DRAIN_NOTICE);
      expect(cli.out().startsWith(`${DRAIN_NOTICE}Removed `)).toBe(true);
    },
  );

  it("says nothing of a wait when the service is not running", async () => {
    const home = tempHome();
    expect(await harness("linux", { home, answer: stopped }).run("service", "install")).toBe(0);
    const cli = harness("linux", { home, answer: stopped });

    expect(await cli.run("service", "uninstall")).toBe(0);

    expect(cli.out()).toMatch(/^Removed /);
  });

  it("says nothing of a wait on Windows, where Task Scheduler ends a running task without a drain", async () => {
    const home = tempHome();
    const cli = harness("win32", { home, answer: (_, args) => (args.includes("CSV") ? { stdout: '"\\agent-harness","N/A","Running"\r\n' } : undefined) });

    // Named, since the default is a Windows path this POSIX runner cannot write to.
    expect(await cli.run("service", "uninstall", "--data-dir", join(home, "data"))).toBe(0);

    expect(cli.calls.some((call) => call.startsWith("powershell.exe "))).toBe(true);
    expect(cli.out()).toMatch(/^Removed /);
  });

  it("says in one sentence, and exits 1, when the stop outlives even the wait it was given", async () => {
    const home = tempHome();
    expect(await harness("linux", { home, answer: stopped }).run("service", "install")).toBe(0);
    const cli = harness("linux", {
      home,
      answer: (_, args) => {
        if (stopsTheService(args)) throw new CommandTimeoutError(STOP_COMMAND_TIMEOUT_MS);
        return undefined;
      },
    });

    expect(await cli.run("service", "uninstall")).toBe(1);

    expect(cli.err()).toBe(
      "systemctl --user disable --now agent-harness.service did not finish within 32 minutes, so the service may still be stopping: " +
        "`agent-harness service status` says whether it still runs.\n",
    );
  });
});

describe("agent-harness service start", () => {
  it("starts the installed service", async () => {
    const cli = harness("linux");
    await cli.run("service", "install");
    cli.calls.length = 0;
    expect(await cli.run("service", "start")).toBe(0);
    expect(cli.calls).toEqual(["systemctl --user start agent-harness.service"]);
    expect(cli.out()).toContain("agent-harness service status");
  });

  it("refuses with a sentence and exits 1 when no service is installed", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "start")).toBe(1);
    expect(cli.err()).toBe("No service is installed. `agent-harness service install` installs it.\n");
    expect(cli.calls).toEqual([]);
  });

  it("refuses a privileged user", async () => {
    const cli = harness("linux", { privileged: true });
    expect(await cli.run("service", "start")).toBe(1);
    expect(cli.err()).toBe(`${ROOT_REFUSAL}\n`);
    expect(cli.calls).toEqual([]);
  });
});

describe("agent-harness service stop (#1712)", () => {
  const active: Answer = (_, args) => (args.includes("is-active") ? { stdout: "active\n" } : undefined);

  it("stops the installed service, saying it waits for running runs where the stop drains them, and leaves it installed", async () => {
    const home = tempHome();
    expect(await harness("linux", { home, answer: stopped }).run("service", "install")).toBe(0);
    const cli = harness("linux", { home, answer: active });
    expect(await cli.run("service", "stop")).toBe(0);
    expect(cli.calls).toEqual(["systemctl --user is-active agent-harness.service", "systemctl --user stop agent-harness.service"]);
    expect(cli.out()).toBe(`${DRAIN_NOTICE}Stopped. It starts again at your next logon; \`agent-harness service start\` starts it now.\n`);
    expect(existsSync(unitPath(home))).toBe(true);
  });

  it("stops the logon task's whole process tree on Windows, where End alone leaves the launcher running, without a word of a wait", async () => {
    const cli = harness("win32", { answer: (_, args) => (args.includes("CSV") ? { stdout: '"\\agent-harness","N/A","Running"\r\n' } : undefined) });
    expect(await cli.run("service", "stop")).toBe(0);
    const stops = cli.calls.filter((call) => call.startsWith("powershell.exe "));
    expect(stops).toHaveLength(1);
    expect(Buffer.from(stops[0]?.split(" ").at(-1) ?? "", "base64").toString("utf16le")).toMatch(/^\$disableTask = \$false\n/);
    expect(cli.calls.some((call) => call.includes("/Delete") || call.includes("/End"))).toBe(false);
    expect(cli.out()).toBe("Stopped. It starts again at your next logon; `agent-harness service start` starts it now.\n");
  });

  it("refuses with a sentence and exits 1 when no service is installed", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "stop")).toBe(1);
    expect(cli.err()).toBe("No service is installed. `agent-harness service install` installs it.\n");
    expect(cli.calls).toEqual([]);
  });

  it("refuses a privileged user", async () => {
    const cli = harness("linux", { privileged: true });
    expect(await cli.run("service", "stop")).toBe(1);
    expect(cli.err()).toBe(`${ROOT_REFUSAL}\n`);
    expect(cli.calls).toEqual([]);
  });
});

describe("agent-harness service status", () => {
  const active: Answer = (command, args) =>
    args.includes("is-active") ? { stdout: "active\n" } : command === "loginctl" ? { stdout: "yes\n" } : undefined;

  it("reports installed, running and ready, and exits 0, when all three hold", async () => {
    const cli = harness("linux", { answer: active, fetch: answering("ready") });
    await cli.run("service", "install");
    expect(await cli.run("service", "status")).toBe(0);
    expect(cli.out()).toContain(
      [
        `Installed: yes (${unitPath(cli.home)})`,
        "Running: yes",
        "Ready: yes",
        "Active version: 0.5.0",
        "Launcher version: 0.5.0",
        "Pending update: none",
        "The service is running and the environment at http://127.0.0.1:7433 is ready.",
        "",
      ].join("\n"),
    );
  });

  it("reads the active and launcher versions and a pending update from the service state", async () => {
    const cli = harness("linux", { answer: active, fetch: answering("ready") });
    await cli.run("service", "install");
    const dataDir = join(cli.home, ".local", "state", "agent-harness");
    const pendingUpdate = { updateId: "5b1f3c1e-7d5a-4c2b-9e8f-1a2b3c4d5e6f", fromVersion: "0.5.0", toVersion: "0.6.0" };
    writeServiceState(dataDir, {
      activeVersion: "0.5.0",
      previousVersion: "0.4.0",
      launcherVersion: "0.4.0",
      pendingUpdate,
      watchDeadline: null,
      watchedUpdateId: null,
      stagedVersion: null,
      failedHandover: null,
    });
    expect(await cli.run("service", "status")).toBe(0);
    expect(cli.out()).toContain(
      ["Active version: 0.5.0", "Launcher version: 0.4.0", "Pending update: 0.5.0 to 0.6.0 (update 5b1f3c1e-7d5a-4c2b-9e8f-1a2b3c4d5e6f)", ""].join("\n"),
    );
    expect(await cli.run("service", "status", "--json")).toBe(0);
    const json = cli.out().slice(cli.out().lastIndexOf("\n{\n") + 1);
    expect(JSON.parse(json)).toMatchObject({ activeVersion: "0.5.0", launcherVersion: "0.4.0", pendingUpdate, failedHandover: null, serviceStateProblem: null });
  });

  it("names the running launcher's version and a handover that failed, which the launcher recorded in the service state", async () => {
    const cli = harness("linux", { answer: active, fetch: answering("ready") });
    await cli.run("service", "install");
    const dataDir = join(cli.home, ".local", "state", "agent-harness");
    const failedHandover = { toVersion: "0.6.0", at: "2026-09-28T12:30:00.000Z" };
    writeServiceState(dataDir, {
      activeVersion: "0.6.0",
      previousVersion: "0.5.0",
      launcherVersion: "0.5.0",
      pendingUpdate: null,
      watchDeadline: null,
      watchedUpdateId: null,
      stagedVersion: null,
      failedHandover,
    });
    expect(await cli.run("service", "status")).toBe(0);
    expect(cli.out()).toContain(
      [
        "Active version: 0.6.0",
        "Launcher version: 0.5.0",
        "Failed handover: to the launcher of 0.6.0 at 2026-09-28T12:30:00.000Z, so the launcher of 0.5.0 runs on",
        "Pending update: none",
        "",
      ].join("\n"),
    );
    expect(await cli.run("service", "status", "--json")).toBe(0);
    const json = cli.out().slice(cli.out().lastIndexOf("\n{\n") + 1);
    expect(JSON.parse(json)).toMatchObject({ activeVersion: "0.6.0", launcherVersion: "0.5.0", failedHandover });
  });

  it("says why the versions are unknown when the service is installed with no service state it can use", async () => {
    const cli = harness("linux", { answer: active, fetch: answering("ready") });
    await cli.run("service", "install");
    const state = join(cli.home, ".local", "state", "agent-harness", "service-state.json");
    writeFileSync(state, "{ not json");
    await cli.run("service", "status");
    expect(cli.out()).toContain(`Versions: unknown (the service state at ${state} is not valid: it is not JSON)\n`);
    expect(await cli.run("service", "status", "--json")).toBe(0);
    const json = cli.out().slice(cli.out().lastIndexOf("\n{\n") + 1);
    expect(JSON.parse(json)).toMatchObject({ activeVersion: null, launcherVersion: null, pendingUpdate: null, serviceStateProblem: expect.stringContaining("not JSON") });
  });

  it("says that a service from before the launcher runs serve directly and moves to the launcher with one install", async () => {
    const cli = harness("linux", { answer: active, fetch: answering("ready") });
    const dataDir = join(cli.home, ".local", "state", "agent-harness");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(dirname(unitPath(cli.home)), { recursive: true });
    writeFileSync(unitPath(cli.home), "[Service]\nExecStart=/usr/bin/node /opt/agent-harness/dist/main.js serve\n");
    writeFileSync(join(dataDir, "service.json"), JSON.stringify({ platform: "systemd", definitionPath: unitPath(cli.home), port: 7433, createdDirectories: [] }));
    await cli.run("service", "status");
    expect(cli.out()).toContain(`Versions: unknown (there is no service state at ${join(dataDir, "service-state.json")})\n`);
    expect(cli.out()).toContain(
      "This service runs `agent-harness serve` without the launcher, as installed before it: `agent-harness service install` from a release with the launcher moves it to the launcher and keeps the data directory.\n",
    );
  });

  it("takes ready from the discovery URL, and exits 3 when it is not ready", async () => {
    const cli = harness("linux", { answer: active, fetch: answering("starting") });
    await cli.run("service", "install");
    expect(await cli.run("service", "status")).toBe(3);
    expect(cli.out()).toContain("Ready: no (starting)\n");
  });

  it("reports nothing installed and exits 3", async () => {
    const cli = harness("linux", { answer: (command, args) => (args.includes("is-active") ? { code: 4 } : undefined) });
    expect(await cli.run("service", "status")).toBe(3);
    expect(cli.out()).toBe(
      [
        "Installed: no",
        "Running: no",
        "Ready: no (nothing answers at http://127.0.0.1:7433)",
        "No service is installed. `agent-harness service install` installs it.",
        "",
      ].join("\n"),
    );
  });

  it("says which of installed and running is missing when an environment answers ready without the service", async () => {
    const notInstalled = harness("linux", { answer: (_, args) => (args.includes("is-active") ? { code: 4 } : undefined), fetch: answering("ready") });
    expect(await notInstalled.run("service", "status")).toBe(3);
    expect(notInstalled.out()).toContain("Ready: no (the service is not installed)\n");

    const stopped = harness("linux", { answer: (_, args) => (args.includes("is-active") ? { code: 3 } : undefined), fetch: answering("ready") });
    await stopped.run("service", "install");
    expect(await stopped.run("service", "status")).toBe(3);
    expect(stopped.out()).toContain("Ready: no (the service is not running)\n");
  });

  it("mentions lingering when the unit is installed and lingering is off", async () => {
    const cli = harness("linux", {
      answer: (command) => (command === "loginctl" ? { stdout: "no\n" } : undefined),
      fetch: answering("ready"),
    });
    await cli.run("service", "install");
    await cli.run("service", "status");
    expect(cli.out()).toContain("loginctl enable-linger david");
  });

  it("asks on the port the service was installed on, unless --port says otherwise", async () => {
    const urls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return discovery("ready");
    }) as typeof globalThis.fetch;
    const cli = harness("linux", { answer: active, fetch });
    await cli.run("service", "install", "--port", "7500");
    expect(await cli.run("service", "status")).toBe(0);
    expect(await cli.run("service", "status", "--port", "7502")).toBe(0);
    expect(urls).toEqual([`http://127.0.0.1:7500${DISCOVERY_PATH}`, `http://127.0.0.1:7502${DISCOVERY_PATH}`]);
  });

  it("finds the record of a service installed with another data directory through --data-dir", async () => {
    const urls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return discovery("ready");
    }) as typeof globalThis.fetch;
    const cli = harness("linux", { answer: active, fetch });
    const dataDir = join(cli.home, "second");
    await cli.run("service", "install", "--data-dir", dataDir, "--port", "7600");
    expect(await cli.run("service", "status", "--data-dir", dataDir)).toBe(0);
    expect(urls).toEqual([`http://127.0.0.1:7600${DISCOVERY_PATH}`]);
    expect(await cli.run("service", "uninstall", "--data-dir", dataDir)).toBe(0);
    expect(readdirSync(dataDir).sort()).toEqual(["launcher-version", "service-state.json", "versions"]);
  });

  it("uninstall still removes the definition when the service record cannot be read, and says the folders stay", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "install")).toBe(0);
    const record = join(cli.home, ".local", "state", "agent-harness", "service.json");
    writeFileSync(record, "{ not json");
    expect(await cli.run("service", "uninstall")).toBe(0);
    expect(existsSync(unitPath(cli.home))).toBe(false);
    expect(existsSync(record)).toBe(false);
    expect(cli.err()).toMatch(/could not be removed/);
  });

  it("uninstall of a service from before the launcher names only the definition it removed", async () => {
    const cli = harness("linux", { answer: stopped });
    const dataDir = join(cli.home, ".local", "state", "agent-harness");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(dirname(unitPath(cli.home)), { recursive: true });
    writeFileSync(unitPath(cli.home), "[Service]\nExecStart=/usr/bin/node /opt/agent-harness/dist/main.js serve\n");
    writeFileSync(join(dataDir, "service.json"), JSON.stringify({ platform: "systemd", definitionPath: unitPath(cli.home), port: 7433, createdDirectories: [] }));
    expect(await cli.run("service", "uninstall")).toBe(0);
    expect(cli.out()).toBe(`Removed ${unitPath(cli.home)}. The data directory keeps the versions and what the environment wrote.\n`);
  });

  it("says in a sentence, and exits 1, when the service record cannot be read", async () => {
    const cli = harness("linux", { answer: active });
    await cli.run("service", "install");
    writeFileSync(join(cli.home, ".local", "state", "agent-harness", "service.json"), "{ not json");
    expect(await cli.run("service", "status")).toBe(1);
    expect(cli.err()).toMatch(/service\.json/);
  });

  it("asks on the port it is given and prints JSON with --json", async () => {
    const urls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return discovery("ready");
    }) as typeof globalThis.fetch;
    const cli = harness("linux", { answer: active, fetch });
    await cli.run("service", "install", "--port", "7500");
    expect(await cli.run("service", "status", "--port", "7500", "--json")).toBe(0);
    expect(urls).toEqual([`http://127.0.0.1:7500${DISCOVERY_PATH}`]);
    const lines = cli.out().split("\n");
    const report = JSON.parse(lines.slice(lines.findIndex((line) => line === "{")).join("\n")) as Record<string, unknown>;
    expect(report).toMatchObject({
      installed: true,
      running: true,
      readiness: "ready",
      ready: true,
      definition: unitPath(cli.home),
      address: "http://127.0.0.1:7500",
      notes: [],
    });
  });
});

describe("agent-harness service, arguments", () => {
  it("prints its usage and exits 2 on a missing or unknown verb or a bad argument", async () => {
    for (const args of [
      ["service"],
      ["service", "restart"],
      ["service", "install", "--port", "0"],
      ["service", "install", "--port", "x"],
      ["service", "install", "--channel", "beta"],
      ["service", "start", "extra"],
      ["service", "uninstall", "--port", "7433"],
      ["service", "status", "--name", "x"],
    ]) {
      const cli = harness("linux");
      expect(await cli.run(...args), args.join(" ")).toBe(2);
      expect(cli.err()).toContain("agent-harness service install [--data-dir <path>] [--port <n>] [--name <name>]");
      expect(cli.calls).toEqual([]);
    }
  });
});
