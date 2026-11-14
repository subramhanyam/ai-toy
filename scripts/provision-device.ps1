param([string]$BackendUrl = 'http://192.168.0.22:3000', [string]$Port = 'COM3', [int]$BaudRate = 921600)
$ErrorActionPreference = 'Stop'
$configFile = Join-Path $PSScriptRoot '..\.tools\server-secrets.json'
$deviceConfig = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$serial = [System.IO.Ports.SerialPort]::new($Port,$BaudRate)
$serial.DtrEnable = $false; $serial.RtsEnable = $false
try {
  $serial.Open()
  # Some USB bridges reset the board on open despite inactive DTR/RTS. Wait for
  # the sketch to answer before writing credentials; never send them into boot.
  $boardReady = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $serial.Write("STATUS`n")
    Start-Sleep -Milliseconds 250
    if ($serial.ReadExisting() -match 'WebSocket LED; IP:') { $boardReady = $true; break }
  }
  if (-not $boardReady) { throw 'ESP32 did not answer STATUS at the selected baud rate.' }
  $serial.Write("BACKEND`t$BackendUrl`t$($deviceConfig.deviceToken)`n")
  Start-Sleep -Seconds 7
  $null = $serial.ReadExisting() # Discard the ROM boot log at a different baud.
  $serial.Write("STATUS`n")
  Start-Sleep -Milliseconds 500
  $statusText = $serial.ReadExisting()
  if ($statusText -notmatch ('backend: ' + [regex]::Escape($BackendUrl.TrimEnd('/')) + ';')) {
    throw 'ESP32 backend configuration was not confirmed. Reconnect USB and retry.'
  }
  [regex]::Matches($statusText, 'WebSocket LED;[^\r\n]*') | ForEach-Object { $_.Value }
} finally {
  if ($serial.IsOpen) { $serial.Close() }
  $serial.Dispose(); $deviceConfig = $null
}
