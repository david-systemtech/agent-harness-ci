# Read-only evidence collection. Every collector is independent so it cannot hide
# the smoke's original failure. Never collect other processes' command lines.
function Protect-WindowsSmokeText {
  param([AllowEmptyString()][string] $Text, [string[]] $Secrets = @())
  $values = @($Secrets) + @(Get-ChildItem Env: | Where-Object { $_.Name -match 'TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY' } | ForEach-Object { $_.Value })
  # Plain logs can embed serialized JSON too. Replace its escaped spelling first,
  # so a backslash in a credential cannot leave a broken JSON escape behind.
  $spellings = @(foreach ($value in ($values | Where-Object { $_ } | Select-Object -Unique)) {
    $value
    $encoded = ConvertTo-Json -InputObject $value -Compress
    $encoded.Substring(1, $encoded.Length - 2)
  }) | Select-Object -Unique | Sort-Object { $_.Length } -Descending
  if ($Text.TrimStart().StartsWith('{') -or $Text.TrimStart().StartsWith('[')) {
    try {
      $decoded = ConvertFrom-Json -InputObject $Text -AsHashtable -NoEnumerate -Depth 100 -ErrorAction Stop
      $protected = Protect-WindowsSmokeValue -Value $decoded -Secrets $spellings
      return ConvertTo-Json -InputObject $protected -Depth 100
    } catch { }
  }
  return Protect-WindowsSmokePlainText -Text $Text -Secrets $spellings
}

function Protect-WindowsSmokeValue {
  param($Value, [string[]] $Secrets)
  if ($Value -is [Collections.IDictionary]) {
    $protected = [ordered]@{}
    foreach ($key in $Value.Keys) {
      # A key can hold a known secret too; number repeats so no entry overwrites another.
      $name = Protect-WindowsSmokePlainText -Text $key -Secrets $Secrets
      $base = $name
      for ($n = 2; $protected.Contains($name); $n++) { $name = "$base ($n)" }
      $item = $Value[$key]
      $scalar = $null -ne $item -and $item -isnot [Collections.IDictionary] -and $item -isnot [array]
      if ($scalar -and $key -match 'token|password|secret|credential|api[_-]?key|authorization') {
        $protected[$name] = '[REDACTED]'
      } else {
        $protected[$name] = Protect-WindowsSmokeValue -Value $item -Secrets $Secrets
      }
    }
    return $protected
  }
  if ($Value -is [array]) {
    $protected = [Collections.Generic.List[object]]::new()
    foreach ($item in $Value) { $protected.Add((Protect-WindowsSmokeValue -Value $item -Secrets $Secrets)) }
    return ,$protected.ToArray()
  }
  if ($Value -is [string]) { return Protect-WindowsSmokePlainText -Text $Value -Secrets $Secrets }
  return $Value
}

function Protect-WindowsSmokePlainText {
  param([AllowEmptyString()][string] $Text, [string[]] $Secrets)
  foreach ($value in $Secrets) {
    $Text = $Text.Replace($value, '[REDACTED]')
  }
  $Text = $Text -replace '(?im)(Authorization\s*:\s*)[^\r\n"'']+', '$1[REDACTED]'
  $Text = $Text -replace '(?i)(Bearer\s+)[^\s"''<>]+', '$1[REDACTED]'
  $Text = $Text -replace '(?i)("[\w.-]*(?:token|password|secret|credential|api[_-]?key|authorization)[\w.-]*"\s*:\s*")(?:\\.|[^"\\])*', '$1[REDACTED]'
  $Text = $Text -replace '(?i)((?:[\w.-]*(?:token|password|secret|credential|api[_-]?key)[\w.-]*)["'']?\s*[:=]\s*["'']?)[^\s"'',;<>]+', '$1[REDACTED]'
  $Text = $Text -replace '(?i)(<Password>)[^<]*(</Password>)', '$1[REDACTED]$2'
  $Text = $Text -replace '(?i)(https?://)[^\s/@]+:[^\s/@]+@', '$1[REDACTED]@'
  return $Text
}

function Write-WindowsSmokeText {
  param([string] $Path, [AllowEmptyString()][string] $Text, [string[]] $Secrets = @())
  New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
  [IO.File]::WriteAllText($Path, (Protect-WindowsSmokeText -Text $Text -Secrets $Secrets), [Text.UTF8Encoding]::new($false))
}

function Write-WindowsSmokeCollectionError {
  param([string] $Path, [string] $Message, [string[]] $Secrets = @())
  Write-Warning (Protect-WindowsSmokeText -Text $Message -Secrets $Secrets)
  try { Write-WindowsSmokeText -Path $Path -Text $Message -Secrets $Secrets } catch {
    # Reporting an unavailable source must not prevent collecting another one.
    Write-Warning (Protect-WindowsSmokeText -Text $_.Exception.Message -Secrets $Secrets)
  }
}

