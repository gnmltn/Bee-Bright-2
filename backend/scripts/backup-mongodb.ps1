param(
  [string]$BackupRoot = "",
  [int]$RetentionDays = 0
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

if (-not $env:MONGODB_URI) {
  throw "MONGODB_URI is not set. Add it to backend/.env before running backups."
}

$effectiveBackupRoot = if ($BackupRoot) { $BackupRoot } elseif ($env:DB_BACKUP_DIR) { $env:DB_BACKUP_DIR } else { ".\backups" }
$effectiveRetentionDays = if ($RetentionDays -gt 0) { $RetentionDays } elseif ($env:DB_BACKUP_RETENTION_DAYS) { [int]$env:DB_BACKUP_RETENTION_DAYS } else { 7 }

$mongodump = Get-Command mongodump -ErrorAction SilentlyContinue
if (-not $mongodump) {
  throw "mongodump is not available on PATH. Install MongoDB Database Tools first."
}

$backupDirectory = New-Item -ItemType Directory -Force -Path $effectiveBackupRoot
$backupRootPath = $backupDirectory.FullName
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archivePath = Join-Path $backupRootPath "beebright-backup-$timestamp.gz"
$hashPath = "$archivePath.sha256"
$manifestPath = Join-Path $backupRootPath "beebright-backup-$timestamp.manifest.json"

Write-Host "Creating MongoDB backup at $archivePath"
& $mongodump.Source --uri="$($env:MONGODB_URI)" --archive="$archivePath" --gzip

if ($LASTEXITCODE -ne 0) {
  throw "Backup failed with exit code $LASTEXITCODE"
}

$archiveHash = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash
Set-Content -Path $hashPath -Value "$archiveHash *$(Split-Path -Leaf $archivePath)"

$manifest = [ordered]@{
  createdAt = (Get-Date).ToString("o")
  archiveFile = (Split-Path -Leaf $archivePath)
  archivePath = $archivePath
  archiveSha256 = $archiveHash
  archiveSizeBytes = (Get-Item $archivePath).Length
  retentionDays = $effectiveRetentionDays
  tlsExpected = ($env:MONGODB_URI -match '(?i)(\?|&)tls=true' -or $env:MONGODB_URI -match '(?i)^mongodb\+srv://')
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

$cutoff = (Get-Date).AddDays(-1 * $effectiveRetentionDays)
Get-ChildItem -Path $backupRootPath -File |
  Where-Object {
    $_.Name -match '^beebright-backup-.*(\.gz|\.sha256|\.manifest\.json)$' -and $_.LastWriteTime -lt $cutoff
  } |
  Remove-Item -Force

Write-Host "Backup completed successfully."
Write-Host "Archive: $archivePath"
Write-Host "SHA-256: $archiveHash"
Write-Host "Manifest: $manifestPath"
