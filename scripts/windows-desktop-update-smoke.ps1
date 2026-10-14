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
  if (!(Test-Path -LiteralPath (Join-Path $staging $installed.Name) -PathType Leaf)) {
    # Say what the setup made: the stage folder's files, and the folder cut short at its first "-", where the
    # setup's earlier --stage= parsing extracted the app instead.
    $found = if (Test-Path -LiteralPath $staging) { (Get-ChildItem -LiteralPath $staging -Name | Select-Object -First 20) -join ', ' } else { 'no such folder' }
    $cut = Join-Path $env:LOCALAPPDATA 'Programs\agent'
    $cutNote = if (Test-Path -LiteralPath (Join-Path $cut $installed.Name)) { "; the app was extracted into $cut instead" } else { '' }
    throw "The staging mode extracted no $($installed.Name) into $staging (it holds: $found)$cutNote"
  }
  if ((Get-Item -LiteralPath $installed.FullName).LastWriteTimeUtc -ne $before) { throw 'The staging mode touched the installed app' }
  if (!$shell.CreateShortcut($shortcut).Arguments.Contains($helper)) { throw 'The staging mode changed the Start menu shortcut' }
  if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'agent-harness\desktop\current')) { throw 'The staging mode wrote the current version pointer' }
  Write-Output "Verified the setup's staging mode beside the installed app in $($stageTimer.ElapsedMilliseconds)ms"

  # Restart to update's pointer switch (#2194), as the desktop makes it at the click: the staged version's
  # launch helper put in place, the switch under the install mutex, the click's time recorded, the rollback
  # watch started and the staged executable started as Electron's relaunch does. The new window logs
  # click to ready, asserted under 10000ms below.
  $dataDir = Join-Path $env:LOCALAPPDATA 'agent-harness\desktop'
  $stagedExe = Join-Path $staging $installed.Name
  # The staged version as the app names itself (app.getVersion(), what its click to ready line compares the click
  # file with): the version of the server it carries, which is the same release's. Not the executable's
  # ProductVersion, which electron-builder writes as four numbers (0.1.22-ci.176 as 0.1.22.0): with it the click
  # file named a version the switched app is not, the app took the file at ready without logging click to ready,
  # and the watch, seeing the file gone, rolled nothing back (#2227).
  $stagedVersion = (& (Join-Path $staging 'resources\server\node\node.exe') (Join-Path $staging 'resources\server\packages\cli\dist\main.js') --version 2>$null | Out-String).Trim() -replace '^agent-harness ', ''
  if ($LASTEXITCODE -ne 0 -or $stagedVersion -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') { throw "The staged app names no version: '$stagedVersion'" }
  $versionDir = Join-Path $install ('versions\' + $stagedVersion)
  Remove-Item -LiteralPath $versionDir -Recurse -Force -ErrorAction SilentlyContinue
  # A scan of the node.exe just run can hold the folder for a moment.
  for ($attempt = 1; ; $attempt++) {
    try { Rename-Item -LiteralPath $staging -NewName $stagedVersion; break } catch { if ($attempt -ge 20) { throw }; Start-Sleep -Milliseconds 500 }
  }
  $broughtHelper = Join-Path $versionDir 'desktop-launch.ps1'
  if (!(Test-Path -LiteralPath $broughtHelper -PathType Leaf)) { throw 'The staging mode extracted no launch helper beside the app' }
  $helperBefore = $helper + '.smoke-before'
  Copy-Item -LiteralPath $helper -Destination $helperBefore -Force
  $switchPointer = Join-Path $dataDir 'current'
  $clickFile = Join-Path $dataDir 'update-click.json'
  # The switched window is a first launch with "Run an environment on this machine" on, so it installs and
  # starts this machine's environment service from the server it carries (local-service.tsx). The ordinary
  # user's smoke expects no service after this check (smoke.ps1's `service status`), so what the window
  # installed is uninstalled and what it wrote beside the desktop's folder is removed in the finally below.
  $environmentDir = Join-Path $env:LOCALAPPDATA 'agent-harness'
  $environmentBefore = @(Get-ChildItem -LiteralPath $environmentDir -Force -Name -ErrorAction SilentlyContinue)
  $serverNode = Join-Path $install 'resources\server\node\node.exe'
  $serverCli = Join-Path $install 'resources\server\packages\cli\dist\main.js'
  $serviceBefore = (& $serverNode $serverCli service status 2>&1 | Out-String) -notmatch 'No service is installed'
  $switched = $null
  try {
    Copy-Item -LiteralPath $broughtHelper -Destination $helper -Force
    $clickAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Set-Content -LiteralPath $clickFile -Encoding Ascii -NoNewline -Value ('{"version":"' + $stagedVersion + '","at":' + $clickAt + '}')
    $switch = Start-Process -FilePath powershell.exe -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $helper + '"'),
      '-App', ('"' + $installed.FullName + '"'), '-Switch', $stagedVersion
    ) -Wait -PassThru
    if ($switch.ExitCode -ne 0) { throw "The launch helper's pointer switch exited with $($switch.ExitCode)" }
    if ((Get-Content -LiteralPath $switchPointer -Raw).Trim() -ne $stagedVersion) { throw 'The pointer switch did not point the launch at the staged version' }
    Start-Process -FilePath powershell.exe -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $helper + '"'),
      '-App', ('"' + $installed.FullName + '"'), '-Watch', $stagedVersion, '-Bound', '60'
    ) | Out-Null
    # What the switched app says on stderr (its app start line), for the failure below; left in the smoke user's TEMP.
    $switchedErrors = Join-Path $env:TEMP ('desktop-switched-' + [Guid]::NewGuid() + '.txt')
    $switched = Start-Process -FilePath (Join-Path $versionDir $installed.Name) -ArgumentList '--updated' -PassThru -RedirectStandardError $switchedErrors
    $readyDeadline = [datetime]::UtcNow.AddSeconds(75)
    $readyLine = $null
    while ($null -eq $readyLine -and [datetime]::UtcNow -lt $readyDeadline) {
      Start-Sleep -Milliseconds 250
      if (Test-Path -LiteralPath $log) { $readyLine = Select-String -LiteralPath $log -Pattern ([regex]::Escape($stagedVersion) + ':? (click to ready|rolled back)') | Select-Object -Last 1 }
    }
    if ($null -eq $readyLine) {
      # The watch rolls back at 60s while the click file is there, so nothing by 75s means the app took the file
      # without logging (a click file naming another version) or the watch never ran.
      $clickState = if (Test-Path -LiteralPath $clickFile) { 'still there' } else { 'taken' }
      $appState = if ($switched.HasExited) { "exited with $($switched.ExitCode)" } else { 'running' }
      $said = (Get-Content -LiteralPath $switchedErrors -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
      throw "Restart to update: the switched version $stagedVersion logged neither click to ready nor a rollback within 75s (the app $appState, the click file $clickState). It said: $said"
    }
    if ($readyLine.Line -match 'rolled back') { throw "The switched version did not report ready: $($readyLine.Line)" }
    $readyMs = [int]([regex]::Match($readyLine.Line, 'click to ready (\d+)ms').Groups[1].Value)
    Write-Output "Restart to update: click to ready $($readyMs)ms"
    if ($readyMs -ge 10000) { throw "Click to ready must be under 10000ms, was $($readyMs)ms" }
    Write-Output "Verified the pointer switch path: $($readyLine.Line)"
  } finally {
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($install, [StringComparison]::OrdinalIgnoreCase) -and $_.Name -notmatch '^Uninstall' } | Stop-Process -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $helperBefore -Destination $helper -Force
    Remove-Item -LiteralPath $switchPointer, ($switchPointer + '.previous'), $clickFile -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Remove-Item -LiteralPath (Join-Path $install 'versions') -Recurse -Force
    if (!$serviceBefore) {
      $serviceAfter = & $serverNode $serverCli service status 2>&1 | Out-String
      if ($serviceAfter -notmatch 'No service is installed') {
        & $serverNode $serverCli service uninstall
        if ($LASTEXITCODE -ne 0) { throw "Uninstalling the service the switched window installed exited with $LASTEXITCODE" }
      }
      # The service's launcher and environment run from the versions the install copied beside the desktop's folder.
      $environmentVersions = Join-Path $environmentDir 'versions'
      Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($environmentVersions, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
      Get-ChildItem -LiteralPath $environmentDir -Force -ErrorAction SilentlyContinue | Where-Object { $environmentBefore -notcontains $_.Name } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

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
# Restart to update's click to the new window, when an update was driven here without -Setup (#2194); with -Setup the
# check above already asserted it.
if (Test-Path -LiteralPath $log) {
  $click = Select-String -LiteralPath $log -Pattern 'click to ready (\d+)ms' | Select-Object -Last 1
  if ($null -ne $click -and !$Setup) {
    $ms = [int]$click.Matches[0].Groups[1].Value
    Write-Output "Restart to update: click to ready $($ms)ms"
    if ($ms -ge 10000) { throw "Click to ready must be under 10000ms, was $($ms)ms" }
  }
  Get-Content -LiteralPath $log
}

exit 0
