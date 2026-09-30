# Installs, starts and pairs the agent-harness environment on a Windows machine,
# as the user who runs it: install.sh's twin, one line from the Your machines
# card, which passes this environment's -Channel and, when one is given, -Name.
#
# It resolves the channel's newest release at run time (-Version names one
# instead), downloads the win32 zip, checks its SHA-256 against the digest the
# release publishes beside it, and unpacks it into the data directory's
# versions directory, the version's sentinel written last. Then it runs the
# version's `service install` (the Task Scheduler logon task) and `service
# start`, waits for the environment's health URL to say ready, sets the channel
# with `update settings`, hands its token to the environment with `update
# credential --stdin`, and ends with the link, QR and code of `pair --preset
# own-client` (my own client's grant) on the tailnet address (or the Tailscale
# warning when only loopback is bound) and the shim's Path line.
#
# Run again over a running service it downloads and unpacks nothing, since the
# launcher alone writes the versions directory while it runs: the active
# version's `service install` repairs the task and the launcher entry, and the
# version changes only when -Version asks, through `update apply`, which stages
# it as any update.
#
# Every verb runs as a version runs, its own node\node.exe on
# packages\cli\dist\main.js, so no argument passes through cmd.exe's parser.
#
# The repository is private, so the releases API and the downloads need a read
# token: AGENT_HARNESS_TOKEN, a Forgejo access token with the read:repository
# scope (git.systemtech.dev: Settings > Applications). It goes to curl.exe and
# to `update credential` on stdin, never on a command line, and the script
# takes it out of the environment its commands inherit while it runs.
#
# A release publishes agent-harness-win32-<arch>.zip (Node's names), holding the
# version's node\node.exe and packages\cli\dist\main.js, and beside it
# <asset>.sha256, whose first word is the SHA-256 of the zip.
#
# It runs under Windows PowerShell 5.1 and PowerShell 7, as a file
# (powershell -File install.ps1 ...) or as a script block made from its text.
# It never calls `exit` in a script block, which would close the window it runs
# in: it sets $LASTEXITCODE instead.

