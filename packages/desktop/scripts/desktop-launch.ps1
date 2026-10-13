param(
  [Parameter(Mandatory=$true)][string]$App,
  [string]$Link,
  [switch]$Updated,
  [switch]$Prepare,
  [switch]$NoWindow,
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
