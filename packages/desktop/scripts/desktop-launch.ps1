param(
  [Parameter(Mandatory=$true)][string]$App,
  [string]$Link,
  [switch]$Updated,
  [switch]$Prepare,
  [switch]$NoWindow,
  # At Restart to update (#2194): watch the version just switched to, and go back if it never gets ready.
  [string]$Watch,
  [int]$Bound = 60,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$LaunchArguments
)

# The shortcuts run this copy outside Programs: setup can replace app.asar
# without a manual launch opening an incomplete app or locking its files.
$ErrorActionPreference = 'Stop'
if ($Prepare) {
  # Existing taskbar pins are copies of shortcuts, so changing the Start
  # menu alone leaves a pin pointing into the files setup is replacing.
  $pins = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
  if (Test-Path -LiteralPath $pins) {
    $shell = New-Object -ComObject WScript.Shell
    Get-ChildItem -LiteralPath $pins -Filter '*.lnk' | ForEach-Object {
      $pin = $shell.CreateShortcut($_.FullName)
      if ($pin.TargetPath -eq $App) {
        $pin.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $pin.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -App "' + $App + '"'
        $pin.Save()
      }
    }
  }
  exit 0
}
$versionPattern = '^[0-9A-Za-z][0-9A-Za-z.+-]*
  if ($argument -eq '--updated') { $Updated = $true }
  else { throw 'Invalid desktop launch argument' }
}
$mutex = $null
$form = $null
try {
  try { $mutex = [Threading.Mutex]::OpenExisting('Local\agent-harness-desktop-install') }
  catch [Threading.WaitHandleCannotBeOpenedException] { }
  if ($null -ne $mutex) {
    $message = 'agent-harness is finishing its update; it will open by itself'
    if (!$NoWindow) {
      Add-Type -AssemblyName System.Windows.Forms
      $form = New-Object Windows.Forms.Form
      $form.Text = 'agent-harness'
      $form.Width = 480
      $form.Height = 140
      $form.StartPosition = 'CenterScreen'
      $form.ControlBox = $false
      $label = New-Object Windows.Forms.Label
      $label.Text = $message
      $label.Dock = 'Fill'
      $label.Padding = New-Object Windows.Forms.Padding(20)
      $form.Controls.Add($label)
      $form.Show()
    }
    Write-Output $message
    $entered = $false
    try {
      while (!$entered) {
        try { $entered = $mutex.WaitOne(200) }
        catch [Threading.AbandonedMutexException] { $entered = $true }
        if ($null -ne $form) { [Windows.Forms.Application]::DoEvents() }
      }
    } finally {
      if ($entered) { $mutex.ReleaseMutex() }
    }
    # A launch that waited is an update launch too, even if it wins the race
    # with setup's force-run. Electron's lock combines the two afterwards.
    $Updated = $true
  }
} finally {
  if ($null -ne $mutex) { $mutex.Dispose() }
  if ($null -ne $form) { $form.Dispose() }
}
# A version installed beside the app ahead of Restart to update (#2194):
# the desktop renames the pointer into place at the click, naming it.
if (Test-Path -LiteralPath $pointer -PathType Leaf) {
  # An empty pointer reads as $null; the cast keeps Trim from throwing.
  $candidate = Get-VersionApp ([string](Get-Content -LiteralPath $pointer -Raw)).Trim()
  if ($null -ne $candidate) { $App = $candidate }
}
$arguments = @()
if ($Updated) { $arguments += '--updated' }
if ($Link) {
  # Only the app's deep links are forwarded, as one quoted argument. Never
  # allow quotes to turn a URL into another command-line option.
  if ($Link -notmatch '^agent-harness://' -or $Link.Contains('"')) { throw 'Invalid desktop link' }
  $arguments += '"' + $Link + '"'
}
if ($arguments.Count) { Start-Process -FilePath $App -ArgumentList $arguments }
else { Start-Process -FilePath $App }