function Copy-WindowsSmokeEvidenceFile {
  param([string] $Source, [string] $Destination, [string[]] $Secrets = @())
  try {
    if (Test-Path -LiteralPath $Source -PathType Leaf -ErrorAction Stop) {
      Write-WindowsSmokeText -Path $Destination -Text ([IO.File]::ReadAllText($Source)) -Secrets $Secrets
    }
  } catch {
    Write-WindowsSmokeCollectionError -Path ($Destination + '.error.txt') -Message $_.Exception.Message -Secrets $Secrets
  }
}

function Get-WindowsSmokeTaskEvents {
  param([datetime] $StartedAt)
  try {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-TaskScheduler/Operational'; StartTime = $StartedAt } -ErrorAction Stop)
  } catch {
    if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return }
    throw
  }
  foreach ($event in $events) {
    $xml = [xml]$event.ToXml()
    $taskNames = @($xml.Event.EventData.Data | Where-Object { $_.Name -eq 'TaskName' } | ForEach-Object { $_.InnerText })
    if ($taskNames -contains '\agent-harness') {
      [ordered]@{ id = $event.Id; timeCreated = $event.TimeCreated; message = $event.Message; xml = $event.ToXml() }
    }
  }
}

function Save-WindowsSmokeDiagnostics {
  param(
    [string] $OutputDirectory, [string] $DataDirectory, [string] $Stage,
    [int] $Port, [string] $Version, [datetime] $StartedAt,
    $LastDiscovery, [string] $LastRequestError, [string[]] $Secrets = @()
  )
  try {
    $collectors = [ordered]@{
      'predicate.json' = {
        [ordered]@{
          stage = $Stage; capturedAt = [datetime]::UtcNow; startedAt = $StartedAt
          endpoint = "http://127.0.0.1:$Port/.well-known/agent-harness/environment"
          predicate = '$discovery.harnessVersion -eq $env:VERSION -and $discovery.readiness -eq "ready"'
          expectedVersion = $Version; expectedReadiness = 'ready'; timeoutSeconds = 120
          dataDirectory = $DataDirectory; lastDiscovery = $LastDiscovery; lastRequestError = $LastRequestError
        } | ConvertTo-Json -Depth 12
      }
      'task-query.txt' = {
        $query = (& schtasks.exe /Query /TN agent-harness /V /FO LIST 2>&1 | Out-String)
        "$query`nschtasks exit: $LASTEXITCODE"
      }
      'task-state.json' = {
        @{ task = Get-ScheduledTask -TaskName agent-harness -ErrorAction Stop; info = Get-ScheduledTaskInfo -TaskName agent-harness -ErrorAction Stop } | ConvertTo-Json -Depth 12
      }
      'task.xml' = { Export-ScheduledTask -TaskName agent-harness -ErrorAction Stop }
      'task-events.json' = { ConvertTo-Json -InputObject @(Get-WindowsSmokeTaskEvents -StartedAt $StartedAt) -Depth 12 }
      'processes.json' = {
        # Explicit properties prevent any unrelated command line or environment
        # from reaching the public artifact.
        ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,SessionId -ErrorAction Stop |
          Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,SessionId) -Depth 6
      }
      'port.json' = {
        ConvertTo-Json -InputObject @(Get-NetTCPConnection -LocalPort $Port -ErrorAction Stop |
          Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess) -Depth 6
      }
      'logs-index.txt' = {
        $paths = @(Get-ChildItem -LiteralPath $DataDirectory -Recurse -Filter '*.log' -File -ErrorAction Stop)
        foreach ($file in $paths) {
          $relative = [IO.Path]::GetRelativePath($DataDirectory, $file.FullName)
          try {
            Write-WindowsSmokeText -Path (Join-Path (Join-Path $OutputDirectory 'logs') $relative) -Text ([IO.File]::ReadAllText($file.FullName)) -Secrets $Secrets
          } catch {
            Write-WindowsSmokeCollectionError -Path (Join-Path $OutputDirectory ($relative + '.error.txt')) -Message "$relative : $($_.Exception.Message)" -Secrets $Secrets
          }
          $relative
        }
      }
      'launch-configuration.txt' = {
        foreach ($name in 'service.json', 'launcher-version', 'launcher-entry.cmd') {
          $path = Join-Path $DataDirectory $name
          if (Test-Path -LiteralPath $path) { "$name`n$([IO.File]::ReadAllText($path))" }
        }
      }
    }
    foreach ($entry in $collectors.GetEnumerator()) {
      try {
        $content = (& $entry.Value | Out-String)
        Write-WindowsSmokeText -Path (Join-Path $OutputDirectory $entry.Key) -Text $content -Secrets $Secrets
      } catch {
        Write-WindowsSmokeCollectionError -Path (Join-Path $OutputDirectory ($entry.Key + '.error.txt')) -Message $_.Exception.Message -Secrets $Secrets
      }
    }
  } catch {
    # Even an unavailable output directory must leave the original exception intact.
    Write-Warning (Protect-WindowsSmokeText -Text "Smoke diagnostics could not be retained: $($_.Exception.Message)" -Secrets $Secrets)
  }
}
