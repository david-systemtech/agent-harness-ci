import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
