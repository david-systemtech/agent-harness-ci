import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { releaseWorkflowInput } from "./release-workflow-input.js";

const run = promisify(execFile);
const pwsh = process.env["PWSH"] ?? "pwsh";
const env = { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off" };
const hasPwsh = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { env }).status === 0;
let scratch = "";
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

/** Run the workflow's cleanup at its Windows process boundary, without killing an OS process. */
const execute = async (survivor = 0, taskkillCode = 128, boundary = "normal") => {
  scratch = mkdtempSync(join(tmpdir(), "windows-smoke-stop-"));
  const workflow = releaseWorkflowInput(join(import.meta.dirname, "..")).hosted;
  const cleanup = workflow.match(/ {10}function Stop-Tree \{[\s\S]*?\n {10}\}/)?.[0] ?? "";
  expect(cleanup).not.toBe("");
  const helper = join(import.meta.dirname, "../scripts/stop-windows-process-tree.ps1");
  const harness = join(scratch, "harness.ps1");
  writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$script:survivor = ${survivor}
$script:boundary = '${boundary}'
$script:processes = @{}
foreach ($id in 1416, 3472, 1616, 3724, 9000) {
  $p = [pscustomobject]@{ Id = $id; HasExited = $false; StartTime = [datetime]'2026-10-03T22:00:00Z'; SafeHandle = 'fixture handle' }
  $p | Add-Member ScriptMethod WaitForExit { param($timeout)
    Add-Content $env:RECORD "wait:$($this.Id)"
    if ($this.Id -eq $script:survivor) { return $false }
    $this.HasExited = $true
    return $true
  }
  $p | Add-Member ScriptMethod Dispose { Add-Content $env:RECORD "dispose:$($this.Id)" }
  $script:processes[$id] = $p
}
if ($script:boundary -eq 'reused PID') { $script:processes[1616].StartTime = [datetime]'2026-10-03T22:01:00Z' }
$process = $script:processes[1416]
function Get-CimInstance {
  param($ClassName, $Property, $ErrorAction)
  if ($script:boundary -eq 'query denied') { throw 'Process ownership query denied' }
  if (($Property -join ',') -ne 'ProcessId,ParentProcessId,CreationDate') { throw 'Cleanup requested more than PID and creation-time metadata' }
  foreach ($pair in @(@(1616, 3472), @(1416, 999), @(3472, 1416), @(3724, 1416), @(9000, 999), @(8100, 1416))) {
    $created = if ($pair[0] -eq 8100) { [datetime]'2026-10-03T21:00:00Z' } else { [datetime]'2026-10-03T22:00:00Z' }
    [pscustomobject]@{ ProcessId = $pair[0]; ParentProcessId = $pair[1]; CreationDate = $created }
  }
}
function Get-Process { param($Id, $ErrorAction) $script:processes[[int]$Id] }
function taskkill.exe {
  if (($args -join ' ') -ne '/PID 1416 /T /F') { throw 'Cleanup must kill its root PID only' }
  Add-Content $env:RECORD 'kill:1416'
  if ($script:survivor -ne 1416) { $script:processes[1416].HasExited = $true }
  $global:LASTEXITCODE = ${taskkillCode}
}
if (Test-Path -LiteralPath '${helper}') { . '${helper}' }
${cleanup}
Stop-Tree
Add-Content $env:RECORD 'next smoke check'
`);
  return run(pwsh, ["-NoProfile", "-NonInteractive", "-File", harness], { env: { ...env, RECORD: join(scratch, "record") } });
};

describe.skipIf(!hasPwsh && !process.env["CI"])("Windows smoke process-tree cleanup", () => {
  it("continues after taskkill errors only when the entire owned tree has exited", async () => {
    await execute();
    const record = readFileSync(join(scratch, "record"), "utf8");
    expect(record).toContain("kill:1416");
    for (const id of [1416, 3472, 1616, 3724]) expect(record).toContain(`wait:${id}`);
    expect(record).not.toContain("wait:9000");
    expect(record).not.toContain("wait:8100");
    expect(record).toContain("next smoke check");
  });

  it.each([0, 128])("fails for a surviving descendant even when taskkill exits %s", async (code) => {
    await expect(execute(1616, code)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("surviving PIDs: 1616") });
    const record = readFileSync(join(scratch, "record"), "utf8");
    expect(record).toContain("wait:1616");
    expect(record).not.toContain("next smoke check");
    for (const id of [3472, 1616, 3724]) expect(record).toContain(`dispose:${id}`);
  });

  it("fails for a surviving root", async () => {
    await expect(execute(1416, 0)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("surviving PIDs: 1416") });
    expect(readFileSync(join(scratch, "record"), "utf8")).not.toContain("next smoke check");
  });

  it("does not wait on a PID reused by an unrelated process", async () => {
    await execute(0, 128, "reused PID");
    const record = readFileSync(join(scratch, "record"), "utf8");
    expect(record).toContain("dispose:1616");
    expect(record).not.toContain("wait:1616");
    expect(record).toContain("next smoke check");
  });

  it("fails before termination when ownership cannot be established", async () => {
    await expect(execute(0, 0, "query denied")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Process ownership query denied") });
  });

});
