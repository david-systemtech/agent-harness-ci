import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanUp, scratch } from "../test/harness.js";

afterEach(cleanUp);
const environment = { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1" };
const hasPowerShell = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { env: environment }).status === 0;

it.skipIf(!hasPowerShell)("an early launch waits for the installation, then opens the completed app and accepts setup's update argument", () => {
  const work = scratch();
  const receipt = join(work, "opened.txt");
  const app = join(work, process.platform === "win32" ? "app.cmd" : "app.sh");
  // This app appears only after the installer releases its files.
  const bytes = process.platform === "win32" ? `@echo opened > "${receipt}"` : `#!/bin/sh\nprintf opened > '${receipt}'\n`;
  const owner = join(work, "owner.ps1");
  writeFileSync(owner, `
$ErrorActionPreference = 'Stop'
$mutex = [Threading.Mutex]::new($true, 'Local\\agent-harness-desktop-install')
$child = $null
$held = $true
$message = Join-Path $env:DESKTOP_TEST_WORK 'waiting.txt'
$errors = Join-Path $env:DESKTOP_TEST_WORK 'errors.txt'
try {
  $child = Start-Process -FilePath (Join-Path $PSHOME 'pwsh') -ArgumentList @(
    '-NoProfile', '-File', ('"' + $env:DESKTOP_TEST_HELPER + '"'),
    '-App', ('"' + $env:DESKTOP_TEST_APP + '"'), '-NoWindow', '--updated'
  ) -PassThru -RedirectStandardOutput $message -RedirectStandardError $errors
  $deadline = [datetime]::UtcNow.AddMinutes(2)
  while (!(Test-Path $message) -or !(Get-Content $message -Raw)) {
    if ($child.HasExited) { throw ('Launch exited instead of waiting: ' + (Get-Content $errors -Raw)) }
    if ([datetime]::UtcNow -gt $deadline) { throw 'No wait message' }
    Start-Sleep -Milliseconds 25
  }
  if ($child.HasExited -or (Test-Path $env:DESKTOP_TEST_RECEIPT)) { throw 'Launch did not wait for installation' }
  if ((Get-Content $message -Raw) -notmatch 'finishing its update; it will open by itself') { throw 'No plain wait message' }
  Copy-Item $env:DESKTOP_TEST_INCOMING $env:DESKTOP_TEST_APP
  $mutex.ReleaseMutex()
  $held = $false
  if (!$child.WaitForExit(120000) -or $child.ExitCode -ne 0) { throw ('Launch failed: ' + (Get-Content $errors -Raw)) }
  while (!(Test-Path $env:DESKTOP_TEST_RECEIPT)) {
    if ([datetime]::UtcNow -gt $deadline) { throw 'App did not open' }
    Start-Sleep -Milliseconds 25
  }
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  if ($null -ne $child -and !$child.HasExited) { $child.Kill(); $child.WaitForExit() }
}
`);
  const incoming = join(work, "incoming");
  writeFileSync(incoming, bytes, { mode: 0o755 });
  execFileSync("pwsh", ["-NoProfile", "-File", owner], {
    env: { ...environment, DESKTOP_TEST_WORK: work, DESKTOP_TEST_HELPER: join(import.meta.dirname, "desktop-launch.ps1"), DESKTOP_TEST_APP: app, DESKTOP_TEST_RECEIPT: receipt, DESKTOP_TEST_INCOMING: incoming },
    timeout: 150_000,
    stdio: "pipe",
  });
  expect(readFileSync(receipt, "utf8").trim()).toBe("opened");
}, 160_000);

it.skipIf(!hasPowerShell)("follows the current version pointer beside it to the version installed ahead of the click, and ignores one that names no installed version", () => {
  const work = scratch();
  const helper = join(work, "desktop-launch.ps1");
  writeFileSync(helper, readFileSync(join(import.meta.dirname, "desktop-launch.ps1")));
  const receipt = join(work, "opened.txt");
  const name = process.platform === "win32" ? "app.cmd" : "app.sh";
  const body = (what: string) => (process.platform === "win32" ? `@echo ${what} > "${receipt}"` : `#!/bin/sh\nprintf ${what} > '${receipt}'\n`);
  const programs = join(work, "Programs");
  mkdirSync(join(programs, "versions", "0.6.0"), { recursive: true });
  writeFileSync(join(programs, name), body("installed"), { mode: 0o755 });
  writeFileSync(join(programs, "versions", "0.6.0", name), body("staged"), { mode: 0o755 });
  const launch = () => {
    rmSync(receipt, { force: true });
    execFileSync("pwsh", ["-NoProfile", "-File", helper, "-App", join(programs, name), "-NoWindow"], { env: environment, timeout: 60_000, stdio: "pipe" });
    const deadline = Date.now() + 30_000;
    while (!existsSync(receipt) && Date.now() < deadline) execFileSync("sleep", ["0.05"]);
    return readFileSync(receipt, "utf8").trim();
  };

  writeFileSync(join(work, "current"), "0.6.0");
  expect(launch()).toBe("staged");
  writeFileSync(join(work, "current"), "0.7.0");
  expect(launch()).toBe("installed");
  writeFileSync(join(work, "current"), "..\\..\\evil");
  expect(launch()).toBe("installed");
}, 120_000);

