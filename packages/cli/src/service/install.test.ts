import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installVersion } from "../../test/launcher-fixtures.js";
import { bundledVersion, installContextAt, makeTempDir, snapshot, stubRunner, type Answer } from "../../test/service-helpers.js";
import { runCli, type CliContext } from "../cli.js";
import { LAUNCHER_VERSION_FILE } from "../launch/launcher-version.js";
import { readServiceState, writeServiceState, type ServiceState } from "../launch/state.js";
import { VERSION_CLI_ENTRY, VERSION_SENTINEL, versionDirectory } from "../launch/versions.js";
import { renderLauncherEntry } from "./entry.js";
import { renderShim } from "./shim.js";

/**
 * `service install` lays out the launcher (#338): the versions directory, the
 * service state, the launcher version file, the launcher entry and the shim
 * in the data directory, and a definition that runs the entry. Driven
 * through the CLI with the service manager stubbed, on a temporary home.
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

/** The CLI in-process on `platform`, with a temp home, a stubbed runner, and the CLI running from `cliEntry` (preset: 0.5.0 bundled in the home). */
const harness = (platform: NodeJS.Platform, options: { home?: string; answer?: Answer; cliEntry?: string } = {}) => {
  const home = options.home ?? tempHome();
  const cliEntry = options.cliEntry ?? bundledVersion(home);
  const stub = stubRunner(options.answer);
  let out = "";
  let err = "";
  const context: Partial<CliContext> = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    fetch: refused,
    environment: { user: { isPrivileged: () => false } },
    service: { installContext: installContextAt(platform, home), runner: stub.runner, cliEntry },
  };
  const run = (...args: string[]) => runCli(args, context);
  return { home, cliEntry, run, calls: stub.calls, out: () => out, err: () => err };
};

const linuxDataDir = (home: string) => join(home, ".local", "state", "agent-harness");
const unitPath = (home: string) => join(home, ".config", "systemd", "user", "agent-harness.service");
const execStart = (home: string) =>
  readFileSync(unitPath(home), "utf8")
    .split("\n")
    .find((line) => line.startsWith("ExecStart="));

const stateOf = (dataDir: string): ServiceState => {
  const read = readServiceState(dataDir);
  if ("problem" in read) throw new Error(read.problem);
  return read.state;
};

const fresh = (version: string): ServiceState => ({
  activeVersion: version,
  previousVersion: null,
  launcherVersion: version,
  pendingUpdate: null,
  watchDeadline: null,
  watchedUpdateId: null,
  stagedVersion: null,
  failedHandover: null,
});

/** systemd's answers for a unit that is active, and for one that is not. */
const active: Answer = (_, args) => (args.includes("is-active") ? { stdout: "active\n" } : undefined);
const inactive: Answer = (_, args) => (args.includes("is-active") ? { code: 3, stdout: "inactive\n" } : undefined);

