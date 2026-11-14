param([string]$BackendUrl = 'http://192.168.0.22:3000', [string]$Port = 'COM3')
$ErrorActionPreference = 'Stop'
$configFile = Join-Path $PSScriptRoot '..\.tools\server-secrets.json'
$deviceConfig = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$serial = [System.IO.Ports.SerialPort]::new($Port,115200)
$serial.DtrEnable = $false; $serial.RtsEnable = $false
try {
  $serial.Open()
  $serial.Write("BACKEND`t$BackendUrl`t$($deviceConfig.deviceToken)`n")
  Start-Sleep -Seconds 7
  Write-Output $serial.ReadExisting()
} finally {
  if ($serial.IsOpen) { $serial.Close() }
  $serial.Dispose(); $deviceConfig = $null
}
