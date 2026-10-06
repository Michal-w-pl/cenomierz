# Rejestruje w Harmonogramie zadań Windows codzienne sprawdzanie cen (domyślnie 2x dziennie).
# Użycie:  powershell -ExecutionPolicy Bypass -File zaplanuj.ps1 [-Godziny "08:00","20:00"]
# Usunięcie: Unregister-ScheduledTask -TaskName "Otomoto - sprawdzanie cen" -Confirm:$false
param([string[]]$Godziny = @("08:00", "20:00"))

$dir  = $PSScriptRoot
$node = (Get-Command node).Source
$log  = Join-Path $dir "data\check.log"
New-Item -ItemType Directory -Force (Join-Path $dir "data") | Out-Null

$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$node`" cli.js check >> `"$log`" 2>&1`"" -WorkingDirectory $dir
$triggers = $Godziny | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
# StartWhenAvailable: jeśli komputer był wyłączony o tej godzinie, sprawdzenie odpali się po włączeniu.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "Otomoto - sprawdzanie cen" -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
Write-Host "Zaplanowano sprawdzanie cen o: $($Godziny -join ', '). Log: $log"
