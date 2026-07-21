param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,
  [string]$TargetUri = "",
  [switch]$Drop
)

$ErrorActionPreference = "Stop"

function Import-DotEnvFile {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $parts = $_ -split '=', 2
    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($name -and -not (Test-Path "Env:$name")) {
      Set-Item -Path "Env:$name" -Value $value
    }
  }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
Import-DotEnvFile -Path $envPath

$effectiveUri = if ($TargetUri) { $TargetUri } elseif ($env:MONGODB_URI) { $env:MONGODB_URI } else { "" }
if (-not $effectiveUri) {
  throw "Target MongoDB URI is required. Pass -TargetUri or set MONGODB_URI in backend/.env."
}

if (-not (Test-Path $ArchivePath)) {
  throw "Backup archive not found: $ArchivePath"
}

$mongorestore = Get-Command mongorestore -ErrorAction SilentlyContinue
if (-not $mongorestore) {
  throw "mongorestore is not available on PATH. Install MongoDB Database Tools first."
}

$restoreArgs = @("--uri=$effectiveUri", "--archive=$ArchivePath", "--gzip")
if ($Drop) {
  $restoreArgs += "--drop"
}

Write-Host "Restoring MongoDB backup from $ArchivePath"
& $mongorestore.Source @restoreArgs

if ($LASTEXITCODE -ne 0) {
  throw "Restore failed with exit code $LASTEXITCODE"
}

Write-Host "Restore completed successfully."
