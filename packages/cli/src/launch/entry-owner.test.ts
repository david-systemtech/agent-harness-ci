import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { ENTRY_OWNER_WATCH_SCRIPT, entryOwnerWatchArguments, watchEntryOwner, type EntryOwnerWatch } from "./entry-owner.js";

/**
 * The launcher's watch on the process that started its entry (#1712). The
 * PowerShell that does it on Windows is stood in for by a Node program that
 * says what that PowerShell says: `watching <pid> <name>`, then `ended` once
 * the test writes to it; or `gone <why>`.
 */

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

/** A stand-in watch that runs `program`. */
const standIn = (program: string): { start: () => ChildProcess; child: () => ChildProcess | undefined } => {
  let child: ChildProcess | undefined;
  return {
    start: () => {
      child = spawn(process.execPath, ["-e", program], { stdio: ["pipe", "pipe", "pipe"] });
      cleanups.push(() => void child?.kill());
      return child;
    },
    child: () => child,
  };
};

const watching = (start: () => ChildProcess) => {
  const lines: string[] = [];
  const watch = watchEntryOwner(start, (text) => lines.push(text));
  cleanups.push(() => watch.close());
  let ended = false;
  void watch.ended.then(() => (ended = true));
  return { watch, lines, ended: () => ended };
};

/** Settles once `check` holds; the watch reports by events, so this waits on them rather than on a clock. */
const until = async (check: () => boolean): Promise<void> => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 10));
};

/** Whether `watch` has ended by the time its process has closed. */
const closedWithout = async (child: ChildProcess | undefined, watch: EntryOwnerWatch): Promise<boolean> => {
  if (child === undefined) throw new Error("no watch was started");
  if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("close", resolve));
  return await Promise.race([watch.ended.then(() => false), new Promise<boolean>((resolve) => setImmediate(() => resolve(true)))]);
};