describe("agent-harness service install, a first install", () => {
  it("copies the version it runs from into the versions directory, sentinel last, and names it active and the launcher's", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "install")).toBe(0);
    const dataDir = linuxDataDir(cli.home);
    const source = join(cli.home, "bundle", "0.5.0");
    const copy = versionDirectory(dataDir, "0.5.0");
    expect(existsSync(join(copy, VERSION_SENTINEL))).toBe(true);
    expect(snapshot(copy)).toEqual({ ...snapshot(source), [VERSION_SENTINEL]: "" });
    expect(statSync(join(copy, "node", "bin", "node")).mode & 0o111).not.toBe(0);
    expect(readdirSync(join(dataDir, "versions"))).toEqual(["0.5.0"]);
    expect(stateOf(dataDir)).toEqual(fresh("0.5.0"));
    expect(readFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "utf8")).toBe("0.5.0\n");
    expect(cli.out()).toContain(`Copied 0.5.0 from ${source} into ${join(dataDir, "versions")}.`);
    expect(cli.err()).toBe("");
  });

  it("writes the launcher entry and the shim, and a definition that runs the entry and never serve", async () => {
    const cli = harness("linux");
    expect(await cli.run("service", "install", "--port", "7500", "--name", "David's desk")).toBe(0);
    const dataDir = linuxDataDir(cli.home);
    expect(readFileSync(join(dataDir, "launcher-entry.sh"), "utf8")).toBe(renderLauncherEntry("sh", { dataDir, port: 7500, name: "David's desk" }));
    const shim = join(dataDir, "bin", "agent-harness");
    expect(readFileSync(shim, "utf8")).toBe(renderShim("sh", dataDir));
    expect(statSync(shim).mode & 0o111).not.toBe(0);
    expect(execStart(cli.home)).toBe(`ExecStart=/bin/sh ${join(dataDir, "launcher-entry.sh")}`);
    expect(readFileSync(unitPath(cli.home), "utf8")).not.toContain("serve");
  });

  it("prints the line that puts the shim on the path and edits no shell profile", async () => {
    const cli = harness("linux");
    writeFileSync(join(cli.home, ".profile"), "export PATH\n");
    writeFileSync(join(cli.home, ".bashrc"), "# bash\n");
    expect(await cli.run("service", "install")).toBe(0);
    const bin = join(linuxDataDir(cli.home), "bin");
    expect(cli.out()).toContain(`\n  export PATH="${bin}:$PATH"\n`);
    expect(readFileSync(join(cli.home, ".profile"), "utf8")).toBe("export PATH\n");
    expect(readFileSync(join(cli.home, ".bashrc"), "utf8")).toBe("# bash\n");
  });

  it("names the version it runs from when that is already complete in the versions directory, and copies nothing", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    installVersion(dataDir, "0.5.0");
    const before = snapshot(join(dataDir, "versions"));
    const cli = harness("linux", { home, cliEntry: join(versionDirectory(dataDir, "0.5.0"), ...VERSION_CLI_ENTRY) });
    expect(await cli.run("service", "install")).toBe(0);
    expect(snapshot(join(dataDir, "versions"))).toEqual(before);
    expect(stateOf(dataDir)).toEqual(fresh("0.5.0"));
    expect(readFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "utf8")).toBe("0.5.0\n");
    expect(cli.out()).not.toContain("Copied");
  });

  it("takes a complete copy of the version already in the versions directory rather than copying it again", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    installVersion(dataDir, "0.5.0");
    writeFileSync(join(versionDirectory(dataDir, "0.5.0"), "kept"), "");
    const cli = harness("linux", { home });
    expect(await cli.run("service", "install")).toBe(0);
    expect(existsSync(join(versionDirectory(dataDir, "0.5.0"), "kept"))).toBe(true);
    expect(cli.out()).not.toContain("Copied");
  });

  it("clears the staging folders a copy cut short by a crash left in the versions directory", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    installVersion(dataDir, "0.4.0");
    mkdirSync(join(dataDir, "versions", ".0.5.0.0b6f3c1e-7d5a-4c2b-9e8f-1a2b3c4d5e6f.partial", "node"), { recursive: true });
    const cli = harness("linux", { home });
    expect(await cli.run("service", "install")).toBe(0);
    expect(readdirSync(join(dataDir, "versions")).sort()).toEqual(["0.4.0", "0.5.0"]);
  });

  it("replaces a folder of the version that has no sentinel, which a copy cut short left, with a whole copy", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    mkdirSync(join(versionDirectory(dataDir, "0.5.0"), "node"), { recursive: true });
    writeFileSync(join(versionDirectory(dataDir, "0.5.0"), "node", "half"), "");
    const cli = harness("linux", { home });
    expect(await cli.run("service", "install")).toBe(0);
    expect(existsSync(join(versionDirectory(dataDir, "0.5.0"), "node", "half"))).toBe(false);
    expect(snapshot(versionDirectory(dataDir, "0.5.0"))).toEqual({ ...snapshot(join(home, "bundle", "0.5.0")), [VERSION_SENTINEL]: "" });
  });

  it("refuses, writing nothing, to run from a folder in the versions directory without its sentinel, which is not a version", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    installVersion(dataDir, "0.5.0");
    rmSync(join(versionDirectory(dataDir, "0.5.0"), VERSION_SENTINEL));
    const before = snapshot(home);
    const cli = harness("linux", { home, cliEntry: join(versionDirectory(dataDir, "0.5.0"), ...VERSION_CLI_ENTRY) });
    expect(await cli.run("service", "install")).toBe(1);
    expect(cli.err()).toMatch(/0\.5\.0 .*has no sentinel/);
    expect(snapshot(home)).toEqual(before);
    expect(cli.calls.filter((call) => !call.includes(" is-"))).toEqual([]);
  });

  it("refuses, writing nothing, to run from a CLI that is not a release's unpacked artefact, which has no Node of its own", async () => {
    const home = tempHome();
    const entry = join(home, "checkout", ...VERSION_CLI_ENTRY);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    writeFileSync(join(home, "checkout", "packages", "cli", "package.json"), JSON.stringify({ version: "0.0.0" }));
    const before = snapshot(home);
    const cli = harness("linux", { home, cliEntry: entry });
    expect(await cli.run("service", "install")).toBe(1);
    expect(cli.err()).toMatch(/release's unpacked artefact/);
    expect(snapshot(home)).toEqual(before);
  });

  it("refuses, writing nothing, a name holding a line break or nothing at all", async () => {
    for (const name of ["two\nlines", " "]) {
      const cli = harness("linux");
      const before = snapshot(cli.home);
      expect(await cli.run("service", "install", "--name", name), JSON.stringify(name)).toBe(2);
      expect(cli.err()).toContain("--name");
      expect(snapshot(cli.home)).toEqual(before);
    }
  });

  it("takes back the version it copied, the state, the launcher version file, the entry and the shim when the service manager refuses", async () => {
    const cli = harness("linux", { answer: (_, args) => (args.includes("enable") ? { code: 1, stderr: "Access denied" } : undefined) });
    const before = snapshot(cli.home);
    expect(await cli.run("service", "install")).toBe(1);
    expect(cli.err()).toContain("Access denied");
    expect(snapshot(cli.home)).toEqual(before);
  });

  it("takes back the version it copied when the service state cannot be written", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    // A folder where the service state goes: it can be neither read nor replaced.
    mkdirSync(join(dataDir, "service-state.json", "in-the-way"), { recursive: true });
    const cli = harness("linux", { home });
    const before = snapshot(home);
    expect(await cli.run("service", "install")).toBe(1);
    expect(cli.err()).toContain("service-state.json");
    expect(snapshot(home)).toEqual(before);
  });

  it("puts back the state and the launcher version file it replaced when the service manager refuses", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    mkdirSync(dataDir, { recursive: true });
    writeServiceState(dataDir, fresh("0.4.0"));
    writeFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "0.4.0\n");
    installVersion(dataDir, "0.4.0");
    const cli = harness("linux", { home, answer: (_, args) => (args.includes("enable") ? { code: 1 } : undefined) });
    const before = snapshot(home);
    expect(await cli.run("service", "install")).toBe(1);
    expect(snapshot(home)).toEqual(before);
  });
});

