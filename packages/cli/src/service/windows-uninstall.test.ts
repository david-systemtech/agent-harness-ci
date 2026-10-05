import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { installContextAt } from "../../test/service-helpers.js";
import { createServicePlatform } from "./platform.js";

const pwsh = process.env["PWSH"] ?? "pwsh";
const env = { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off" };
const hasPwsh = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { env }).status === 0;
const run = promisify(execFile);
const processes: ChildProcess[] = [];
const scratchDirectories: string[] = [];
afterEach(async () => {
  for (const directory of scratchDirectories.splice(0)) {
    const lateFile = join(directory, "late.json");
    if (existsSync(lateFile)) {
      const late: { pid: number } = JSON.parse(readFileSync(lateFile, "utf8"));
      try { process.kill(late.pid); } catch { /* Cleanup already stopped it. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
  await Promise.all(processes.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }));
});

// Real process handles and ports; only Task Scheduler and its CIM inventory are faked.
const server = async () => {
  const child = spawn(process.execPath, ["-e", `require('node:http').createServer(async (req, res) => {
    if (req.url === '/spawn') {
      const child = require('node:child_process').spawn(process.execPath, ['-e', "require('node:http').createServer((_, res) => res.end('ready')).listen(0, '127.0.0.1', function () { console.log(this.address().port); });"], { stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = require('node:readline').createInterface({ input: child.stdout });
      const [line] = await require('node:events').once(lines, 'line');
      lines.close(); res.end(JSON.stringify({ pid: child.pid, port: Number(line) }));
    } else { res.end('ready'); }
  }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`], { stdio: ["ignore", "pipe", "inherit"] });
  processes.push(child);
  const lines = createInterface({ input: child.stdout! });
  const [line] = await once(lines, "line");
  lines.close();
  return { child, port: Number(line) };
};
const ready = async (port: number) => fetch(`http://127.0.0.1:${port}`).then(() => true, () => false);

describe.skipIf(!hasPwsh && !process.env["CI"])("Windows uninstall process ownership", () => {
  it.each(["running", "stopped", "wrong action", "inventory refused", "birth during stop", "retry after failed kill", "retry with a reused PID"])("uninstalls a %s task using process ownership, keeping unrelated processes", async (mode) => {
    expect(hasPwsh, "PowerShell is required in CI").toBe(true);
    const root = await server();
    const child = await server();
    const unrelated = await server();
    const reused = await server();
    const directory = mkdtempSync(join(tmpdir(), "windows-uninstall-"));
    scratchDirectories.push(directory);
    const lateFile = join(directory, "late.json");
    const inventoryFile = join(directory, "inventory.txt");
    const birthFile = join(directory, "births.json");
    let deleted = false;
    let executions = 0;
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const fixture = `
$ErrorActionPreference = 'Stop'
$births = @{}
if (Test-Path ${quote(birthFile)}) { $times = Get-Content -Raw ${quote(birthFile)} | ConvertFrom-Json }
else {
  $times = foreach ($id in @(${root.child.pid}, ${child.child.pid}, ${unrelated.child.pid}, ${reused.child.pid})) {
    $process = Microsoft.PowerShell.Management\\Get-Process -Id $id
    @{ id = $id; time = $process.StartTime.ToUniversalTime().ToString('o') }
  }
  [IO.File]::WriteAllText(${quote(birthFile)}, ($times | ConvertTo-Json -Compress))
}
foreach ($time in $times) { $births[[int]$time.id] = ([DateTime]$time.time).ToUniversalTime() }
$script:refuseKill = $false
function Get-Process {
  param($Id, $ErrorAction)
  $process = Microsoft.PowerShell.Management\\Get-Process -Id $Id -ErrorAction $ErrorAction
  if ($null -ne $process) {
    # Linux derives StartTime from uptime, with a different sub-millisecond
    # offset per interpreter. Hold the inventory's birth dates across retries.
    if ($births.ContainsKey([int]$Id)) { $process | Add-Member NoteProperty StartTime $births[[int]$Id] -Force }
    if ($script:refuseKill -and $Id -eq ${child.child.pid}) { $process | Add-Member ScriptMethod Kill { throw 'Kill refused' } -Force }
  }
  $process
}
$actions = [pscustomobject]@{ Count = 1 }
$actions | Add-Member ScriptMethod Item { param($index) [pscustomobject]@{ Path = ${quote(mode === "wrong action" ? "different-action.exe" : process.execPath)}; WorkingDirectory = ${quote(directory)} } }
$task = [pscustomobject]@{ Enabled = $true; Definition = [pscustomobject]@{ Actions = $actions } }
$task | Add-Member ScriptMethod GetInstances { param($flags)
  ${mode === "stopped" ? "@()" : `if (Microsoft.PowerShell.Management\\Get-Process -Id ${root.child.pid} -ErrorAction SilentlyContinue) { @([pscustomobject]@{ EnginePID = ${root.child.pid} }) } else { @() }`}
}
$task | Add-Member ScriptMethod Stop { param($flags)
  ${mode === "stopped" ? "" : `$root = Microsoft.PowerShell.Management\\Get-Process -Id ${root.child.pid} -ErrorAction SilentlyContinue; if ($null -ne $root) { $root.Kill() }`}
}
$folder = [pscustomobject]@{}
$folder | Add-Member ScriptMethod GetTask { param($name) $task }
$scheduler = [pscustomobject]@{}
$scheduler | Add-Member ScriptMethod Connect { }
$scheduler | Add-Member ScriptMethod GetFolder { param($name) $folder }
function New-Object { param($ComObject) if ($ComObject -ne 'Schedule.Service') { throw 'Unexpected COM object' }; $scheduler }
function Get-CimInstance {
  param($ClassName, $Property)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected inventory' }
  Add-Content -LiteralPath ${quote(inventoryFile)} -Value inventory
  ${mode === "inventory refused" ? "throw 'Inventory refused'" : ""}
  # A child listed first, an unrelated process, and a stale parent PID.
  foreach ($item in @(@{ Id = ${child.child.pid}; Parent = ${root.child.pid} }, @{ Id = ${unrelated.child.pid}; Parent = 0 }, @{ Id = ${reused.child.pid}; Parent = ${root.child.pid} })) {
    $process = Microsoft.PowerShell.Management\\Get-Process -Id $item.Id -ErrorAction SilentlyContinue
    if ($null -ne $process) {
      $created = if ($item.Id -eq ${reused.child.pid}) { $births[${root.child.pid}].AddYears(-1) } else { $births[[int]$item.Id] }
      [pscustomobject]@{ ProcessId = $item.Id; ParentProcessId = $item.Parent; CreationDate = $created }
    }
  }
  ${mode === "birth during stop" ? `
  if (Test-Path ${quote(lateFile)}) {
    $late = Get-Content -Raw ${quote(lateFile)} | ConvertFrom-Json
    $process = Microsoft.PowerShell.Management\\Get-Process -Id $late.pid -ErrorAction SilentlyContinue
    if ($null -ne $process) { [pscustomobject]@{ ProcessId = $late.pid; ParentProcessId = ${root.child.pid}; CreationDate = $process.StartTime } }
  } else {
    # The root creates a real child after this inventory was collected.
    $late = Invoke-RestMethod 'http://127.0.0.1:${root.port}/spawn'
    [IO.File]::WriteAllText(${quote(lateFile)}, ($late | ConvertTo-Json -Compress))
  }` : ""}
}
`;
    const service = createServicePlatform(installContextAt("win32", "/test-home"), async (command, args) => {
      if (command === "powershell.exe") {
        executions++;
        const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
        const refusal = mode.startsWith("retry") && executions === 1 ? "$script:refuseKill = $true\n" : "";
        const scriptFile = join(directory, "cleanup.ps1");
        writeFileSync(scriptFile, fixture + refusal + script);
        return await run(pwsh, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile], { env }).then(
          ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
          (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
        );
      }
      if (args[0] === "/End") {
        const exited = once(root.child, "exit");
        root.child.kill();
        await exited;
      }
      if (args[0] === "/Delete") {
        // Deleting registration must follow verified shutdown, not hide surviving children.
        expect(await ready(child.port)).toBe(mode === "stopped");
        if (existsSync(lateFile)) {
          const late: { port: number } = JSON.parse(readFileSync(lateFile, "utf8"));
          expect(await ready(late.port), "the child born after inventory must exit before unregistering").toBe(false);
        }
        deleted = true;
      }
      return { code: 0, stdout: '"\\agent-harness","N/A","Running"\r\n', stderr: "" };
    });

    expect(await ready(child.port)).toBe(true);
    if (mode === "wrong action" || mode === "inventory refused") {
      await expect(service.uninstall()).rejects.toThrow(mode === "wrong action" ? /does not match its registered action/ : /Inventory refused/);
      expect(deleted).toBe(false);
      expect(await ready(root.port)).toBe(true);
      expect(await ready(child.port)).toBe(true);
      return;
    }
    if (mode.startsWith("retry")) {
      await expect(service.uninstall()).rejects.toThrow(/Kill refused/);
      expect(deleted).toBe(false);
      expect(await ready(root.port)).toBe(false);
      expect(await ready(child.port)).toBe(true);
      const recordFile = join(directory, "service-stop.json");
      if (mode === "retry with a reused PID") {
        const record: { nodes: { id: number; start: string }[] } = JSON.parse(readFileSync(recordFile, "utf8"));
        const survivor = record.nodes.find((node) => node.id === child.child.pid);
        expect(survivor).toBeDefined();
        survivor!.start = "20000101000000000000";
        writeFileSync(recordFile, JSON.stringify(record));
        await expect(service.uninstall()).rejects.toThrow(/without a recorded exit time/);
        expect(deleted).toBe(false);
        expect(await ready(child.port)).toBe(true);
        expect(await ready(unrelated.port)).toBe(true);
        return;
      }
      const beforeRetry = readFileSync(inventoryFile, "utf8");
      await service.uninstall();
      expect(readFileSync(inventoryFile, "utf8").length).toBeGreaterThan(beforeRetry.length);
      expect(existsSync(recordFile)).toBe(false);
    } else {
      await service.uninstall();
    }
    expect(deleted).toBe(true);
    expect(await ready(root.port)).toBe(mode === "stopped");
    expect(await ready(child.port)).toBe(mode === "stopped");
    expect(await ready(unrelated.port)).toBe(true);
    expect(await ready(reused.port)).toBe(true);
  });
});
