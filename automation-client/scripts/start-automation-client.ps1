param(
  [switch]$InstallDepsIfMissing = $true
)

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$launcherScript = $MyInvocation.MyCommand.Path
$powershellExe = Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
Set-Location $appDir
$logoPng = Join-Path $appDir 'branding\logo.png'
$logoIco = Join-Path $appDir 'branding\logo.ico'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kapture Automation Agent.lnk'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Get-EnvVarValue {
  param(
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string[]]$Files
  )

  $escaped = [regex]::Escape($Key)
  foreach ($file in $Files) {
    if (-not (Test-Path $file)) { continue }
    foreach ($line in Get-Content -Path $file) {
      if ($line -match "^\s*$escaped\s*=\s*(.*)$") {
        return $matches[1].Trim().Trim('"').Trim("'")
      }
    }
  }
  return $null
}

function Get-WsPortOrDefault {
  param(
    [Parameter(Mandatory = $true)][string]$WsUrl,
    [int]$DefaultPort = 61822
  )
  try {
    $u = [uri]$WsUrl
    if ($u.Port -gt 0) { return $u.Port }
  } catch {
    # ignore parse errors
  }
  return $DefaultPort
}

function Test-PortListening {
  param([Parameter(Mandatory = $true)][int]$Port)
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  return [bool]$conn
}

function Resolve-BrowserPath {
  param([string]$PreferredPath)

  if ($PreferredPath -and (Test-Path $PreferredPath)) {
    return $PreferredPath
  }

  $candidates = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Users\dshp3\AppData\Local\Yandex\YandexBrowser\Application\browser.exe'
  )

  foreach ($exe in $candidates) {
    if (Test-Path $exe) { return $exe }
  }

  return $null
}

if ($InstallDepsIfMissing -and -not (Test-Path (Join-Path $appDir 'node_modules'))) {
  Write-Host "[launcher] node_modules not found, running npm install..."
  npm install
}

if (Test-Path $logoPng) {
  Write-Host "[launcher] logo: $logoPng"
}

if ((Test-Path $logoIco) -and (Test-Path $launcherScript)) {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $shortcut = $ws.CreateShortcut($desktopShortcut)
    $shortcut.TargetPath = $powershellExe
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherScript`""
    $shortcut.WorkingDirectory = $appDir
    $shortcut.IconLocation = "$logoIco,0"
    $shortcut.Save()
    Write-Host "[launcher] desktop shortcut updated: $desktopShortcut"
  } catch {
    Write-Host "[launcher] shortcut update skipped: $($_.Exception.Message)"
  }
}

$envFiles = @(
  (Join-Path $appDir '.env.local'),
  (Join-Path $appDir '.env.example')
)

$mcpWsUrl = Get-EnvVarValue -Key 'VITE_KAPTURE_MCP_WS_URL' -Files $envFiles
if (-not $mcpWsUrl) { $mcpWsUrl = 'ws://localhost:61822/mcp' }
$mcpPort = Get-WsPortOrDefault -WsUrl $mcpWsUrl -DefaultPort 61822
$mcpLog = Join-Path $appDir "launcher-mcp-$stamp.log"
$mcpErr = Join-Path $appDir "launcher-mcp-$stamp.err.log"

if (Test-PortListening -Port $mcpPort) {
  Write-Host "[launcher] OK MCP already listening on :$mcpPort"
} else {
  Write-Host "[launcher] MCP not listening on :$mcpPort, starting..."
  $customMcpCmd = Get-EnvVarValue -Key 'KAPTURE_MCP_START_CMD' -Files $envFiles
  $commands = @()
  if ($customMcpCmd) {
    Write-Host "[launcher] Using custom MCP command: $customMcpCmd"
    $commands = @($customMcpCmd)
  } else {
    $commands = @(
      "npx -y kapture-mcp bridge",
      "npx -y kapture-mcp server",
      "kapture-mcp --transport websocket --port $mcpPort"
    )
  }

  $started = $false
  foreach ($cmd in $commands) {
    Write-Host "[launcher] Trying MCP: $cmd"
    $mcpProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "$cmd 1> `"$mcpLog`" 2> `"$mcpErr`"" -WorkingDirectory $appDir -WindowStyle Hidden -PassThru

    # Wait for MCP (up to 30 seconds)
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-PortListening -Port $mcpPort) {
        Write-Host "[launcher] OK MCP started on :$mcpPort"
        $started = $true
        break
      }
    }
    if ($started) { 
      break 
    }
  }

  if (-not $started) {
    Write-Host "[launcher] FAIL MCP auto-start failed"
    Write-Host "[launcher] Check logs:"
    Write-Host "  $mcpLog"
    Write-Host "  $mcpErr"
  }
}