describe("agent-harness service install over a service that is stopped", () => {
  it("names the version it runs from, keeping a pending update's record for the launcher to roll back, the version before and a staged one, and ending a watch and a failed handover", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    mkdirSync(dataDir, { recursive: true });
    const pendingUpdate = { updateId: "5b1f3c1e-7d5a-4c2b-9e8f-1a2b3c4d5e6f", fromVersion: "0.4.0", toVersion: "0.4.1" };
    writeServiceState(dataDir, {
      ...fresh("0.4.0"),
      previousVersion: "0.3.0",
      pendingUpdate,
      watchDeadline: "2026-09-28T12:10:00.000Z",
      watchedUpdateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20",
      stagedVersion: "0.4.2",
      failedHandover: { toVersion: "0.4.0", at: "2026-09-28T11:00:00.000Z" },
    });
    const cli = harness("linux", { home, answer: inactive });
    expect(await cli.run("service", "install")).toBe(0);
    expect(stateOf(dataDir)).toEqual({ ...fresh("0.5.0"), previousVersion: "0.4.0", pendingUpdate, stagedVersion: "0.4.2" });
    expect(readFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "utf8")).toBe("0.5.0\n");
  });

  it("replaces a service state it cannot read with one naming the version it runs from", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "service-state.json"), "{ not json");
    const cli = harness("linux", { home, answer: inactive });
    expect(await cli.run("service", "install")).toBe(0);
    expect(stateOf(dataDir)).toEqual(fresh("0.5.0"));
  });
});

