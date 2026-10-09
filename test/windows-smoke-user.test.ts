import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Run the hosted job's PowerShell at the account/process boundary, without creating OS users. */
const execute = async (exitCode: number, blockedSource = "", grantFails = false) => {
  scratch = mkdtempSync(join(tmpdir(), "windows-smoke-user-"));
  const workflow = releaseWorkflowInput(join(import.meta.dirname, "..")).hosted;
  const job = workflow.split("  smoke-windows:\n")[1]?.split("  smoke-macos:\n")[0] ?? "";
  const command = job.split("        run: |\n")[1]?.split(/^ {6}- /m)[0] ?? "";
  const script = command.split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  mkdirSync(join(scratch, "desktop"));
  writeFileSync(join(scratch, "desktop/agent-harness-desktop-win32-x64-setup.exe"), "fixture setup");
  mkdirSync(join(scratch, "scripts"));
  copyFileSync(join(import.meta.dirname, "../scripts/check-packaged-extension.mjs"),
    join(scratch, "scripts/check-packaged-extension.mjs"));
  copyFileSync(join(import.meta.dirname, "../scripts/stop-windows-process-tree.ps1"),
    join(scratch, "scripts/stop-windows-process-tree.ps1"));
  copyFileSync(join(import.meta.dirname, "../scripts/windows-smoke-diagnostics.ps1"),
    join(scratch, "scripts/windows-smoke-diagnostics.ps1"));
  copyFileSync(join(import.meta.dirname, "../scripts/check-packaged-update-disk.mjs"),
    join(scratch, "scripts/check-packaged-update-disk.mjs"));
  copyFileSync(join(import.meta.dirname, "../scripts/check-packaged-provider-sign-in.mjs"),
    join(scratch, "scripts/check-packaged-provider-sign-in.mjs"));
  copyFileSync(join(import.meta.dirname, "../scripts/check-packaged-terminal-state.mjs"),
    join(scratch, "scripts/check-packaged-terminal-state.mjs"));
  copyFileSync(join(import.meta.dirname, "../scripts/check-packaged-terminal-drain.mjs"),
    join(scratch, "scripts/check-packaged-terminal-drain.mjs"));
  copyFileSync(join(import.meta.dirname, "../scripts/check-packaged-bank-describe.mjs"),
    join(scratch, "scripts/check-packaged-bank-describe.mjs"));
  writeFileSync(join(scratch, "scripts/install.ps1"), "fixture installer");
  // The real script calls the local security policy; record the boundary instead.
  writeFileSync(join(scratch, "scripts/windows-logon-right.ps1"), `
function Grant-WindowsLogonRight { param([Parameter(Mandatory)][string] $Sid, [Parameter(Mandatory)][string] $Right)
  if ('${grantFails}' -eq 'true') { throw 'fixture policy refused the right' }
  Add-Content $env:RECORD "granted:\${Right}:$Sid"
}
function Revoke-WindowsLogonRight { param([Parameter(Mandatory)][string] $Sid, [Parameter(Mandatory)][string] $Right)
  Add-Content $env:RECORD "revoked:\${Right}:$Sid"
}
`);
  const harness = join(scratch, "harness.ps1");
  writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
$env:VERSION = '0.1.1'
$env:PUBLIC = $env:FIXTURE_ROOT
# Keep the cmdlet's typed member boundary without creating OS users.
class FixtureLocalPrincipal { [object] $SID }
function New-LocalUser { param($Name, $Password, [switch] $AccountNeverExpires, [switch] $PasswordNeverExpires)
  if ($Password -isnot [Security.SecureString]) { throw 'Password must stay in a secure string' }
  $script:user = $Name
  $script:account = [FixtureLocalPrincipal]::new()
  $script:account.SID = [pscustomobject]@{ Value = 'fixture-user-sid' }
  $script:account
}
function Add-LocalGroupMember { param($SID, [FixtureLocalPrincipal[]] $Member)
  if ($SID -ne 'S-1-5-32-545') { throw 'Smoke user must join Users only' }
  if ($Member.Count -ne 1 -or ![object]::ReferenceEquals($Member[0], $script:account)) { throw 'Group member must be the created local principal' }
  Add-Content $env:RECORD "member:$($Member[0].SID.Value)"
}
function Remove-LocalUser { param($Name)
  if ($null -ne $script:lockedFile) { $script:lockedFile.Dispose() }
  Add-Content $env:RECORD "removed:$Name"
}
function icacls.exe { $global:LASTEXITCODE = 0 }
function wevtutil.exe { $global:LASTEXITCODE = 0 }
function Get-WinEvent {
  [pscustomobject]@{ Id = 101; TimeCreated = [datetime]::UtcNow; Message = 'runner task event' } | Add-Member -MemberType ScriptMethod -Name ToXml -Value { '<Event><EventData><Data Name="TaskName">\\agent-harness</Data></EventData></Event>' } -PassThru
}
function Start-Process {
  param($FilePath, $ArgumentList, $Credential, [switch] $LoadUserProfile, [switch] $UseNewEnvironment,
    $WorkingDirectory, $RedirectStandardOutput, $RedirectStandardError, [switch] $Wait, [switch] $PassThru)
  if (!$Credential -or !$LoadUserProfile -or !$UseNewEnvironment -or !$Wait) { throw 'Smoke launched without an ordinary-user profile and credential' }
  if ($Credential.UserName -notlike "*\\$script:user") { throw 'Smoke credential does not name the created user' }
  if ($ArgumentList -match [regex]::Escape($Credential.GetNetworkCredential().Password)) { throw 'Password reached process arguments' }
  if ((Get-Content -Raw (Join-Path $WorkingDirectory 'install.ps1')) -ne 'fixture installer') { throw 'The public installer was not staged for the ordinary user' }
  if (!(Test-Path (Join-Path $WorkingDirectory 'scripts/check-packaged-update-disk.mjs'))) { throw 'The disk smoke was not staged for the ordinary user' }
  if (!(Test-Path (Join-Path $WorkingDirectory 'scripts/check-packaged-provider-sign-in.mjs'))) { throw 'The provider smoke was not staged for the ordinary user' }
  if (!(Test-Path (Join-Path $WorkingDirectory 'scripts/check-packaged-terminal-state.mjs'))) { throw 'The terminal smoke was not staged for the ordinary user' }
  if (!(Test-Path (Join-Path $WorkingDirectory 'scripts/check-packaged-terminal-drain.mjs'))) { throw 'The terminal drain smoke was not staged for the ordinary user' }
  if (!(Test-Path (Join-Path $WorkingDirectory 'scripts/check-packaged-bank-describe.mjs'))) { throw 'The bank smoke was not staged for the ordinary user' }
  $child = Join-Path $WorkingDirectory 'smoke.ps1'
  Copy-Item $child $env:CHILD_COPY
  Set-Content $RedirectStandardOutput ('ordinary-user child output password=' + $Credential.GetNetworkCredential().Password)
  Set-Content $RedirectStandardError 'ordinary-user child error'
  New-Item -ItemType Directory -Path (Join-Path $WorkingDirectory 'diagnostics') -Force | Out-Null
  Set-Content (Join-Path $WorkingDirectory 'diagnostics/task-query.txt') ('task result: 267009 password=' + $Credential.GetNetworkCredential().Password)
  if ('${blockedSource}' -eq 'diagnostic') {
    $path = Join-Path $WorkingDirectory 'diagnostics/00-locked.txt'
    Set-Content $path 'locked diagnostic'
    $script:lockedFile = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  } elseif ('${blockedSource}' -eq 'stdout') {
    $script:lockedFile = [IO.File]::Open($RedirectStandardOutput, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  } elseif ('${blockedSource}' -eq 'destination') {
    New-Item -ItemType Directory -Path (Join-Path $env:FIXTURE_ROOT 'windows-smoke-diagnostics/task-query.txt') -Force | Out-Null
  }
  Add-Content $env:RECORD 'ordinary-user launch'
  [pscustomobject]@{ ExitCode = ${exitCode} }
}
${script}
`);
  return run(pwsh, ["-NoProfile", "-NonInteractive", "-File", harness], { cwd: scratch,
    env: { ...env, FIXTURE_ROOT: scratch, RECORD: join(scratch, "record"), CHILD_COPY: join(scratch, "child.ps1") } });
};

describe.skipIf(!hasPwsh && !process.env["CI"])("the Windows smoke's user token", () => {
  it("launches the whole smoke under the temporary ordinary user's profile", async () => {
    const result = await execute(0);
    expect(result.stdout).toContain("ordinary-user child output");
    const record = readFileSync(join(scratch, "record"), "utf8");
    // A Password-logon task is a batch logon, which Users lack on Windows Server (#1683).
    expect(record.trim().split("\n").map((line) => line.replace(/ah-smoke-\w+/, "ah-smoke-user"))).toEqual([
      "member:fixture-user-sid", "granted:SeBatchLogonRight:fixture-user-sid", "ordinary-user launch",
      "revoked:SeBatchLogonRight:fixture-user-sid", "removed:ah-smoke-user",
    ]);
    const child = readFileSync(join(scratch, "child.ps1"), "utf8");
    expect(child).toContain("S-1-16-(\\d+)");
    expect(child).toContain("foreach ($attempt in 1, 2)");
    expect(child).toContain("$stagingLimitSeconds = 90");
    expect(child).toContain("launcher-entry.cmd");
    expect(child).toContain("Stop-OwnedProcessTree -Root $process");
    expect(readFileSync(join(scratch, "scripts/stop-windows-process-tree.ps1"), "utf8")).toContain("$handle.WaitForExit($remaining)");
  });

  it("propagates a failed smoke and removes its temporary account", async () => {
    await expect(execute(7)).rejects.toMatchObject({ code: 1 });
    expect(readFileSync(join(scratch, "record"), "utf8")).toMatch(/revoked:SeBatchLogonRight:fixture-user-sid\nremoved:ah-smoke-/);
    expect(readFileSync(join(scratch, "windows-smoke-diagnostics/task-query.txt"), "utf8").trim()).toBe("task result: 267009 password=[REDACTED]");
    expect(readFileSync(join(scratch, "windows-smoke-diagnostics/stdout.log"), "utf8").trim()).toBe("ordinary-user child output password=[REDACTED]");
  });

  it("fails before the smoke when the batch logon right cannot be granted, and still removes the account", async () => {
    await expect(execute(0, "", true)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("fixture policy refused the right") });
    const record = readFileSync(join(scratch, "record"), "utf8");
    expect(record).not.toContain("ordinary-user launch");
    expect(record).not.toContain("revoked:");
    expect(record).toMatch(/removed:ah-smoke-/);
  });

  it.each(["diagnostic", "stdout", "destination"])("retains the remaining evidence when the %s source cannot be copied", async (source) => {
    await expect(execute(7, source)).rejects.toMatchObject({ code: 1 });
    expect(readFileSync(join(scratch, "record"), "utf8")).toMatch(/removed:ah-smoke-/);
    expect(readFileSync(join(scratch, "windows-smoke-diagnostics/stderr.log"), "utf8").trim()).toBe("ordinary-user child error");
    const events = JSON.parse(readFileSync(join(scratch, "windows-smoke-diagnostics/runner-task-events.json"), "utf8"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ message: "runner task event" });
    if (source !== "stdout") expect(readFileSync(join(scratch, "windows-smoke-diagnostics/stdout.log"), "utf8").trim()).toBe("ordinary-user child output password=[REDACTED]");
    if (source !== "destination") expect(readFileSync(join(scratch, "windows-smoke-diagnostics/task-query.txt"), "utf8").trim()).toBe("task result: 267009 password=[REDACTED]");
  });

  it.each([
    ["S-1-16-8192", true],
    ["S-1-16-12288", false],
    ["no mandatory level", false],
  ] as const)("checks a multiline child token containing %s", async (level, allowed) => {
    await execute(0);
    const child = readFileSync(join(scratch, "child.ps1"), "utf8");
    const token = child.slice(child.indexOf("$groups ="), child.indexOf("$PSNativeCommandUseErrorActionPreference"));
    const probe = token.replace('& "$env:SystemRoot\\System32\\whoami.exe" /groups',
      `& { $global:LASTEXITCODE = 0; 'ordinary groups'; '${level}' }`);
    const result = run(pwsh, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${probe}`], { env });
    if (allowed) expect((await result).stdout).toContain("mandatory level: 8192");
    else await expect(result).rejects.toMatchObject({ code: 1 });
  });
});
