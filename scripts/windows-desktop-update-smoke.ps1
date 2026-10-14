param([string]$Setup)
$ErrorActionPreference = 'Stop'
$helper = Join-Path $env:LOCALAPPDATA 'agent-harness\desktop\desktop-launch.ps1'
if (!(Test-Path -LiteralPath $helper)) { throw 'The installed desktop has no stable launcher' }
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\agent-harness.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
if ($link.TargetPath -notmatch 'powershell.exe$' -or !$link.Arguments.Contains($helper)) {
  throw 'The installed Start menu shortcut bypasses the stable launcher'
}
$protocol = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Classes\agent-harness\shell\open\command').'(default)'
if (!$protocol.Contains($helper)) { throw 'The installed protocol bypasses the stable launcher' }

$work = Join-Path $env:TEMP ('desktop-launch-check-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
$app = Join-Path $work 'incoming-app.cmd'
$receipt = Join-Path $work 'launched.txt'
$message = Join-Path $work 'waiting.txt'
$errors = Join-Path $work 'errors.txt'
$child = $null
$mutex = [Threading.Mutex]::new($true, 'Local\agent-harness-desktop-install')
$held = $true
$timer = [Diagnostics.Stopwatch]::StartNew()
try {
  # The executable does not exist yet. A launch must wait rather than fail
  # while setup owns the mutex, even under the ordinary user's smoke token.
  $child = Start-Process -FilePath powershell.exe -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $helper + '"'),
    '-App', ('"' + $app + '"'), '-NoWindow', '--updated'
  ) -PassThru -RedirectStandardOutput $message -RedirectStandardError $errors
  $deadline = [datetime]::UtcNow.AddMinutes(2)
  while (!(Test-Path -LiteralPath $message) -or !(Get-Content -LiteralPath $message -Raw)) {
    if ($child.HasExited) { throw ('The launch did not wait: ' + (Get-Content $errors -Raw)) }
    if ([datetime]::UtcNow -gt $deadline) { throw 'The launch did not report waiting' }
    Start-Sleep -Milliseconds 100
  }
  if ($child.HasExited -or (Test-Path -LiteralPath $receipt)) { throw 'The launch entered an incomplete installation' }
  if ((Get-Content $message -Raw) -notmatch 'finishing its update; it will open by itself') { throw 'The wait has no plain message' }
  Set-Content -LiteralPath $app -Encoding Ascii -Value ('@echo launched > "' + $receipt + '"')
  $mutex.ReleaseMutex()
  $held = $false
  if (!$child.WaitForExit(120000) -or $child.ExitCode -ne 0) { throw ('The waiting launch failed: ' + (Get-Content $errors -Raw)) }
  while (!(Test-Path -LiteralPath $receipt)) {
    if ([datetime]::UtcNow -gt $deadline) { throw 'The waiting launch never opened the completed installation' }
    Start-Sleep -Milliseconds 100
  }
  Write-Output "Verified installed Windows launch wait and release in $($timer.ElapsedMilliseconds)ms"
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  if ($null -ne $child -and !$child.HasExited) { $child.Kill(); $child.WaitForExit() }
  Remove-Item -LiteralPath $work -Recurse -Force
}

$log = Join-Path $env:LOCALAPPDATA 'agent-harness\desktop\logs\desktop-update.log'
if ($Setup) {
  # Staging mode (#2194): the running desktop has the next setup extract the app into versions\<version>
  # ahead of Restart to update. It must leave the installed app, its shortcuts and its protocol untouched.
  $install = Join-Path $env:LOCALAPPDATA 'Programs\agent-harness-desktop'
  $installed = Get-ChildItem -LiteralPath $install -Filter '*.exe' | Where-Object { $_.Name -notmatch '^Uninstall' } | Select-Object -First 1
  if ($null -eq $installed) { throw 'The installed desktop has no executable' }
  $before = $installed.LastWriteTimeUtc
  $staging = Join-Path $install 'versions\.smoke-staging'
  $stageTimer = [Diagnostics.Stopwatch]::StartNew()
  $stage = Start-Process -FilePath $Setup -ArgumentList @('/S', ('--stage=' + $staging)) -Wait -PassThru
  if ($stage.ExitCode -ne 0) { throw "The setup's staging mode exited with $($stage.ExitCode)" }
  if (!(Test-Path -LiteralPath (Join-Path $staging $installed.Name) -PathType Leaf)) { throw 'The staging mode extracted no app' }
  if ((Get-Item -LiteralPath $installed.FullName).LastWriteTimeUtc -ne $before) { throw 'The staging mode touched the installed app' }
  if (!$shell.CreateShortcut($shortcut).Arguments.Contains($helper)) { throw 'The staging mode changed the Start menu shortcut' }
  if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'agent-harness\desktop\current')) { throw 'The staging mode wrote the current version pointer' }
  Write-Output "Verified the setup's staging mode beside the installed app in $($stageTimer.ElapsedMilliseconds)ms"
  Remove-Item -LiteralPath (Join-Path $install 'versions') -Recurse -Force

  # The launch helper follows the pointer the desktop renames into place at the click.
  $pointerWork = Join-Path $env:TEMP ('desktop-pointer-check-' + [Guid]::NewGuid())
  $versionDir = Join-Path $pointerWork 'versions\9.9.9-smoke'
  New-Item -ItemType Directory -Path $versionDir | Out-Null
  $pointed = Join-Path $pointerWork 'pointed.txt'
  Set-Content -LiteralPath (Join-Path $versionDir 'app.cmd') -Encoding Ascii -Value ('@echo pointed > "' + $pointed + '"')
  $pointer = Join-Path $env:LOCALAPPDATA 'agent-harness\desktop\current'
  try {
    Set-Content -LiteralPath $pointer -Encoding Ascii -NoNewline -Value '9.9.9-smoke'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -App (Join-Path $pointerWork 'app.cmd') -NoWindow
    $pointerDeadline = [datetime]::UtcNow.AddSeconds(30)
    while (!(Test-Path -LiteralPath $pointed)) {
      if ([datetime]::UtcNow -gt $pointerDeadline) { throw 'The launch helper did not follow the current version pointer' }
      Start-Sleep -Milliseconds 100
    }
    Write-Output 'Verified the launch helper follows the current version pointer'
  } finally {
    Remove-Item -LiteralPath $pointer -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pointerWork -Recurse -Force
  }
}
# Restart to update's click to the new window, when an update was driven here (#2194).
if (Test-Path -LiteralPath $log) {
  $click = Select-String -LiteralPath $log -Pattern 'click to ready (\d+)ms' | Select-Object -Last 1
  if ($null -ne $click) {
    $ms = [int]$click.Matches[0].Groups[1].Value
    Write-Output "Restart to update: click to ready $($ms)ms"
    if ($ms -ge 10000) { throw "Click to ready must be under 10000ms, was $($ms)ms" }
  }
  Get-Content -LiteralPath $log
}

exit 0
