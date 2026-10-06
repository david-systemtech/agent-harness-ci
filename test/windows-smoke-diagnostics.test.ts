import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

async function capture(failCollector = false, timeout = false) {
  scratch = mkdtempSync(join(tmpdir(), "windows-smoke-diagnostics-"));
  mkdirSync(join(scratch, "data/logs"), { recursive: true });
  writeFileSync(join(scratch, "data/logs/service.log"), 'Authorization: Bearer service-test-secret\nAuthorization: Basic basic-test-secret\n{"token":"json-test-secret","api_key":"key with spaces","authorization":"Basic json-basic-test-secret"}\npassword=password-for-tests\n');
  writeFileSync(join(scratch, "data/entry-error.log"), "launcher error: token-for-tests alpha-secret-for-tests bravo-secret-for-tests");
  const workflow = releaseWorkflowInput(join(import.meta.dirname, "..")).hosted;
  const windows = workflow.split("  smoke-windows:\n")[1]?.split("  smoke-macos:\n")[0] ?? "";
  const wait = windows.match(/ {10}function Wait-Ready\([\s\S]*?\n {10}}/)?.[0] ?? "";
  // Use the actual timeout path, without spending 120 seconds in the fixture.
  const waitAtTimeout = wait.replace("[Diagnostics.Stopwatch]::StartNew()", "[pscustomobject]@{ Elapsed = [pscustomobject]@{ TotalSeconds = 120 } }");
  const harness = join(scratch, "capture.ps1");
  writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
. $env:DIAGNOSTICS_SCRIPT
$dataDir = Join-Path $env:FIXTURE_ROOT 'data'
$diagnostics = Join-Path $env:FIXTURE_ROOT 'diagnostics'
$diagnosticSecrets = @('password-for-tests', 'token-for-tests', 'alpha-secret-for-tests', 'bravo-secret-for-tests')
$smokeStartedAt = [datetime]::UtcNow.AddMinutes(-5)
$serviceLog = Join-Path $dataDir 'logs/service.log'
$process = $null
$port = 43210
$env:VERSION = '0.1.3'
$lastDiscovery = @{ harnessVersion = '0.1.2'; readiness = 'starting'; token = 'json-test-secret' }
$lastRequestError = 'connection refused'
function schtasks.exe { $global:LASTEXITCODE = 0; 'Last Result: 267009'; 'State: Ready'; 'password=password-for-tests' }
function Get-ScheduledTask { [pscustomobject]@{ TaskName = 'agent-harness'; State = 'Ready'; Principal = @{ LogonType = 'Password' } } }
function Get-ScheduledTaskInfo { [pscustomobject]@{ LastTaskResult = 267009 } }
function Export-ScheduledTask { '<Task><WorkingDirectory>fixture-data</WorkingDirectory><Password>password-for-tests</Password></Task>' }
function Get-WinEvent {
  [pscustomobject]@{ Id = 101; TimeCreated = [datetime]::UtcNow; Message = 'task failed token-for-tests Authorization: Basic event-test-secret'; ToXml = $null } | Add-Member -MemberType ScriptMethod -Name ToXml -Value { '<Event><EventData><Data Name="TaskName">\\agent-harness</Data></EventData></Event>' } -PassThru -Force
  [pscustomobject]@{ Id = 102; TimeCreated = [datetime]::UtcNow; Message = 'unrelated-task-event'; ToXml = $null } | Add-Member -MemberType ScriptMethod -Name ToXml -Value { '<Event><EventData><Data Name="TaskName">\\another-task</Data></EventData></Event>' } -PassThru -Force
}
function Get-CimInstance { ${failCollector ? "throw 'access denied token-for-tests'" : "[pscustomobject]@{ ProcessId = 23; ParentProcessId = 17; Name = 'node.exe'; ExecutablePath = 'fixture-node'; CreationDate = [datetime]::UtcNow; CommandLine = 'unrelated-process-secret' }"} }
function Get-NetTCPConnection { [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 43210; State = 'Listen'; OwningProcess = 23 } }
${timeout ? `${waitAtTimeout}
try { Wait-Ready 'scheduled-task start before uninstall (#1478)' } catch { Set-Content (Join-Path $env:FIXTURE_ROOT 'failure.txt') $_.Exception.Message }` : `Save-WindowsSmokeDiagnostics -OutputDirectory $diagnostics -DataDirectory $dataDir -Stage 'scheduled-task start before uninstall (#1478)' -Port $port -Version $env:VERSION -StartedAt $smokeStartedAt -LastDiscovery $lastDiscovery -LastRequestError $lastRequestError -Secrets $diagnosticSecrets`}
Remove-Item -LiteralPath $dataDir -Recurse -Force
`);
  await run(pwsh, ["-NoProfile", "-NonInteractive", "-File", harness], { env: {
    ...env, FIXTURE_ROOT: scratch,
    DIAGNOSTICS_SCRIPT: join(import.meta.dirname, "../scripts/windows-smoke-diagnostics.ps1"),
  } });
  const files = readdirSync(join(scratch, "diagnostics"), { recursive: true }).filter((name): name is string => typeof name === "string");
  return files.filter((name) => statSync(join(scratch, "diagnostics", name)).isFile()).map((name) => [name, readFileSync(join(scratch, "diagnostics", name), "utf8")] as const);
}

describe.skipIf(!hasPwsh && !process.env["CI"])("Windows smoke failure diagnostics", () => {
  it("redacts decoded JSON credentials and preserves the evidence's strings and arrays", async () => {
    scratch = mkdtempSync(join(tmpdir(), "windows-smoke-json-"));
    const harness = join(scratch, "json.ps1");
    writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
. $env:DIAGNOSTICS_SCRIPT
$secrets = @('fake"credential-suffix-for-tests', 'fake\\path-credential-for-tests', "fake\`nline-secret-for-tests")
for ($i = 0; $i -lt $secrets.Count; $i++) {
  $evidence = @{ message = "task error $($secrets[$i])"; password = $secrets[$i]; rows = @(@{ message = $secrets[$i] }); empty = @(); expectedVersion = '0.1.3' }
  Write-WindowsSmokeText -Path (Join-Path $env:FIXTURE_ROOT "$i.json") -Text ($evidence | ConvertTo-Json -Depth 12) -Secrets $secrets
  Write-WindowsSmokeText -Path (Join-Path $env:FIXTURE_ROOT "$i.log") -Text ("launcher output\`n" + ($evidence | ConvertTo-Json -Depth 12 -Compress)) -Secrets $secrets
}
$unknown = @{ password = 'unknown"credential-suffix-for-tests' }
Write-WindowsSmokeText -Path (Join-Path $env:FIXTURE_ROOT 'unknown.json') -Text ($unknown | ConvertTo-Json)
$keyed = [ordered]@{}
$keyed[$secrets[0]] = @{ count = 1 }
$keyed[$secrets[1]] = @{ count = 2 }
$keyed['password'] = 123456
$keyed['nested'] = [ordered]@{ token = $false; apiKey = $null; count = 3 }
Write-WindowsSmokeText -Path (Join-Path $env:FIXTURE_ROOT 'keyed.json') -Text ($keyed | ConvertTo-Json) -Secrets $secrets
`);
    await run(pwsh, ["-NoProfile", "-NonInteractive", "-File", harness], { env: {
      ...env, FIXTURE_ROOT: scratch, DIAGNOSTICS_SCRIPT: join(import.meta.dirname, "../scripts/windows-smoke-diagnostics.ps1"),
    } });
    for (let i = 0; i < 3; i++) {
      const expected = { message: "task error [REDACTED]", password: "[REDACTED]", rows: [{ message: "[REDACTED]" }], empty: [], expectedVersion: "0.1.3" };
      expect(JSON.parse(readFileSync(join(scratch, `${i}.json`), "utf8"))).toEqual(expected);
      expect(JSON.parse(readFileSync(join(scratch, `${i}.log`), "utf8").split("\n")[1] ?? "{}")).toEqual(expected);
    }
    expect(JSON.parse(readFileSync(join(scratch, "unknown.json"), "utf8"))).toEqual({ password: "[REDACTED]" });
    // A secret used as a key is redacted without one key overwriting another, and a
    // credential key's non-string value is redacted too.
    expect(JSON.parse(readFileSync(join(scratch, "keyed.json"), "utf8"))).toEqual({ "[REDACTED]": { count: 1 }, "[REDACTED] (2)": { count: 2 }, password: "[REDACTED]", nested: { token: "[REDACTED]", apiKey: null, count: 3 } });
  });

  it("retains task results, scoped events, logs, process and port state before fixture deletion, with credentials redacted", async () => {
    const files = await capture();
    const output = files.map(([name, content]) => `${name}\n${content}`).join("\n");
    expect(output).toContain("Last Result: 267009");
    expect(output).toContain("WorkingDirectory");
    expect(output).toContain("task failed [REDACTED]");
    expect(output).toContain("service.log");
    expect(output).toContain("launcher error: [REDACTED]");
    expect(output).toContain("fixture-node");
    expect(output).toContain("Listen");
    for (const secret of ["password-for-tests", "token-for-tests", "alpha-secret-for-tests", "bravo-secret-for-tests", "service-test-secret", "basic-test-secret", "json-basic-test-secret", "event-test-secret", "with spaces", "json-test-secret", "unrelated-process-secret", "unrelated-task-event"]) expect(output).not.toContain(secret);
    expect(JSON.parse(files.find(([name]) => name === "task-events.json")?.[1] ?? "[]")).toHaveLength(1);
    const predicate = JSON.parse(files.find(([name]) => name === "predicate.json")?.[1] ?? "{}");
    expect(predicate).toMatchObject({ stage: "scheduled-task start before uninstall (#1478)", endpoint: "http://127.0.0.1:43210/.well-known/agent-harness/environment", expectedVersion: "0.1.3", expectedReadiness: "ready", lastDiscovery: { harnessVersion: "0.1.2", readiness: "starting" }, lastRequestError: "connection refused" });
    expect(predicate.predicate).toContain("harnessVersion");
    expect(predicate.predicate).toContain("readiness");
  });

  it("records a collector failure without losing the other evidence or masking the smoke failure", async () => {
    const output = (await capture(true, true)).map(([, content]) => content).join("\n");
    expect(output).toContain("access denied [REDACTED]");
    expect(output).toContain("Last Result: 267009");
    expect(output).toContain("Listen");
    expect(readFileSync(join(scratch, "failure.txt"), "utf8")).toContain("scheduled-task start before uninstall (#1478) failed to become ready");
  });

  it("executes the hosted readiness timeout path and saves its exact predicate before cleanup", async () => {
    const files = await capture(false, true);
    expect(readFileSync(join(scratch, "failure.txt"), "utf8")).toContain("scheduled-task start before uninstall (#1478) failed to become ready");
    expect(JSON.parse(files.find(([name]) => name.endsWith("predicate.json"))?.[1] ?? "{}")).toMatchObject({ expectedVersion: "0.1.3", lastRequestError: "connection refused" });
  });
});
