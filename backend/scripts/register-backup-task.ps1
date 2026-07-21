param(
  [string]$TaskName = "BeeBright MongoDB Daily Backup",
  [string]$DailyAt = "02:00",
  [string]$BackupRoot = "",
  [int]$RetentionDays = 14
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "backup-mongodb.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "Backup script not found at $scriptPath"
}

$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
if ($BackupRoot) {
  $actionArgs += " -BackupRoot `"$BackupRoot`""
}
if ($RetentionDays -gt 0) {
  $actionArgs += " -RetentionDays $RetentionDays"
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Write-Host "Scheduled task '$TaskName' registered to run daily at $DailyAt."
