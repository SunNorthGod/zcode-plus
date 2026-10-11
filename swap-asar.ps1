$ErrorActionPreference = "Stop"
$target = "C:\Program Files\ZCode\resources\app.asar"
$new    = Join-Path $env:TEMP "zcode-asar-work\app.asar.new"
$backup = "$target.orig-backup"
$marker = Join-Path $env:TEMP "zcode-asar-work"

Set-Content -Path (Join-Path $marker "swap-waiting.txt") -Value "waiting for ZCode to exit"

# 等待 ZCode 完全退出(app.asar 被主进程占用,退出后才可覆盖)
while (Get-Process -Name "ZCode" -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }

if (-not (Test-Path $backup)) { Copy-Item $target $backup -Force }
Copy-Item $new $target -Force

Set-Content -Path (Join-Path $marker "swap-done.txt") -Value ("swapped " + (Get-Date))
Start-Process "C:\Program Files\ZCode\ZCode.exe"
