$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Test-LocalPort([int]$port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connection = $client.ConnectAsync('127.0.0.1', $port)
    return $connection.Wait(250) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Open-Workbench([int]$port) {
  if ($env:INFOBOX_NO_BROWSER -eq '1') { return }
  $url = "http://127.0.0.1:$port"
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', "Start-Sleep -Milliseconds 700; Start-Process '$url'"
}

$port = 3000
if (Test-LocalPort $port) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
    if ([int]$health.api_version -ge 8) {
      Write-Host "InfoBox is already running at http://127.0.0.1:$port"
      Open-Workbench $port
      exit 0
    }
  } catch {
    # The occupied port is not a compatible InfoBox server.
  }
  do { $port += 1 } while (Test-LocalPort $port)
  Write-Host "Port 3000 is occupied by an older service. Starting this version on port $port."
}

$env:PORT = [string]$port
Write-Host 'InfoBox workbench is starting...'
Write-Host 'Close this window to stop it. Inbox files are processed only after you click the classify button.'
Open-Workbench $port
& node (Join-Path $projectRoot 'src\server.js')
exit $LASTEXITCODE
