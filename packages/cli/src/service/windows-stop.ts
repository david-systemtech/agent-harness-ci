import { SERVICE_LABEL } from "./spec.js";
import { ServiceError } from "./errors.js";
import type { ServiceCommands } from "./runner.js";

/**
 * Task Scheduler's Stop ends the action (conhost), leaving cmd, the launcher
 * and the server alive. Capture its instances and descendants before Stop,
 * then terminate and wait on retained process handles. The task's action and
 * creation times establish ownership; names and command-line matches do not.
 * Windows PowerShell is part of Windows, so this ships inside the CLI bundle.
 */
export const WINDOWS_STOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$handles = @{}
try {
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $task = $scheduler.GetFolder('\').GetTask('${SERVICE_LABEL}')
  # Prevent a new start while uninstall captures and stops the current instances.
  $task.Enabled = $false
  $owned = @{}
  foreach ($instance in $task.GetInstances(0)) {
    $id = [int]$instance.EnginePID
    if ($id -le 0) { throw 'The scheduled task did not identify its running process' }
    try { $root = Get-Process -Id $id -ErrorAction Stop } catch {
      if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { continue }
      throw
    }
    $handles[$id] = $root
    $null = $root.SafeHandle
    if ($root.HasExited) { continue }
    $actions = $task.Definition.Actions
    if ($actions.Count -ne 1 -or ![string]::Equals($root.MainModule.FileName, [Environment]::ExpandEnvironmentVariables($actions.Item(1).Path), [StringComparison]::OrdinalIgnoreCase)) {
      throw 'The scheduled task process does not match its registered action'
    }
    $owned[$id] = $root.StartTime.ToUniversalTime()
  }
  if ($owned.Count -gt 0) {
    $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
    do {
      $added = $false
      foreach ($row in $rows) {
        $id = [int]$row.ProcessId
        $parent = [int]$row.ParentProcessId
        if (!$owned.ContainsKey($id) -and $owned.ContainsKey($parent)) {
          if ($null -eq $row.CreationDate) { throw 'A scheduled task descendant has no creation time' }
          $created = $row.CreationDate.ToUniversalTime()
          if ($created.ToString('yyyyMMddHHmmssffffff') -lt $owned[$parent].ToString('yyyyMMddHHmmssffffff')) { continue }
          $owned[$id] = $created
          $added = $true
        }
      }
    } while ($added)
    foreach ($id in $owned.Keys) {
      if ($handles.ContainsKey($id)) { continue }
      try { $child = Get-Process -Id $id -ErrorAction Stop } catch {
        if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { continue }
        throw
      }
      $handles[$id] = $child
      $null = $child.SafeHandle
      if ($child.HasExited) { continue }
      if ($child.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -ne $owned[$id].ToString('yyyyMMddHHmmssffffff')) {
        $handles.Remove($id)
        $child.Dispose()
      }
    }
  }
  $task.Stop(0)
  foreach ($handle in $handles.Values) {
    if (!$handle.HasExited) {
      try { $handle.Kill() } catch { if (!$handle.HasExited) { throw } }
    }
  }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  foreach ($handle in $handles.Values) {
    $remaining = [Math]::Max(0, 10000 - [int]$timer.ElapsedMilliseconds)
    if (!$handle.WaitForExit($remaining)) { throw 'A scheduled task process survived cleanup' }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  foreach ($handle in $handles.Values) { $handle.Dispose() }
}
`;

export const windowsStopArguments = (): string[] => [
  "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_STOP_SCRIPT, "utf16le").toString("base64"),
];

/** Report the failure without dumping the encoded script into the user's error. */
export const stopWindowsTask = async (commands: ServiceCommands): Promise<void> => {
  const message = "Could not stop the scheduled task's process tree";
  const result = await commands.query("powershell.exe", windowsStopArguments()).catch((cause: unknown) => {
    throw new ServiceError(`${message}: Windows PowerShell could not run or did not finish within 30 seconds.`, { cause });
  });
  if (result.code !== 0) {
    throw new ServiceError(`${message}: ${result.stderr.trim() || `Windows PowerShell exited with ${result.code}`}`);
  }
};
