$backendRoot = Split-Path -Parent $PSScriptRoot

function Get-EnvValue {
  param(
    [string]$Name
  )

  $envPath = Join-Path $backendRoot '.env'

  if (-not (Test-Path $envPath)) {
    return $null
  }

  $envLine = Select-String -Path $envPath -Pattern "^\s*$Name\s*=" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $envLine) {
    return $null
  }

  $rawValue = ($envLine.Line -split '=', 2)[1].Trim()
  return $rawValue.Trim("'`"")
}

function Get-BackendPort {
  $defaultPort = 5001
  $rawValue = Get-EnvValue -Name 'PORT'

  if (-not $rawValue) {
    return $defaultPort
  }

  $parsedPort = 0
  if ([int]::TryParse($rawValue, [ref]$parsedPort) -and $parsedPort -gt 0) {
    return $parsedPort
  }

  return $defaultPort
}

function Get-LocalMongoPort {
  $mongoUri = Get-EnvValue -Name 'MONGODB_URI'

  if (-not $mongoUri -or $mongoUri -notmatch '^mongodb://') {
    return $null
  }

  $uriWithoutScheme = $mongoUri.Substring('mongodb://'.Length)
  if ($uriWithoutScheme.Contains('@')) {
    $uriWithoutScheme = $uriWithoutScheme.Split('@', 2)[1]
  }

  $hostPort = $uriWithoutScheme.Split('/', 2)[0].Split('?', 2)[0]
  if ($hostPort -match '^(localhost|127\.0\.0\.1)(:(\d+))?$') {
    if ($Matches[3]) {
      return [int]$Matches[3]
    }

    return 27017
  }

  return $null
}

function Start-LightweightMongoIfNeeded {
  param(
    [Nullable[int]]$MongoPort
  )

  if (-not $MongoPort) {
    return
  }

  $listener = Get-NetTCPConnection -LocalPort $MongoPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    return
  }

  $mongoExe = 'C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe'
  $mongoDataPath = Join-Path $backendRoot 'mongo-data-local'
  $mongoLogPath = Join-Path $backendRoot 'mongod-local.log'

  if (-not (Test-Path $mongoExe)) {
    Write-Host "MongoDB binary not found at $mongoExe. Start MongoDB manually."
    return
  }

  if (-not (Test-Path $mongoDataPath)) {
    Write-Host "Local MongoDB snapshot not found at $mongoDataPath. Start MongoDB manually or restore the local snapshot first."
    return
  }

  Write-Host "Starting lightweight local MongoDB on port $MongoPort..."

  try {
    Start-Process -FilePath $mongoExe -ArgumentList @(
      '--dbpath', $mongoDataPath,
      '--bind_ip', '127.0.0.1',
      '--port', "$MongoPort",
      '--wiredTigerCacheSizeGB', '0.20',
      '--setParameter', 'diagnosticDataCollectionEnabled=false',
      '--logpath', $mongoLogPath
    ) -WindowStyle Hidden | Out-Null
  } catch {
    Write-Host "Could not start lightweight local MongoDB. Check $mongoLogPath."
    return
  }

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $listener = Get-NetTCPConnection -LocalPort $MongoPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      Write-Host "Lightweight local MongoDB is ready on port $MongoPort."
      return
    }
  }

  Write-Host "Local MongoDB did not start in time. Check $mongoLogPath."
}

$port = Get-BackendPort
$mongoPort = Get-LocalMongoPort

function Stop-ProcessIfRunning {
  param(
    [int]$TargetPid,
    [string]$Reason
  )

  if (-not $TargetPid -or $TargetPid -eq $PID) { return }

  $existing = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if (-not $existing) { return }

  try {
    Stop-Process -Id $TargetPid -Force -ErrorAction Stop
    Write-Host "Stopped PID $TargetPid ($Reason)."
  } catch {
    Write-Host "Could not stop PID $TargetPid ($Reason)."
  }
}

try {
  Start-LightweightMongoIfNeeded -MongoPort $mongoPort

  # Kill stale backend watcher/runner processes first so they cannot respawn server.js.
  $cwdEscaped = [Regex]::Escape($backendRoot)
  $staleProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.Name -match '^(node|nodemon|npm|powershell|pwsh)(\.exe)?$') -and
      $_.CommandLine -and
      (
        $_.CommandLine -match 'nodemon(\.js)?\s+server\.js' -or
        $_.CommandLine -match 'node\s+server\.js' -or
        $_.CommandLine -match "${cwdEscaped}\\server\.js"
      )
    }

  foreach ($proc in $staleProcesses) {
    Stop-ProcessIfRunning -TargetPid ([int]$proc.ProcessId) -Reason 'stale backend runner'
  }

  # Ensure nothing is still listening on the backend port.
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listeners) {
    $procIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $procIds) {
      Stop-ProcessIfRunning -TargetPid ([int]$procId) -Reason "port $port listener"
    }
  }

  Start-Sleep -Milliseconds 500
} catch {
  Write-Host "Startup cleanup encountered an issue; continuing startup."
}

Write-Host "Starting backend dev server on port $port..."
npx nodemon server.js
