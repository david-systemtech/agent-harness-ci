import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
afterEach(async () => {
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
  const child = spawn(process.execPath, ["-e", `require('node:http').createServer((_, res) => res.end('ready')).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`], { stdio: ["ignore", "pipe", "inherit"] });
  processes.push(child);
  const lines = createInterface({ input: child.stdout! });
  const [line] = await once(lines, "line");
  lines.close();
  return { child, port: Number(line) };
};
const ready = async (port: number) => fetch(`http://127.0.0.1:${port}`).then(() => true, () => false);

describe.skipIf(!hasPwsh && !process.env["CI"])("Windows uninstall process ownership", () => {
  it.each(["running", "stopped", "wrong action", "inventory refused"])("uninstalls a %s task using process ownership, keeping unrelated processes", async (mode) => {
    expect(hasPwsh, "PowerShell is required in CI").toBe(true);
    const root = await server();
    const child = await server();
    const unrelated = await server();
    const reused = await server();
    let deleted = false;
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const fixture = `
$ErrorActionPreference = 'Stop'
$actions = [pscustomobject]@{ Count = 1 }
$actions | Add-Member ScriptMethod Item { param($index) [pscustomobject]@{ Path = ${quote(mode === "wrong action" ? "different-action.exe" : process.execPath)} } }
$task = [pscustomobject]@{ Enabled = $true; Definition = [pscustomobject]@{ Actions = $actions } }
$task | Add-Member ScriptMethod GetInstances { param($flags) ${mode === "stopped" ? "@()" : `@([pscustomobject]@{ EnginePID = ${root.child.pid} })`} }
$task | Add-Member ScriptMethod Stop { param($flags) ${mode === "stopped" ? "" : `[Diagnostics.Process]::GetProcessById(${root.child.pid}).Kill()`} }
$folder = [pscustomobject]@{}
$folder | Add-Member ScriptMethod GetTask { param($name) $task }
$scheduler = [pscustomobject]@{}
$scheduler | Add-Member ScriptMethod Connect { }
$scheduler | Add-Member ScriptMethod GetFolder { param($name) $folder }
function New-Object { param($ComObject) if ($ComObject -ne 'Schedule.Service') { throw 'Unexpected COM object' }; $scheduler }
function Get-CimInstance {
  param($ClassName, $Property)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected inventory' }
  ${mode === "inventory refused" ? "throw 'Inventory refused'" : ""}
  # A child listed first, an unrelated process, and a stale parent PID.
  [pscustomobject]@{ ProcessId = ${child.child.pid}; ParentProcessId = ${root.child.pid}; CreationDate = [Diagnostics.Process]::GetProcessById(${child.child.pid}).StartTime }
  [pscustomobject]@{ ProcessId = ${unrelated.child.pid}; ParentProcessId = 0; CreationDate = [Diagnostics.Process]::GetProcessById(${unrelated.child.pid}).StartTime }
  [pscustomobject]@{ ProcessId = ${reused.child.pid}; ParentProcessId = ${root.child.pid}; CreationDate = [DateTime]::UtcNow.AddYears(-1) }
}
`;
    const service = createServicePlatform(installContextAt("win32", "/test-home"), async (command, args) => {
      if (command === "powershell.exe") {
        const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
        return await run(pwsh, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(fixture + script, "utf16le").toString("base64")], { env }).then(
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
    await service.uninstall();
    expect(deleted).toBe(true);
    expect(await ready(root.port)).toBe(mode === "stopped");
    expect(await ready(child.port)).toBe(mode === "stopped");
    expect(await ready(unrelated.port)).toBe(true);
    expect(await ready(reused.port)).toBe(true);
  });
});
