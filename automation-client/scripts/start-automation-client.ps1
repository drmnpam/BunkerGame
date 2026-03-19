param(
  [switch]$InstallDepsIfMissing = $true
)

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
Set-Location $appDir
$logoPng = Join-Path $appDir 'branding\\logo.png'
$logoIco = Join-Path $appDir 'branding\\logo.ico'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kapture Automation Agent.lnk'

if ($InstallDepsIfMissing -and -not (Test-Path (Join-Path $appDir 'node_modules'))) {
  Write-Host "[launcher] node_modules not found, running npm install..."
  npm install
}

if (Test-Path $logoPng) {
  Write-Host "[launcher] logo: $logoPng"
}

if ((Test-Path $logoIco) -and (Test-Path (Join-Path $appDir 'Run Automation Client.cmd'))) {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $shortcut = $ws.CreateShortcut($desktopShortcut)
    $shortcut.TargetPath = (Join-Path $appDir 'Run Automation Client.cmd')
    $shortcut.WorkingDirectory = $appDir
    $shortcut.IconLocation = "$logoIco,0"
    $shortcut.Save()
    Write-Host "[launcher] desktop shortcut updated: $desktopShortcut"
  } catch {
    Write-Host "[launcher] shortcut update skipped: $($_.Exception.Message)"
  }
}

$existing = Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  Write-Host "[launcher] stopping existing process on :5180 (PID=$($existing.OwningProcess))"
  Stop-Process -Id $existing.OwningProcess -Force -ErrorAction SilentlyContinue
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $appDir "launcher-dev-$stamp.log"
$err = Join-Path $appDir "launcher-dev-$stamp.err.log"

Write-Host "[launcher] starting dev server..."
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm run dev -- --host 127.0.0.1 --port 5180 1> `"$log`" 2> `"$err`"" -WorkingDirectory $appDir | Out-Null

Start-Sleep -Seconds 3
Start-Process 'http://127.0.0.1:5180'

Write-Host "[launcher] app opened: http://127.0.0.1:5180"
Write-Host "[launcher] logs:"
Write-Host "  $log"
Write-Host "  $err"