param(
  [string]$Channel = 'stable',
  [string]$Version = '',
  [string]$Name = '',
  [string]$DataDir = '',
  [string]$Port = '',
  [switch]$DryRun,
  [switch]$Help
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'

$ProductName = 'agent-harness'
$Forge = 'https://git.systemtech.dev:5526'
$Repository = 'david/agent-harness'
# The environment's port when none is given, and the address it answers on for this machine.
$DefaultPort = '7433'
$Loopback = '127.0.0.1'
# How many of the newest releases the channel is read from, as the environment reads it.
$ReleaseListLimit = 50
# A release version, SemVer 2.0.0 without the tag's v (the contracts' RELEASE_VERSION_PATTERN), anchored with \z, since .NET's $ also matches before a final line feed.
$VersionPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?\z'
# The mandatory labels of an elevated token: High, and System.
$ElevatedLabels = @('S-1-16-12288', 'S-1-16-16384')

$Usage = @"
Usage: install.ps1 [-Channel <stable|beta>] [-Version <version>] [-Name <name>] [-DataDir <dir>] [-Port <n>] [-DryRun]

Installs the $ProductName environment as a Task Scheduler logon task for this
Windows user, starts it and prints a pairing for your client.

  -Channel <c>     the release channel the environment follows, stable or beta; preset: stable
  -Version <v>     the release to install, such as 0.4.2, instead of the channel's newest;
                   over a running service, the version to update to
  -Name <name>     the environment's name, passed to ``service install``
  -DataDir <dir>   the environment's data directory, passed to every command;
                   preset: %LOCALAPPDATA%\$ProductName
  -Port <n>        the environment's port, passed to every command; preset: $DefaultPort
  -DryRun          resolve the release and print the plan; download and change nothing
                   (INSTALL_DRY_RUN=1 does the same)

Environment:
  AGENT_HARNESS_TOKEN    a Forgejo token with read:repository scope (required: the repository is private)
  INSTALL_READY_TIMEOUT  seconds to wait for the environment to say ready (preset 60)
"@

# What the run's end needs: the exit code, the temporary folders to remove and the
# token to put back. A hashtable, so the functions below change it without a scope
# modifier: in a script block, `$script:` would name the caller's session.
$run = @{ ExitCode = 0; ShowUsage = $false; Work = $null; Partial = $null; Token = $null; TokenTaken = $false }

# Ends the run: the message goes to standard error, and a usage error adds the usage.
function Stop-Install([string]$Message, [int]$Code = 1) {
  $run.ExitCode = $Code
  throw $Message
}

function Stop-Usage([string]$Message) {
  $run.ShowUsage = $true
  Stop-Install $Message 2
}

function Test-ReleaseVersion([string]$Text) {
  return $Text -cmatch $VersionPattern
}

# Compares two numeric identifiers of any length: -1, 0 or 1.
function Compare-Numbers([string]$A, [string]$B) {
  if ($A.Length -ne $B.Length) { if ($A.Length -lt $B.Length) { return -1 } else { return 1 } }
  return [Math]::Sign([string]::CompareOrdinal($A, $B))
}

# Compares two prerelease identifiers: numeric ones by value and below alphanumeric ones, which compare in ASCII order.
function Compare-Identifiers([string]$A, [string]$B) {
  $numericA = $A -cmatch '^[0-9]+\z'
  $numericB = $B -cmatch '^[0-9]+\z'
  if ($numericA -and $numericB) { return Compare-Numbers $A $B }
  if ($numericA -ne $numericB) { if ($numericA) { return -1 } else { return 1 } }
  return [Math]::Sign([string]::CompareOrdinal($A, $B))
}

# Compares two release versions by SemVer precedence, build metadata ignored: -1, 0 or 1.
function Compare-Versions([string]$A, [string]$B) {
  $a = ($A -split '\+', 2)[0]
  $b = ($B -split '\+', 2)[0]
  $coreA, $preA = $a -split '-', 2
  $coreB, $preB = $b -split '-', 2
  $numbersA = $coreA -split '\.'
  $numbersB = $coreB -split '\.'
  for ($i = 0; $i -lt 3; $i++) {
    $order = Compare-Numbers $numbersA[$i] $numbersB[$i]
    if ($order -ne 0) { return $order }
  }
  if (-not $preA -or -not $preB) { return [int][bool]$preB - [int][bool]$preA }
  $identifiersA = $preA -split '\.'
  $identifiersB = $preB -split '\.'
  for ($i = 0; $i -lt $identifiersA.Count -and $i -lt $identifiersB.Count; $i++) {
    $order = Compare-Identifiers $identifiersA[$i] $identifiersB[$i]
    if ($order -ne 0) { return $order }
  }
  return [Math]::Sign($identifiersA.Count - $identifiersB.Count)
}

# The newest of the releases that is not a draft and whose tag is v and a release
# version, by SemVer precedence, as the environment reads the channel: stable takes
# the newest without a prerelease part, beta (or any) the newest of all. Of two equal
# in precedence the first listed wins. Answers its release, or $null.
function Select-NewestRelease($Releases, [string]$ChannelName) {
  $best = $null
  $bestVersion = $null
  foreach ($release in @($Releases)) {
    if ($null -eq $release -or $release.draft -eq $true) { continue }
    $tag = [string]$release.tag_name
    if (-not $tag.StartsWith('v', [StringComparison]::Ordinal)) { continue }
    $candidate = $tag.Substring(1)
    if (-not (Test-ReleaseVersion $candidate)) { continue }
    if ($ChannelName -eq 'stable' -and ($candidate -split '\+', 2)[0].Contains('-')) { continue }
    if ($null -eq $best -or (Compare-Versions $candidate $bestVersion) -gt 0) {
      $best = $release
      $bestVersion = $candidate
    }
  }
  return $best
}

# The download URL of the asset named $AssetName in the release, or $null.
function Get-AssetUrl($Release, [string]$AssetName) {
  foreach ($candidate in @($Release.assets)) {
    if ($null -ne $candidate -and [string]$candidate.name -ceq $AssetName) { return [string]$candidate.browser_download_url }
  }
  return $null
}

# curl.exe to the forge, with the token read from stdin as a config line, so it
# never shows in a process listing; answers whether it succeeded.
function Invoke-Forge([string[]]$Arguments) {
  ('header = "Authorization: token ' + $run.Token + '"') | & curl.exe -K - -fsSL @Arguments
  return $LASTEXITCODE -eq 0
}

# The forge's answer at $Url, read through a file in the work folder as UTF-8; $null when the forge refuses it.
# Parsed by the caller into a variable: a JSON array returned from a function would lose its shape.
function Get-ForgeText([string]$Url) {
  $file = Join-Path $run.Work 'answer.json'
  if (-not (Invoke-Forge @('-o', $file, $Url))) { return $null }
  return [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
}

# The environment's JSON at $Url on loopback, without the token; $null when it does not answer.
function Get-EnvironmentJson([string]$Url) {
  $ErrorActionPreference = 'Continue'
  $answer = & curl.exe -fs --max-time 5 $Url
  if ($LASTEXITCODE -ne 0 -or -not $answer) { return $null }
  try { return (($answer -join "`n") | ConvertFrom-Json) } catch { return $null }
}

# A word of the printed plan: single-quoted, as PowerShell reads it, when it holds more than a path's characters.
function Format-PlanWord([string]$Word) {
  if ($Word -cmatch '^[A-Za-z0-9_./:\\-]+\z') { return $Word }
  return "'" + ($Word -replace "'", "''") + "'"
}

# A line of the printed plan: $Cli's verb $Words, as PowerShell would call it.
function Format-PlanLine([hashtable]$Cli, [string[]]$Words) {
  return '  & ' + ((@($Cli.Node, $Cli.Entry) + $Words | ForEach-Object { Format-PlanWord $_ }) -join ' ')
}

# The version in the folder $Folder, run as the launcher runs one: its own Node on its CLI's entry.
function New-Cli([string]$Folder) {
  return @{
    Folder = $Folder
    Node = [IO.Path]::Combine($Folder, 'node', 'node.exe')
    Entry = [IO.Path]::Combine($Folder, 'packages', 'cli', 'dist', 'main.js')
  }
}

# Runs a verb of $Cli, the options every verb takes after its own when $WithTarget,
# and $Stdin on its standard input when given; in a dry run, prints it as a line of
# the plan instead. A verb that fails ends the run with its exit code.
function Invoke-Verb([hashtable]$Cli, [string[]]$Arguments, [switch]$WithTarget, [string]$Stdin) {
  $words = @($Arguments)
  if ($WithTarget) { $words += $targetOptions }
  if ($dry) {
    Write-Host (Format-PlanLine $Cli $words)
    return
  }
  if ($PSBoundParameters.ContainsKey('Stdin')) { $Stdin | & $Cli.Node $Cli.Entry @words } else { & $Cli.Node $Cli.Entry @words }
  if ($LASTEXITCODE -ne 0) {
    $code = $LASTEXITCODE
    Stop-Install "``$ProductName $($Arguments -join ' ')`` failed with exit code $code; nothing after it ran." $code
  }
}

# Whether this shell's token is elevated (run as administrator, or SYSTEM), as whoami.exe lists its mandatory label.
function Test-Elevated {
  if (-not (Get-Command whoami.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    Stop-Install 'whoami.exe is needed to tell whether this shell is elevated.'
  }
  $ErrorActionPreference = 'Continue'
  $groups = & whoami.exe /groups /fo csv /nh
  if ($LASTEXITCODE -ne 0) { Stop-Install "whoami.exe could not list this shell's groups, so it cannot tell whether the shell is elevated." }
  foreach ($line in @($groups)) {
    foreach ($label in $ElevatedLabels) { if ([string]$line -like "*`"$label`"*") { return $true } }
  }
  return $false
}

# The CLI of the version the service state names active, when it is complete; else $null.
function Get-ActiveCli {
  $statePath = Join-Path $environmentDir 'service-state.json'
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
  try { $state = [IO.File]::ReadAllText($statePath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return $null }
  $active = [string]$state.activeVersion
  if (-not (Test-ReleaseVersion $active)) { return $null }
  $folder = Join-Path $versions $active
  if (-not (Test-Path -LiteralPath (Join-Path $folder '.complete') -PathType Leaf)) { return $null }
  return (New-Cli $folder)
}

# Whether the service runs, as its active version's own `service status` says. A read, so a dry run runs it too.
function Test-Running([hashtable]$Cli) {
  $ErrorActionPreference = 'Continue'
  $answer = & $Cli.Node $Cli.Entry service status --json @targetOptions 2>$null
  try { return (($answer -join "`n") | ConvertFrom-Json).running -eq $true } catch { return $false }
}

# Finds the release to install, the channel's newest or the one -Version names, and
# answers its tag and version and the download URLs of the artefact and its digest.
function Resolve-Release {
  $api = "$Forge/api/v1/repos/$Repository/releases"
  if ($Version) {
    # Read by its tag, as the environment reads a pin; a draft there is none.
    $releaseUrl = "$api/tags/v$Version"
    $text = Get-ForgeText $releaseUrl
    if ($null -eq $text) {
      Stop-Install "could not read release v$Version from ${releaseUrl}: no such release is published, or AGENT_HARNESS_TOKEN cannot read it."
    }
    $release = Select-NewestRelease (ConvertFrom-Json $text) 'any'
    if ($null -eq $release -or [string]$release.tag_name -cne "v$Version") { Stop-Install "release v$Version is a draft, not published; nothing was installed." }
  } else {
    $listing = "${api}?limit=$ReleaseListLimit"
    $text = Get-ForgeText $listing
    if ($null -eq $text) { Stop-Install "could not read the releases from $listing; check AGENT_HARNESS_TOKEN." }
    $listed = ConvertFrom-Json $text
    $release = Select-NewestRelease $listed $Channel
    if ($null -eq $release) { Stop-Install "no release is published on the $Channel channel." }
  }
  $tag = [string]$release.tag_name
  $assetUrl = Get-AssetUrl $release $asset
  if (-not $assetUrl) { Stop-Install "release $tag has no ${asset}: nothing is built for Windows on $arch in it." }
  $checksumUrl = Get-AssetUrl $release "$asset.sha256"
  if (-not $checksumUrl) {
    Stop-Install "release $tag publishes no digest for $asset ($asset.sha256), so it cannot be verified; nothing was installed."
  }
  return @{ Tag = $tag; Version = $tag.Substring(1); AssetUrl = $assetUrl; ChecksumUrl = $checksumUrl }
}

# Downloads the release's artefact, checks its SHA-256 against the published digest
# and unpacks it into the versions directory, its sentinel written last; a complete
# version already there is reused. Answers the version's CLI.
function Expand-Release([hashtable]$Release) {
  $target = Join-Path $versions $Release.Version
  if ($dry) {
    Write-Host "Release: $($Release.Tag)"
    Write-Host "Download: $($Release.AssetUrl)"
    Write-Host "Digest: $($Release.ChecksumUrl)"
    Write-Host "Unpack into: $target"
    return (New-Cli $target)
  }
  if (Test-Path -LiteralPath (Join-Path $target '.complete') -PathType Leaf) {
    Write-Host "$ProductName $($Release.Version) is already unpacked in $target."
    return (New-Cli $target)
  }
  $zip = Join-Path $run.Work $asset
  $sidecar = Join-Path $run.Work "$asset.sha256"
  Write-Host "Downloading $asset $($Release.Tag)."
  if (-not (Invoke-Forge @('-o', $zip, $Release.AssetUrl))) { Stop-Install "could not download $($Release.AssetUrl)." }
  if (-not (Invoke-Forge @('-o', $sidecar, $Release.ChecksumUrl))) { Stop-Install "could not download $($Release.ChecksumUrl)." }
  $expected = (([IO.File]::ReadAllText($sidecar) -split '\r?\n', 2)[0] -split '\s+', 2)[0]
  if ($expected -cnotmatch '^[0-9a-f]{64}\z') { Stop-Install "$($Release.ChecksumUrl) holds no SHA-256 for $asset; nothing was installed." }
  $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $expected) { Stop-Install "the SHA-256 of $asset is $actual, not the published $expected; nothing was installed." }
  Write-Host "Verified the SHA-256 of $asset."

  # Unpacked beside the target, in a folder named as the launcher names its partial copies, and
  # moved into place, so a failed unpack never leaves a half version; the run's end removes the
  # partial folder on any failure.
  [void][IO.Directory]::CreateDirectory($versions)
  $run.Partial = Join-Path $versions ".$($Release.Version).$([guid]::NewGuid()).partial"
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $run.Partial)
  } catch {
    Stop-Install "could not unpack ${asset}: $($_.Exception.Message)"
  }
  $unpacked = New-Cli $run.Partial
  foreach ($needed in @($unpacked.Node, $unpacked.Entry)) {
    if (-not (Test-Path -LiteralPath $needed -PathType Leaf)) {
      Stop-Install "$asset holds no $($needed.Substring($run.Partial.Length + 1)), so it is no version."
    }
  }
  # A folder for this version without the sentinel is what an interrupted install left: replace it.
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  [IO.Directory]::Move($run.Partial, $target)
  $run.Partial = $null
  # The sentinel, written last: only now is the folder a version.
  [IO.File]::WriteAllText((Join-Path $target '.complete'), '')
  Write-Host "Unpacked $ProductName $($Release.Version) into $target."
  return (New-Cli $target)
}

# Waits up to $readyTimeout seconds for the health URL to say ready; else ends the run, naming the service's log.
function Wait-Ready {
  $health = "$environmentUrl/health"
  if ($dry) {
    Write-Host "  wait up to $readyTimeout seconds for $health to say ready"
    return
  }
  Write-Host "Waiting up to $readyTimeout seconds for $health to say ready."
  $deadline = [DateTime]::UtcNow.AddSeconds($readyTimeout)
  while ($true) {
    $answer = Get-EnvironmentJson $health
    if ($null -ne $answer -and $answer.status -eq 'ready') { return }
    if ([DateTime]::UtcNow -ge $deadline) {
      Stop-Install "the environment did not say ready at $health within $readyTimeout seconds; its log is $(Join-Path (Join-Path $environmentDir 'logs') 'service.log')."
    }
    Start-Sleep -Seconds 1
  }
}

# The run: the arguments checked, then the release installed or the running service repaired, then the ending.
function Invoke-Install {
  if ($Help) {
    Write-Host $Usage
    return
  }
  if ($unknownArguments.Count -gt 0) { Stop-Usage "Unknown argument $($unknownArguments[0])." }
  foreach ($option in @('Channel', 'Version', 'Name', 'DataDir', 'Port')) {
    if ($givenParameters.ContainsKey($option) -and -not $givenParameters[$option]) { Stop-Usage "-$option needs a value." }
  }
  if ($Channel -cne 'stable' -and $Channel -cne 'beta') { Stop-Usage "-Channel takes stable or beta; got $Channel." }

  # A version as `update apply` takes it, without the tag's v; one given with it is read without.
  if ($Version.StartsWith('v', [StringComparison]::Ordinal)) { $Version = $Version.Substring(1) }
  if ($Version -and -not (Test-ReleaseVersion $Version)) { Stop-Usage "-Version takes a release version, such as 0.4.2; got $Version." }

  if ($Port -and ($Port -cnotmatch '^[1-9][0-9]{0,4}\z' -or [int]$Port -gt 65535)) {
    Stop-Usage "-Port takes a port number from 1 to 65535; got $Port."
  }

  $readyTimeout = $env:INSTALL_READY_TIMEOUT
  if ($null -eq $readyTimeout) { $readyTimeout = '60' }
  if ($readyTimeout -cnotmatch '^(0|[1-9][0-9]{0,8})\z') { Stop-Usage "INSTALL_READY_TIMEOUT takes a number of seconds; got $readyTimeout." }
  $readyTimeout = [int]$readyTimeout
  $dry = $DryRun.IsPresent -or $env:INSTALL_DRY_RUN -eq '1'

  if (-not $env:AGENT_HARNESS_TOKEN) {
    Stop-Usage 'Set AGENT_HARNESS_TOKEN to a Forgejo token with read:repository scope: the repository is private.'
  }
  # The token reaches curl.exe and `update credential` on stdin only, never a command's
  # environment; the run's end puts it back, for a script block run in a session.
  $run.Token = $env:AGENT_HARNESS_TOKEN
  Remove-Item Env:\AGENT_HARNESS_TOKEN
  $run.TokenTaken = $true

  if ($env:OS -ne 'Windows_NT') { Stop-Install 'this script installs on Windows; install.sh installs on Linux and macOS.' }
  if (Test-Elevated) {
    Stop-Install "refusing to run from an elevated shell: the service runs as the user who installs it, and $ProductName never runs elevated. Run this from a PowerShell that is not run as administrator."
  }
  # A 32-bit PowerShell on 64-bit Windows sees x86 in PROCESSOR_ARCHITECTURE and the machine's in PROCESSOR_ARCHITEW6432.
  $processorArchitecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $processorArchitecture) { $processorArchitecture = $env:PROCESSOR_ARCHITECTURE }
  switch ($processorArchitecture) {
    'AMD64' { $arch = 'x64' }
    'ARM64' { $arch = 'arm64' }
    default { Stop-Install "no artefact is built for the $processorArchitecture architecture; this script installs on x64 and arm64." }
  }
  $asset = "$ProductName-win32-$arch.zip"

  if (-not (Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    Stop-Install 'curl.exe is needed to download the release; Windows 10 1803 and later carry it.'
  }

  # The data directory `serve` would choose (the environment's defaultDataDirectory), unless
  # -DataDir names one, made absolute against this shell's location, which .NET does not follow.
  if ($DataDir) {
    $environmentDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir)
  } else {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = [IO.Path]::Combine($HOME, 'AppData', 'Local') }
    $environmentDir = Join-Path $localAppData $ProductName
  }
  $versions = Join-Path $environmentDir 'versions'
  $shimDir = Join-Path $environmentDir 'bin'
  $effectivePort = $DefaultPort
  if ($Port) { $effectivePort = $Port }
  $environmentUrl = "http://${Loopback}:$effectivePort"
  $targetOptions = @()
  if ($DataDir) { $targetOptions += @('--data-dir', $environmentDir) }
  if ($Port) { $targetOptions += @('--port', $Port) }

  $run.Work = Join-Path ([IO.Path]::GetTempPath()) "$ProductName-install-$([guid]::NewGuid())"
  [void][IO.Directory]::CreateDirectory($run.Work)

  $cli = Get-ActiveCli
  $running = $null -ne $cli -and (Test-Running $cli)
  if ($running) {
    # While the launcher runs it alone writes the versions directory: a new version comes through `update apply`.
    Write-Host "The $ProductName service is running, so nothing is downloaded or unpacked."
  } else {
    $cli = Expand-Release (Resolve-Release)
  }
  if ($dry) { Write-Host 'Then:' }

  $install = @('service', 'install')
  if ($Name) { $install += @('--name', $Name) }
  Invoke-Verb $cli $install -WithTarget
  if (-not $running) { Invoke-Verb $cli @('service', 'start') }
  Wait-Ready
  Invoke-Verb $cli @('update', 'settings', '--channel', $Channel) -WithTarget
  Invoke-Verb $cli @('update', 'credential', '--stdin') -WithTarget -Stdin $run.Token
  if ($running -and $Version) { Invoke-Verb $cli @('update', 'apply', '--version', $Version) -WithTarget }

  if ($dry) {
    Write-Host ((Format-PlanLine $cli (@('pair', '--preset', 'own-client') + $targetOptions)) + ', or the Tailscale warning when only loopback is bound')
    Write-Host 'Dry run: nothing was downloaded or changed.'
    return
  }

  # A pairing on the tailnet address, which `pair` builds its link on; with only loopback bound no other machine could use one.
  $discovery = Get-EnvironmentJson "$environmentUrl/.well-known/$ProductName/environment"
  if ($null -ne $discovery -and $discovery.authPolicy -eq 'tailnet') {
    # My own client's grant (ADR 0025): every scope and the top ceiling, since every client paired is the same person.
    Invoke-Verb $cli @('pair', '--preset', 'own-client') -WithTarget
  } else {
    Write-Host ''
    Write-Host 'No Tailscale address found. This machine is reachable only from itself. Install Tailscale to reach it from your other devices.'
    Write-Host ''
  }

  # The line `service install` prints too: the shim's folder first on the user Path, read
  # unexpanded and written back as an expandable string, so entries naming a variable keep it.
  Write-Host "The shim $(Join-Path $shimDir "$ProductName.cmd") runs the active version. To put it on your Path, run this line in PowerShell, then sign out and back in:"
  Write-Host ("  `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', `$true); " +
    "`$k.SetValue('Path', '$($shimDir -replace "'", "''");' + `$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'), 'ExpandString')")
}

$runAsFile = $MyInvocation.MyCommand.CommandType -eq 'ExternalScript'
$givenParameters = $PSBoundParameters
$unknownArguments = @($args)

try {
  Invoke-Install
} catch {
  if ($run.ExitCode -eq 0) { $run.ExitCode = 1 }
  $message = $_.Exception.Message
  if ($run.ShowUsage) {
    [Console]::Error.WriteLine($message)
    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine($Usage)
  } else {
    [Console]::Error.WriteLine("install.ps1: $message")
  }
} finally {
  if ($run.Partial -and (Test-Path -LiteralPath $run.Partial)) { Remove-Item -LiteralPath $run.Partial -Recurse -Force -ErrorAction SilentlyContinue }
  if ($run.Work -and (Test-Path -LiteralPath $run.Work)) { Remove-Item -LiteralPath $run.Work -Recurse -Force -ErrorAction SilentlyContinue }
  if ($run.TokenTaken) { $env:AGENT_HARNESS_TOKEN = $run.Token }
}

if ($runAsFile) { exit $run.ExitCode }
$global:LASTEXITCODE = $run.ExitCode