/** A Programs folder with the install's own app and `versions/<v>` for each of `versions`, each app writing its name to the receipt, and the helper copied beside it as the setup copies it into the data directory. */
const versionedInstall = (...versions: string[]) => {
  const work = scratch();
  const helper = join(work, "desktop-launch.ps1");
  writeFileSync(helper, readFileSync(join(import.meta.dirname, "desktop-launch.ps1")));
  const receipt = join(work, "opened.txt");
  const name = process.platform === "win32" ? "app.cmd" : "app.sh";
  const body = (what: string) => (process.platform === "win32" ? `@echo ${what} > "${receipt}"` : `#!/bin/sh\nprintf ${what} > '${receipt}'\n`);
  const programs = join(work, "Programs");
  mkdirSync(programs, { recursive: true });
  writeFileSync(join(programs, name), body("installed"), { mode: 0o755 });
  for (const version of versions) {
    mkdirSync(join(programs, "versions", version), { recursive: true });
    writeFileSync(join(programs, "versions", version, name), body(version), { mode: 0o755 });
  }
  const opened = () => {
    const deadline = Date.now() + 30_000;
    while (!existsSync(receipt) && Date.now() < deadline) execFileSync("sleep", ["0.05"]);
    return existsSync(receipt) ? readFileSync(receipt, "utf8").trim() : undefined;
  };
  return { work, helper, receipt, app: join(programs, name), opened };
};

it.skipIf(!hasPowerShell)("rolls back to the version before the switch when the new one never reports ready, logging it, and leaves a ready one alone", () => {
  const install = versionedInstall("0.6.0", "0.7.0");
  const watch = () => execFileSync("pwsh", ["-NoProfile", "-File", install.helper, "-App", install.app, "-Watch", "0.7.0", "-Bound", "1"], { env: environment, timeout: 60_000, stdio: "pipe" });
  const log = join(install.work, "logs", "desktop-update.log");

  // A new version that got ready removed the click file: nothing is touched.
  writeFileSync(join(install.work, "current"), "0.7.0");
  writeFileSync(join(install.work, "current.previous"), "0.6.0");
  watch();
  expect(readFileSync(join(install.work, "current"), "utf8")).toBe("0.7.0");
  expect(existsSync(install.receipt)).toBe(false);
  expect(existsSync(log)).toBe(false);

  // One that never got ready: the pointer goes back, the previous version opens, and the log says why.
  writeFileSync(join(install.work, "update-click.json"), JSON.stringify({ version: "0.7.0", at: Date.now() }));
  watch();
  expect(install.opened()).toBe("0.6.0");
  expect(readFileSync(join(install.work, "current"), "utf8").trim()).toBe("0.6.0");
  expect(existsSync(join(install.work, "update-click.json"))).toBe(false);
  expect(readFileSync(log, "utf8")).toBe("0.7.0 rolled back: it did not report ready within 1s\r\n");
}, 120_000);

it.skipIf(!hasPowerShell)("rolls back to the install's own folder when no version was pointed at before, and leaves a pointer a setup changed since", () => {
  const install = versionedInstall("0.7.0");
  const watch = () => execFileSync("pwsh", ["-NoProfile", "-File", install.helper, "-App", install.app, "-Watch", "0.7.0", "-Bound", "1"], { env: environment, timeout: 60_000, stdio: "pipe" });
  writeFileSync(join(install.work, "current"), "0.7.0");
  writeFileSync(join(install.work, "current.previous"), "");
  writeFileSync(join(install.work, "update-click.json"), "{}");
  watch();
  expect(install.opened()).toBe("installed");
  expect(existsSync(join(install.work, "current"))).toBe(false);

  rmSync(install.receipt, { force: true });
  writeFileSync(join(install.work, "update-click.json"), "{}");
  watch();
  expect(existsSync(install.receipt)).toBe(false);
}, 120_000);
