# The release smoke owns this tree. taskkill can report an error for a console
# companion that is already exiting; verify retained handles rather than its
# exit code. No process names or command lines participate in ownership.
function Stop-OwnedProcessTree {
    param([Parameter(Mandatory)] $Root, [int] $TimeoutMilliseconds = 10000)

    if ($Root.HasExited) { throw "Smoke root PID $($Root.Id) exited before cleanup could capture its tree" }
    $null = $Root.SafeHandle
    $rootStart = $Root.StartTime.ToUniversalTime()
    $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate -ErrorAction Stop)
    $owned = @{}
    $owned[[int]$Root.Id] = $rootStart
    # Creation times disambiguate stale parent PIDs. Iterate to include
    # grandchildren even when the provider lists them before their parents.
    do {
        $added = $false
        foreach ($row in $rows) {
            $id = [int]$row.ProcessId
            $parent = [int]$row.ParentProcessId
            if (!$owned.ContainsKey($id) -and $owned.ContainsKey($parent)) {
                if ($null -eq $row.CreationDate) { throw "Could not establish ownership of smoke descendant PID $id" }
                $created = $row.CreationDate.ToUniversalTime()
                # WMI creation timestamps have microsecond precision.
                if ($created.ToString('yyyyMMddHHmmssffffff') -lt $owned[$parent].ToString('yyyyMMddHHmmssffffff')) { continue }
                $owned[$id] = $created
                $added = $true
            }
        }
    } while ($added)

    $handles = @($Root)
    try {
        foreach ($id in $owned.Keys) {
            if ($id -eq $Root.Id) { continue }
            try {
                $child = Get-Process -Id $id -ErrorAction Stop
            } catch {
                if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { continue }
                throw
            }
            $handles += $child
            # Retain the native handle before comparing identities, so a reused PID
            # cannot make a later wait observe an unrelated process.
            $null = $child.SafeHandle
            if ($child.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -ne $owned[$id].ToString('yyyyMMddHHmmssffffff')) {
                $handles = @($handles | Where-Object { ![object]::ReferenceEquals($_, $child) })
                $child.Dispose()
                continue
            }
        }
        if ($Root.HasExited) { throw "Smoke root PID $($Root.Id) exited while cleanup captured its tree" }
        & taskkill.exe /PID $Root.Id /T /F | Out-Host
        $killCode = $LASTEXITCODE
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $survivors = @()
        foreach ($handle in $handles) {
            $remaining = [Math]::Max(0, $TimeoutMilliseconds - [int]$timer.ElapsedMilliseconds)
            if (!$handle.WaitForExit($remaining)) { $survivors += $handle.Id }
        }
        if ($survivors.Count -ne 0) {
            throw "Smoke process tree did not stop; surviving PIDs: $($survivors -join ', ') (taskkill exit $killCode)"
        }
        Write-Output "Smoke process tree exited: $($handles.Id -join ', ') (taskkill exit $killCode)"
    } finally {
        foreach ($handle in $handles) {
            if (![object]::ReferenceEquals($handle, $Root)) { $handle.Dispose() }
        }
    }
}