$pointer = Join-Path $PSScriptRoot 'current'
$previousPointer = Join-Path $PSScriptRoot 'current.previous'
$installRoot = Split-Path -Parent $App
$exeName = Split-Path -Leaf $App
function Get-VersionApp([string]$name) {
  if ($name -notmatch $versionPattern) { return $null }
  $candidate = Join-Path (Join-Path (Join-Path $installRoot 'versions') $name) $exeName
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  return $null
}
function Write-UpdateLog([string]$line) {
  $logs = Join-Path $PSScriptRoot 'logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  [IO.File]::AppendAllText((Join-Path $logs 'desktop-update.log'), $line + [char]13 + [char]10)
}
if ($Watch) {
  # The old process started this as it quit for the switch to $Watch. The new
  # process removes the click file once its window is ready (the moment it logs
  # click to ready); a click file still there after the bound means the new
  # version did not start, so the pointer goes back to the version before it
  # (current.previous, written at the switch) and that version is started.
  if ($Watch -notmatch $versionPattern) { throw 'Invalid desktop version' }
  $click = Join-Path $PSScriptRoot 'update-click.json'
  $deadline = [datetime]::UtcNow.AddSeconds($Bound)
  while ([datetime]::UtcNow -lt $deadline) {
    if (!(Test-Path -LiteralPath $click)) { exit 0 }
    Start-Sleep -Milliseconds 250
  }
  $incoming = Get-VersionApp $Watch
  $previous = ''
  if (Test-Path -LiteralPath $previousPointer -PathType Leaf) { $previous = ([string](Get-Content -LiteralPath $previousPointer -Raw)).Trim() }
  $mutex = [Threading.Mutex]::new($false, 'Local\agent-harness-desktop-install')
  $entered = $false
  try {
    try { $entered = $mutex.WaitOne() } catch [Threading.AbandonedMutexException] { $entered = $true }
    $now = ''
    if (Test-Path -LiteralPath $pointer -PathType Leaf) { $now = ([string](Get-Content -LiteralPath $pointer -Raw)).Trim() }
    # A setup or another switch since then decided what launches: leave it.
    if ($now -ne $Watch) { exit 0 }
    if ($previous -and (Get-VersionApp $previous)) { [IO.File]::WriteAllText($pointer, $previous) }
    else { Remove-Item -LiteralPath $pointer -Force }
  } finally {
    if ($entered) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
  if ($null -ne $incoming) { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $incoming } | Stop-Process -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $click -Force -ErrorAction SilentlyContinue
  Write-UpdateLog ($Watch + ' rolled back: it did not report ready within ' + $Bound + 's')
  $back = $App
  if ($previous) { $found = Get-VersionApp $previous; if ($null -ne $found) { $back = $found } }
  Start-Process -FilePath $back
  exit 0
}
foreach ($argument in $LaunchArguments) {
  if ($argument -eq '--updated') { $Updated = $true }
  else { throw 'Invalid desktop launch argument' }
}
$mutex = $null
$form = $null
try {
  try { $mutex = [Threading.Mutex]::OpenExisting('Local\agent-harness-desktop-install') }
  catch [Threading.WaitHandleCannotBeOpenedException] { }
  if ($null -ne $mutex) {
    $message = 'agent-harness is finishing its update; it will open by itself'
    if (!$NoWindow) {
      Add-Type -AssemblyName System.Windows.Forms
      $form = New-Object Windows.Forms.Form
      $form.Text = 'agent-harness'
      $form.Width = 480
      $form.Height = 140
      $form.StartPosition = 'CenterScreen'
      $form.ControlBox = $false
      $label = New-Object Windows.Forms.Label
      $label.Text = $message
      $label.Dock = 'Fill'
      $label.Padding = New-Object Windows.Forms.Padding(20)
      $form.Controls.Add($label)
      $form.Show()
    }
    Write-Output $message
    $entered = $false
    try {
      while (!$entered) {
        try { $entered = $mutex.WaitOne(200) }
        catch [Threading.AbandonedMutexException] { $entered = $true }
        if ($null -ne $form) { [Windows.Forms.Application]::DoEvents() }
      }
    } finally {
      if ($entered) { $mutex.ReleaseMutex() }
    }
    # A launch that waited is an update launch too, even if it wins the race
    # with setup's force-run. Electron's lock combines the two afterwards.
    $Updated = $true
  }
} finally {
  if ($null -ne $mutex) { $mutex.Dispose() }
  if ($null -ne $form) { $form.Dispose() }
}
# A version installed beside the app ahead of Restart to update (#2194):
# the desktop renames the pointer into place at the click, naming it.
$pointer = Join-Path $PSScriptRoot 'current'
if (Test-Path -LiteralPath $pointer -PathType Leaf) {
  # An empty pointer reads as $null; the cast keeps Trim from throwing.
  $version = ([string](Get-Content -LiteralPath $pointer -Raw)).Trim()
  if ($version -match '^[0-9A-Za-z][0-9A-Za-z.+-]*$') {
    $candidate = Join-Path (Join-Path (Join-Path (Split-Path -Parent $App) 'versions') $version) (Split-Path -Leaf $App)
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $App = $candidate }
  }
}
$arguments = @()
if ($Updated) { $arguments += '--updated' }
if ($Link) {
  # Only the app's deep links are forwarded, as one quoted argument. Never
  # allow quotes to turn a URL into another command-line option.
  if ($Link -notmatch '^agent-harness://' -or $Link.Contains('"')) { throw 'Invalid desktop link' }
  $arguments += '"' + $Link + '"'
}
if ($arguments.Count) { Start-Process -FilePath $App -ArgumentList $arguments }
else { Start-Process -FilePath $App }
