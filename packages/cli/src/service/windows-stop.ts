import { SERVICE_LABEL } from "./spec.js";
import { ServiceError } from "./errors.js";
import type { ServiceCommands } from "./runner.js";

/**
 * Task Scheduler's Stop ends the action (conhost), leaving cmd, the launcher
 * and the server alive. Repeated inventories account for births while parents
 * stop. Retained handles and creation/exit times establish ownership, which is
 * saved before Stop and on failure so retry can check surviving descendants.
 * Windows PowerShell is part of Windows, so this ships inside the CLI bundle.
 * Uninstall disables the task first, so nothing starts it while it goes; a
 * stop leaves it enabled, to start at the next logon (`$disableTask`).
 */
export const WINDOWS_STOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$handles = @{}
$owned = @{}
$stateFile = $null
$complete = $false
$failed = $false
$saveOnFailure = $false
function Stamp([DateTime] $time) { $time.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') }
function Open-OwnedHandle($node) {
  try { $handle = Get-Process -Id $node.id -ErrorAction Stop } catch {
    if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { return $null }
    throw
  }
  $null = $handle.SafeHandle
  if ((Stamp $handle.StartTime) -ne $node.start) { $handle.Dispose(); return $null }
  return $handle
}
function Update-ExitTimes {
  foreach ($id in $handles.Keys) {
    if ($handles[$id].HasExited) { $owned[$id].end = Stamp $handles[$id].ExitTime }
  }
}
function Save-Ownership {
  if ($owned.Count -eq 0) { return }
  $json = @{ schema = 1; nodes = @($owned.Values) } | ConvertTo-Json -Depth 4 -Compress
  $temporary = $stateFile + '.tmp'
  [IO.File]::WriteAllText($temporary, $json)
  if ([IO.File]::Exists($stateFile)) { [IO.File]::Replace($temporary, $stateFile, [NullString]::Value) }
  else { [IO.File]::Move($temporary, $stateFile) }
}
function Capture-Tree {
  if ($owned.Count -eq 0) { return 0 }
  # Replay exact identities on retry, even when Task Scheduler has no instances.
  foreach ($node in @($owned.Values)) {
    if (!$handles.ContainsKey($node.id) -and $node.end -eq '') {
      $handle = Open-OwnedHandle $node
      if ($null -eq $handle) { throw 'An owned process exited without a recorded exit time; after confirming the environment port is closed and all recorded processes have stopped, remove service-stop.json from the data directory and retry' }
      $handles[$node.id] = $handle
    }
  }
  Update-ExitTimes
  $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
  $total = 0
  do {
    $added = $false
    foreach ($row in $rows) {
      $id = [int]$row.ProcessId
      $parent = [int]$row.ParentProcessId
      if (!$owned.ContainsKey($id) -and $owned.ContainsKey($parent)) {
        if ($null -eq $row.CreationDate) { throw 'A scheduled task descendant has no creation time' }
        $created = Stamp $row.CreationDate
        $ancestor = $owned[$parent]
        # An exit time fences old parent PIDs, including after handles are closed.
        if ($created -lt $ancestor.start -or ($ancestor.end -ne '' -and $created -gt $ancestor.end)) { continue }
        $node = [pscustomobject]@{ id = $id; start = $created; end = ''; depth = $ancestor.depth + 1 }
        $handle = Open-OwnedHandle $node
        if ($null -eq $handle) { continue }
        $owned[$id] = $node
        $handles[$id] = $handle
        $added = $true
        $total++
      }
    }
  } while ($added)
  Update-ExitTimes
  return $total
}
try {
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $task = $scheduler.GetFolder('\').GetTask('${SERVICE_LABEL}')
  if ($disableTask) { $task.Enabled = $false }
  $actions = $task.Definition.Actions
  if ($actions.Count -ne 1) { throw 'The scheduled task must have one registered action' }
  $action = $actions.Item(1)
  if ([string]::IsNullOrWhiteSpace($action.WorkingDirectory)) { throw 'The scheduled task has no data directory for its cleanup record' }
  $stateFile = Join-Path $action.WorkingDirectory 'service-stop.json'
  if ([IO.File]::Exists($stateFile)) {
    $saved = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
    if ($saved.schema -ne 1 -or @($saved.nodes).Count -eq 0) { throw 'The service cleanup record is invalid; registration has been kept' }
    foreach ($node in $saved.nodes) {
      $id = [int]$node.id
      if ($id -le 0 -or $owned.ContainsKey($id) -or $node.start -notmatch '^\d{20}$' -or ($node.end -ne '' -and $node.end -notmatch '^\d{20}$') -or $node.depth -lt 0 -or $node.depth -gt 1024) {
        throw 'The service cleanup record has an invalid process identity; registration has been kept'
      }
      $node.id = $id
      $owned[$id] = $node
    }
  }
  foreach ($instance in $task.GetInstances(0)) {
    $id = [int]$instance.EnginePID
    if ($id -le 0) { throw 'The scheduled task did not identify its running process' }
    try { $root = Get-Process -Id $id -ErrorAction Stop } catch {
      if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { continue }
      throw
    }
    $null = $root.SafeHandle
    if (![string]::Equals($root.MainModule.FileName, [Environment]::ExpandEnvironmentVariables($action.Path), [StringComparison]::OrdinalIgnoreCase)) {
      $root.Dispose()
      throw 'The scheduled task process does not match its registered action'
    }
    $start = Stamp $root.StartTime
    if ($owned.ContainsKey($id) -and $owned[$id].start -ne $start) { $root.Dispose(); throw 'A scheduled task PID was reused during unfinished cleanup; registration has been kept' }
    $owned[$id] = [pscustomobject]@{ id = $id; start = $start; end = ''; depth = 0 }
    $handles[$id] = $root
  }
  $saveOnFailure = $true
  $null = Capture-Tree
  # Commit identities before Stop can remove the scheduler's last ownership link.
  Save-Ownership
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $task.Stop(0)
  do {
    $null = Capture-Tree
    Save-Ownership
    $live = @($owned.Values | Where-Object { $handles.ContainsKey($_.id) -and !$handles[$_.id].HasExited } | Sort-Object depth)
    if ($live.Count -eq 0) { break }
    if ($timer.ElapsedMilliseconds -ge 20000) { throw 'The scheduled task process tree did not stop within 20 seconds' }
    # Parents first: stop restart/spawn paths before stopping their children.
    foreach ($node in $live) {
      $handle = $handles[$node.id]
      if (!$handle.HasExited) { try { $handle.Kill() } catch { if (!$handle.HasExited) { throw } } }
      $remaining = [Math]::Max(0, 20000 - [int]$timer.ElapsedMilliseconds)
      if (!$handle.WaitForExit($remaining)) { throw 'A scheduled task process survived cleanup' }
      # Record each parent's exit before the next child's kill can fail.
      Update-ExitTimes
      Save-Ownership
    }
    # Retained parent handles and exit times allow the next inventory to find
    # children born after an earlier snapshot, without accepting reused PIDs.
  } while ($true)
  if ([IO.File]::Exists($stateFile)) { [IO.File]::Delete($stateFile) }
  $complete = $true
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $failed = $true
} finally {
  if (!$complete -and $saveOnFailure -and $null -ne $stateFile -and $owned.Count -gt 0) {
    try { Update-ExitTimes; Save-Ownership } catch { [Console]::Error.WriteLine($_.Exception.Message); $failed = $true }
  }
  foreach ($handle in $handles.Values) { $handle.Dispose() }
}
if ($failed) { exit 1 }
`;

/** Why the task's process tree is stopped: to uninstall the task, which disables it first, or to stop it until it next starts. */
export type WindowsStopPurpose = "uninstall" | "stop";

export const windowsStopArguments = (purpose: WindowsStopPurpose): string[] => [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(`$disableTask = $${purpose === "uninstall" ? "true" : "false"}\n${WINDOWS_STOP_SCRIPT}`, "utf16le").toString("base64"),
];

/** Report the failure without dumping the encoded script into the user's error. */
export const stopWindowsTask = async (commands: ServiceCommands, purpose: WindowsStopPurpose): Promise<void> => {
  const message = "Could not stop the scheduled task's process tree";
  const result = await commands.query("powershell.exe", windowsStopArguments(purpose)).catch((cause: unknown) => {
    throw new ServiceError(`${message}: Windows PowerShell could not run or did not finish within 30 seconds.`, { cause });
  });
  if (result.code !== 0) {
    throw new ServiceError(`${message}: ${result.stderr.trim() || `Windows PowerShell exited with ${result.code}`}`);
  }
};