describe("agent-harness service install over a running launcher", () => {
  /** A home whose service was installed from 0.4.0 and whose launcher now runs 0.4.2 as active, 0.4.0 its own. */
  const installedHome = async () => {
    const home = tempHome();
    const first = harness("linux", { home, cliEntry: bundledVersion(home, "0.4.0"), answer: inactive });
    expect(await first.run("service", "install", "--name", "first")).toBe(0);
    const dataDir = linuxDataDir(home);
    installVersion(dataDir, "0.4.2");
    writeServiceState(dataDir, { ...fresh("0.4.2"), previousVersion: "0.4.0", launcherVersion: "0.4.0" });
    return { home, dataDir };
  };

  it("rewrites only the definition, the entry and the shim, leaves the versions, the state and the launcher version file, and restarts nothing", async () => {
    const { home, dataDir } = await installedHome();
    rmSync(unitPath(home));
    rmSync(join(dataDir, "bin", "agent-harness"));
    const launcherFiles = () => ({ versions: snapshot(join(dataDir, "versions")), state: readFileSync(join(dataDir, "service-state.json"), "utf8"), pointer: readFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "utf8") });
    const before = launcherFiles();

    const cli = harness("linux", { home, cliEntry: bundledVersion(home, "0.6.0"), answer: active });
    expect(await cli.run("service", "install", "--port", "7600", "--name", "second")).toBe(0);

    expect(launcherFiles()).toEqual(before);
    expect(readFileSync(join(dataDir, "launcher-entry.sh"), "utf8")).toBe(renderLauncherEntry("sh", { dataDir, port: 7600, name: "second" }));
    expect(readFileSync(join(dataDir, "bin", "agent-harness"), "utf8")).toBe(renderShim("sh", dataDir));
    expect(execStart(home)).toBe(`ExecStart=/bin/sh ${join(dataDir, "launcher-entry.sh")}`);
    expect(cli.calls.filter((call) => !call.includes(" is-"))).toEqual(["systemctl --user daemon-reload", "systemctl --user enable agent-harness.service"]);
    expect(cli.out()).toContain("The service is running its launcher");
    expect(cli.out()).toContain("rewrote only its own files: the definition, the launcher entry, the shim and the record");
    expect(cli.out()).not.toContain("Copied");
    expect(cli.out()).not.toContain("Stopping the service");
  });

  it("leaves the running launcher running, and puts its entry and shim back, when a step after the service manager's fails", async () => {
    const { home, dataDir } = await installedHome();
    const record = join(dataDir, "service.json");
    const entryBefore = readFileSync(join(dataDir, "launcher-entry.sh"), "utf8");
    // The record, read at the start, cannot be written at the end: a folder takes its place while systemd reloads.
    const cli = harness("linux", {
      home,
      answer: (command, args) => {
        if (args.includes("daemon-reload")) {
          rmSync(record, { force: true });
          mkdirSync(record, { recursive: true });
        }
        return active(command, args);
      },
    });
    expect(await cli.run("service", "install", "--name", "second")).toBe(1);
    expect(cli.calls.filter((call) => call.includes("disable") || call.includes("stop") || call.includes("restart"))).toEqual([]);
    expect(readFileSync(join(dataDir, "launcher-entry.sh"), "utf8")).toBe(entryBefore);
  });

  it("does not need to run from a release's artefact, since it lays out no version", async () => {
    const { home } = await installedHome();
    const entry = join(home, "checkout", ...VERSION_CLI_ENTRY);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    const cli = harness("linux", { home, cliEntry: entry, answer: active });
    expect(await cli.run("service", "install")).toBe(0);
  });
});