describe("the launcher's watch on the process that started its entry", () => {
  it("says what it watches, and settles once that process has ended", async () => {
    const fake = standIn(`console.log("watching 4242 conhost"); process.stdin.once("data", () => console.log("ended"));`);
    const run = watching(fake.start);
    await until(() => run.lines.length === 1);
    expect(run.lines).toEqual(["watching conhost (pid 4242), which started the launcher entry: ending the logon task ends it, and this launcher with it"]);
    expect(run.ended()).toBe(false);
    fake.child()?.stdin?.write("end\n");
    await run.watch.ended;
    expect(run.lines.at(-1)).toBe("conhost (pid 4242), which started the launcher entry, has ended, so the launcher stops");
  });

  it("settles at once when the process that started the entry is gone already, saying so in the words of a watched end", async () => {
    const fake = standIn(`console.log("gone the process (pid 4242), which started the launcher entry, has ended");`);
    const run = watching(fake.start);
    await run.watch.ended;
    expect(run.lines).toEqual(["the process (pid 4242), which started the launcher entry, has ended, so the launcher stops"]);
  });

  it("says it cannot watch, and never settles, when the watch fails", async () => {
    const fake = standIn(`process.stderr.write("Get-Process : access is denied\\n"); process.exit(1);`);
    const run = watching(fake.start);
    expect(await closedWithout(fake.child(), run.watch)).toBe(true);
    expect(run.lines).toEqual([
      "cannot watch the process that started the launcher entry (Get-Process : access is denied), so ending the logon task leaves this launcher running",
    ]);
  });

  it("says it cannot watch when the watch cannot be started at all", async () => {
    const run = watching(() => {
      throw new Error("spawn powershell.exe ENOENT");
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(run.ended()).toBe(false);
    expect(run.lines).toEqual(["cannot watch the process that started the launcher entry (spawn powershell.exe ENOENT), so ending the logon task leaves this launcher running"]);
  });

  it("is ended without a word when the launcher closes it", async () => {
    const fake = standIn(`console.log("watching 4242 conhost"); setInterval(() => undefined, 1000);`);
    const run = watching(fake.start);
    await until(() => run.lines.length === 1);
    run.watch.close();
    expect(await closedWithout(fake.child(), run.watch)).toBe(true);
    expect(run.lines).toHaveLength(1);
  });
});

describe("the watch's PowerShell", () => {
  it("is run for this launcher's pid, waiting on a handle it holds to the process that started the entry, and goes with the launcher", () => {
    const [noProfile, nonInteractive, encoded, script] = entryOwnerWatchArguments(31337);
    expect([noProfile, nonInteractive, encoded]).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const decoded = Buffer.from(script ?? "", "base64").toString("utf16le");
    expect(decoded).toContain("$launcher = Get-Process -Id 31337");
    expect(decoded).toContain("-Filter 'ProcessId=31337'");
    expect(decoded).not.toContain("{LAUNCHER}");
    // The handle is taken before the start time is compared, so a pid reused after that cannot be mistaken for the owner.
    expect(ENTRY_OWNER_WATCH_SCRIPT.indexOf("$null = $owner.SafeHandle")).toBeLessThan(ENTRY_OWNER_WATCH_SCRIPT.indexOf("$owner.StartTime -gt $entry.CreationDate"));
    expect(ENTRY_OWNER_WATCH_SCRIPT).toContain("while (!$owner.WaitForExit(1000)) { if ($launcher.HasExited) { exit 0 } }");
  });
});

const pwsh = process.env["PWSH"] ?? "pwsh";
const pwshEnv = { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off" };
const hasPwsh = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { env: pwshEnv }).status === 0;

// Real processes and handles; only the CIM inventory, which Linux lacks, is faked, as the uninstall's tests fake it.
describe.skipIf(!hasPwsh && !process.env["CI"])("the watch's PowerShell, run", () => {
  const sleeper = () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    cleanups.push(() => void child.kill());
    return child;
  };

  /** The line that says the watch holds `owner`, whatever name Linux gives Node's process (its main thread's, on some). */
  const watchingLine = (owner: ChildProcess) => expect.stringMatching(new RegExp(`^watching ${owner.pid} \\S+$`));

  /** Runs the watch for the launcher `launcher`, whose entry (a pid nothing has) was started by `owner` at `entry` minutes after `owner` began, or is gone. */
  const runWatch = (launcher: ChildProcess, owner: ChildProcess, entry: number | "gone") => {
    expect(hasPwsh, "PowerShell is required in CI").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "ah-entry-owner-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const entryPid = 2_000_000_001;
    const fixture = `
$ownerStart = (Microsoft.PowerShell.Management\\Get-Process -Id ${owner.pid}).StartTime
function Get-CimInstance {
  param($ClassName, $Filter)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected inventory' }
  $id = [int]($Filter -replace '^ProcessId=', '')
  if ($id -eq ${launcher.pid}) { return [pscustomobject]@{ ProcessId = $id; ParentProcessId = ${entryPid}; CreationDate = $ownerStart.AddMinutes(5) } }
  ${entry === "gone" ? "" : `if ($id -eq ${entryPid}) { return [pscustomobject]@{ ProcessId = $id; ParentProcessId = ${owner.pid}; CreationDate = $ownerStart.AddMinutes(${entry}) } }`}
  return $null
}
`;
    const script = Buffer.from(entryOwnerWatchArguments(launcher.pid ?? 0).at(-1) ?? "", "base64").toString("utf16le");
    const file = join(dir, "watch.ps1");
    writeFileSync(file, fixture + script);
    const watch = spawn(pwsh, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { env: pwshEnv, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => void watch.kill());
    const lines: string[] = [];
    let stderr = "";
    createInterface({ input: watch.stdout }).on("line", (line) => lines.push(line));
    watch.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const exited = once(watch, "close").then(([code]) => code as number | null);
    return { lines, exited, stderr: () => stderr };
  };

  it("says what it watches, and that it ended once the process that started the entry exits", async () => {
    const owner = sleeper();
    const run = runWatch(sleeper(), owner, 1);
    await until(() => run.lines.length > 0 || run.stderr() !== "");
    expect(run.stderr()).toBe("");
    expect(run.lines).toEqual([watchingLine(owner)]);
    owner.kill();
    expect(await run.exited).toBe(0);
    expect(run.lines).toEqual([watchingLine(owner), "ended"]);
  }, 60_000);

  it("says at once that the entry is gone when it has ended", async () => {
    const run = runWatch(sleeper(), sleeper(), "gone");
    expect(await run.exited).toBe(0);
    expect(run.lines).toEqual(["gone the launcher entry has ended"]);
  }, 60_000);

  it("takes a process younger than the entry for one that reuses the pid of the one that started it, which has ended", async () => {
    const owner = sleeper();
    const run = runWatch(sleeper(), owner, -1);
    expect(await run.exited).toBe(0);
    expect(run.lines).toEqual([`gone the process (pid ${owner.pid}), which started the launcher entry, has ended`]);
  }, 60_000);

  it("exits without a word once the launcher has, the process it watched still running", async () => {
    const launcher = sleeper();
    const owner = sleeper();
    const run = runWatch(launcher, owner, 1);
    await until(() => run.lines.length > 0 || run.stderr() !== "");
    launcher.kill();
    expect(await run.exited).toBe(0);
    expect(run.lines).toEqual([watchingLine(owner)]);
  }, 60_000);
});
