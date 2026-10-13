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
  Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'agent-harness\desktop\logs\desktop-update.log')
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  if ($null -ne $child -and !$child.HasExited) { $child.Kill(); $child.WaitForExit() }
  Remove-Item -LiteralPath $work -Recurse -Force
}

exit 0