describe("agent-harness service install over a service from before the launcher", () => {
  it("moves a service running serve directly to the launcher with one install, keeping the data directory, and restarts it onto the launcher", async () => {
    const home = tempHome();
    const dataDir = linuxDataDir(home);
    // What a phase-A install left: a unit running serve, its record without a launcher entry, and the environment's files.
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    mkdirSync(dirname(unitPath(home)), { recursive: true });
    writeFileSync(unitPath(home), `[Service]\nExecStart=/usr/bin/node /opt/agent-harness/dist/main.js serve --data-dir ${dataDir} --port 7433\n`);
    writeFileSync(
      join(dataDir, "service.json"),
      JSON.stringify({ platform: "systemd", definitionPath: unitPath(home), port: 7433, createdDirectories: [dataDir, join(dataDir, "logs")] }),
    );
    writeFileSync(join(dataDir, "environment.json"), '{"id":"environment"}\n');
    writeFileSync(join(dataDir, "harness.db"), "the event log");
    writeFileSync(join(dataDir, "logs", "service.log"), "http://127.0.0.1:7433\n");
    const environmentFiles = () => ["environment.json", "harness.db", join("logs", "service.log")].map((file) => readFileSync(join(dataDir, file), "utf8"));
    const kept = environmentFiles();

    let saidBeforeTheRestart: string | undefined;
    const cli = harness("linux", {
      home,
      answer: (command, args) => {
        if (args.includes("try-restart")) saidBeforeTheRestart = cli.out();
        return active(command, args);
      },
    });
    expect(await cli.run("service", "install")).toBe(0);

    expect(saidBeforeTheRestart).toBe("Stopping the service, waiting up to 30 minutes for any running runs to finish.\n");
    expect(stateOf(dataDir)).toEqual(fresh("0.5.0"));
    expect(readFileSync(join(dataDir, LAUNCHER_VERSION_FILE), "utf8")).toBe("0.5.0\n");
    expect(existsSync(join(versionDirectory(dataDir, "0.5.0"), VERSION_SENTINEL))).toBe(true);
    expect(execStart(home)).toBe(`ExecStart=/bin/sh ${join(dataDir, "launcher-entry.sh")}`);
    expect(cli.calls).toContain("systemctl --user try-restart agent-harness.service");
    expect(environmentFiles()).toEqual(kept);
    expect(JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8"))).toMatchObject({
      launcherEntry: join(dataDir, "launcher-entry.sh"),
      createdDirectories: expect.arrayContaining([dataDir, join(dataDir, "logs")]),
    });
    expect(cli.out()).toContain("restarted onto the launcher");
  });
});

describe("agent-harness service install on Windows", () => {
  it("lays out the cmd entry and shim and a logon task that runs the entry through cmd", async () => {
    const home = tempHome();
    // Named, since the default is a Windows path this POSIX runner cannot write to.
    const dataDir = join(home, "data");
    let task = "";
    const cli = harness("win32", {
      home,
      answer: (_, args) => {
        if (args[0] === "/Create") task = readFileSync(join(dataDir, "service-task.xml")).subarray(2).toString("utf16le");
        return args.includes("/Query") ? { code: 1 } : undefined;
      },
    });
    // The bundled version's Node is where Node's Windows archive puts it.
    mkdirSync(join(home, "bundle", "0.5.0", "node"), { recursive: true });
    writeFileSync(join(home, "bundle", "0.5.0", "node", "node.exe"), "");
    expect(await cli.run("service", "install", "--data-dir", dataDir, "--name", "desk")).toBe(0);
    expect(readFileSync(join(dataDir, "launcher-entry.cmd"), "utf8")).toBe(renderLauncherEntry("cmd", { dataDir, port: 7433, name: "desk" }));
    expect(readFileSync(join(dataDir, "bin", "agent-harness.cmd"), "utf8")).toBe(renderShim("cmd", dataDir));
    expect(stateOf(dataDir)).toEqual(fresh("0.5.0"));
    expect(task).toContain(`<Arguments>--headless cmd.exe /d /c .\\launcher-entry.cmd</Arguments>\n      <WorkingDirectory>${dataDir}</WorkingDirectory>`);
    expect(cli.out()).toContain(`$k.SetValue('Path', '${join(dataDir, "bin")};' + $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'), 'ExpandString')`);
  });
});
