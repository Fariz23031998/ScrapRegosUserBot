$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskName = "ScrapRegosUserBot-DailySync"
$NodePath = (Get-Command node).Source
$SyncScript = Join-Path $ProjectRoot "sync-all.js"
$UserName = $env:USERNAME

$action = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument "`"$SyncScript`"" `
    -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -Daily -At "19:00"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances Stop

$principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Daily Regos data sync at 19:00" `
    -Force | Out-Null

Write-Host "Scheduled task '$TaskName' installed."
Write-Host "Runs daily at 19:00 as $UserName"
Write-Host "Command: $NodePath `"$SyncScript`""
Write-Host "Logs: $ProjectRoot\logs\sync-YYYY-MM-DD.log"
