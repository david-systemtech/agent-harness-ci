import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DISCOVERY_PATH, PROTOCOL_VERSION } from "@agent-harness/contracts";
import { defaultDataDirectory, HARNESS_VERSION, ROOT_REFUSAL } from "@agent-harness/environment";
import { afterEach, describe, expect, it } from "vitest";
import { hostAt, makeTempDir, stubRunner, tree, type Answer } from "../../test/service-helpers.js";
import { runCli, type CliContext } from "../cli.js";

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

const PROGRAM = ["/usr/bin/node", "/opt/agent-harness/dist/main.js"];

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
    service: { host: hostAt(platform, home, options.env), runner: stub.runner, program: PROGRAM },
  };
  const run = (...args: string[]) => runCli(args, context);
  return { home, run, calls: stub.calls, out: () => out, err: () => err };
};

const unitPath = (home: string) => join(home, ".config", "systemd", "user", "agent-harness.service");
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

    const dataDir = defaultDataDirectory(hostAt(platform, cli.home));
    const added = tree(cli.home).filter((path) => !before.includes(path));
    expect(outsideDataDir(cli.home, added, dataDir).sort()).toEqual(
      outsideDataDir(cli.home, withAncestors(cli.home, definition(cli.home)), dataDir).sort(),
    );
    expect(added).toContain(join(relative(cli.home, dataDir), "logs"));
    expect(readFileSync(definition(cli.home), "utf8")).toContain(`--port`);
    expect(cli.out()).toContain(definition(cli.home));
    expect(cli.err()).toBe("");
  });

  it("uninstall removes the definition install wrote, leaving the data directory and the standard folders it sits in", async () => {
    const cli = harness(platform, { answer: (_, args) => (args[0] === "print" ? { code: 113 } : undefined) });
    const before = tree(cli.home);
    expect(await cli.run("service", "install")).toBe(0);
    expect(await cli.run("service", "uninstall")).toBe(0);

    const dataDir = defaultDataDirectory(hostAt(platform, cli.home));
    const left = tree(cli.home).filter((path) => !before.includes(path));
    expect(existsSync(definition(cli.home))).toBe(false);
    expect(outsideDataDir(cli.home, left, dataDir).sort()).toEqual(
      outsideDataDir(cli.home, withAncestors(cli.home, definition(cli.home)).slice(0, -1), dataDir).sort(),
    );
    expect(existsSync(dataDir)).toBe(true);
  });
});

describe("agent-harness service install", () => {
  it("runs serve with the program that is running, an absolute data directory and the port given", async () => {
    const cli = harness("linux");
    const cwd = process.cwd();
    expect(await cli.run("service", "install", "--data-dir", "relative/data", "--port", "7500")).toBe(0);
    const execStart = readFileSync(unitPath(cli.home), "utf8")
      .split("\n")
      .find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBe(`ExecStart=/usr/bin/node /opt/agent-harness/dist/main.js serve --data-dir ${join(cwd, "relative", "data")} --port 7500`);
  });

  it("uses the default data directory and port when none is given", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "install")).toBe(0);
    expect(readFileSync(unitPath(cli.home), "utf8")).toContain(
      `serve --data-dir ${join(cli.home, ".local", "state", "agent-harness")} --port 7433\n`,
    );
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
        "The service is running and the environment at http://127.0.0.1:7433 is ready.",
        "",
      ].join("\n"),
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

  it("probes the port it is given and prints JSON with --json", async () => {
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
      ["service", "install", "--name", "x"],
      ["service", "start", "extra"],
      ["service", "uninstall", "--port", "7433"],
      ["service", "status", "--data-dir", "/x"],
    ]) {
      const cli = harness("linux");
      expect(await cli.run(...args), args.join(" ")).toBe(2);
      expect(cli.err()).toContain("agent-harness service install [--data-dir <path>] [--port <n>]");
      expect(cli.calls).toEqual([]);
    }
  });
});
