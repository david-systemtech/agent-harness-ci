import { execFile, spawnSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const pwsh = process.env["PWSH"] ?? "pwsh";
const env = { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off" };
const hasPwsh = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { env }).status === 0;

describe.skipIf(!hasPwsh && !process.env["CI"])("the Windows smoke's account-right script", () => {
  it("compiles its local security policy calls and offers a grant and a revoke by SID and right", async () => {
    // The policy calls themselves need Windows; the hosted smoke exercises them (#1683).
    const { stdout } = await run(pwsh, ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
. $env:RIGHTS_SCRIPT
. $env:RIGHTS_SCRIPT
$type = [AgentHarnessSmoke.LogonRights]
@(
  ($type.GetMethods() | Where-Object { $_.IsStatic -and $_.Name -in 'Grant', 'Revoke' } | ForEach-Object { $_.Name + '(' + (($_.GetParameters() | ForEach-Object ParameterType | ForEach-Object Name) -join ',') + ')' } | Sort-Object)
  foreach ($name in 'Grant-WindowsLogonRight', 'Revoke-WindowsLogonRight') {
    $name + ':' + (((Get-Command $name).Parameters.Keys | Where-Object { $_ -in 'Sid', 'Right' } | Sort-Object) -join ',')
  }
) -join "\`n"
`], { env: { ...env, RIGHTS_SCRIPT: join(import.meta.dirname, "../scripts/windows-logon-right.ps1") } });
    expect(stdout.trim().split("\n")).toEqual([
      "Grant(String,String)", "Revoke(String,String)",
      "Grant-WindowsLogonRight:Right,Sid", "Revoke-WindowsLogonRight:Right,Sid",
    ]);
  });
});