# Start Ollama Manager (port 5182)
$ollamaPort = 5182
$ollamaLog = Join-Path $appDir "launcher-ollama-$stamp.log"
$ollamaErr = Join-Path $appDir "launcher-ollama-$stamp.err.log"

if (Test-PortListening -Port $ollamaPort) {
  Write-Host "[launcher] OK Ollama manager already listening on :$ollamaPort"
} else {
  Write-Host "[launcher] Ollama manager not listening on :$ollamaPort, starting..."
  $ollamaProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm run serve:ollama 1> `"$ollamaLog`" 2> `"$ollamaErr`"" -WorkingDirectory $appDir -WindowStyle Hidden -PassThru
  
  # Wait for Ollama manager (up to 10 seconds)
  $ollamaStarted = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-PortListening -Port $ollamaPort) {
      Write-Host "[launcher] OK Ollama manager started on :$ollamaPort"
      $ollamaStarted = $true
      break
    }
  }
  
  if (-not $ollamaStarted) {
    Write-Host "[launcher] FAIL Ollama manager auto-start failed"
    Write-Host "[launcher] Check logs:"
    Write-Host "  $ollamaLog"
    Write-Host "  $ollamaErr"
  }
}

$autoOpenBrowserRaw = Get-EnvVarValue -Key 'KAPTURE_AUTO_OPEN_BROWSER' -Files $envFiles
$autoOpenBrowser = if (-not $autoOpenBrowserRaw) { $true } else { @('1','true','yes','on') -contains $autoOpenBrowserRaw.ToLowerInvariant() }

# Removed: Automation browser auto-open (KAPTURE_AUTOMATION_URL)
# Now only opens the app itself below

$existing = Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  Write-Host "[launcher] stopping existing process on :5180 (PID=$($existing.OwningProcess))"
  Stop-Process -Id $existing.OwningProcess -Force -ErrorAction SilentlyContinue
}

$log = Join-Path $appDir "launcher-dev-$stamp.log"
$err = Join-Path $appDir "launcher-dev-$stamp.err.log"

Write-Host "[launcher] Starting dev server..."
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm run dev -- --host 127.0.0.1 --port 5180 1> `"$log`" 2> `"$err`"" -WorkingDirectory $appDir -WindowStyle Hidden | Out-Null

Write-Host "[launcher] Waiting for dev server..."
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "===================================================="
Write-Host "  OK Kapture Automation Client Started"
Write-Host "  - MCP Bridge:  :$mcpPort"
Write-Host "  - Dev Server:  http://127.0.0.1:5180"
Write-Host "  - Browser:     Opening..."
Write-Host "===================================================="
Write-Host ""

# Open app in browser - try existing browser first, then default
$appUrl = 'http://127.0.0.1:5180'
$browserOpened = $false

# Try to find running Chrome or Edge and open in new tab
$browserProcesses = @('chrome', 'msedge')
foreach ($procName in $browserProcesses) {
    $proc = Get-Process -Name $procName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
        try {
            # Get browser path from process
            $browserPath = $proc.Path
            if ($browserPath) {
                Start-Process -FilePath $browserPath -ArgumentList $appUrl | Out-Null
                Write-Host "[launcher] Opened app in existing $procName browser"
                $browserOpened = $true
                break
            }
        } catch {
            # Continue to next browser
        }
    }
}

# If no existing browser found, use default browser
if (-not $browserOpened) {
    Start-Process $appUrl -ErrorAction SilentlyContinue | Out-Null
    Write-Host "[launcher] Opened app in default browser"
}

Write-Host "[launcher] Web UI: http://127.0.0.1:5180"
Write-Host "[launcher] Server logs:"
Write-Host "  Dev:  $log"
Write-Host "  MCP:  $mcpLog"
Write-Host ""
Write-Host "[launcher] Ready! Open browser extension to start."
Write-Host ""
