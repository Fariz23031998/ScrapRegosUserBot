#Requires -Version 5.1
<#
.SYNOPSIS
  Start local development: ngrok + server + bot + admin UI in one Windows Terminal window.

.DESCRIPTION
  Opens separate tabs for:
    - ngrok http <CLICK_SERVER_PORT>
    - npm run server
    - npm run bot
    - npm run bot-admin-ui:dev

  Waits for the ngrok HTTPS URL, writes PUBLIC_BASE_URL in .env (used for Telegram
  payment/dashboard links), and prints the REGOS webhook URL to configure in REGOS.
#>
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $ProjectRoot '.env'
$NgrokApi = 'http://127.0.0.1:4040/api/tunnels'
$DefaultPort = 3000
$NgrokWaitSeconds = 60

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Get-DotEnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match "^[ \t]*$([regex]::Escape($Key))=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^[ \t]*$([regex]::Escape($Key))=", '').Trim()
}

function Set-DotEnvValue([string]$Path, [string]$Key, [string]$Value) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw ".env not found at $Path. Copy .env.example to .env first."
  }

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $hadBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = if ($hadBom) { $utf8.GetString($bytes, 3, $bytes.Length - 3) } else { $utf8.GetString($bytes) }

  $nl = if ($text -match "`r`n") { "`r`n" } else { "`n" }
  $pattern = "(?m)^[ \t]*$([regex]::Escape($Key))=.*$"
  $replacement = "$Key=$Value"
  $rx = [regex]::new($pattern)

  if ($rx.IsMatch($text)) {
    $text = $rx.Replace($text, $replacement, 1)
  } else {
    if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += $nl }
    $text += "$replacement$nl"
  }

  $out = if ($hadBom) {
    $bom = [byte[]](0xEF, 0xBB, 0xBF)
    $bom + $utf8.GetBytes($text)
  } else {
    $utf8.GetBytes($text)
  }
  [System.IO.File]::WriteAllBytes($Path, $out)
}

function Get-NgrokHttpsUrl {
  try {
    $payload = Invoke-RestMethod -Uri $NgrokApi -TimeoutSec 2
  } catch {
    return $null
  }

  $tunnel = @(
    $payload.tunnels |
      Where-Object { $_.public_url -like 'https://*' } |
      Sort-Object { if ($_.proto -eq 'https') { 0 } else { 1 } }
  ) | Select-Object -First 1

  if ($tunnel) { return $tunnel.public_url.TrimEnd('/') }
  return $null
}

function Wait-NgrokHttpsUrl([int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $url = Get-NgrokHttpsUrl
    if ($url) { return $url }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out after ${TimeoutSeconds}s waiting for ngrok HTTPS URL at $NgrokApi"
}

function Start-WtTab([string]$Title, [string]$Command, [switch]$NewWindow) {
  # Use -w new for the first tab, then -w 0 (last-used window) for the rest.
  # Avoid --name / --window-name: older wt builds reject those flags.
  $wtArgs = @()
  if ($NewWindow) {
    $wtArgs += @('-w', 'new')
  } else {
    $wtArgs += @('-w', '0')
  }
  $wtArgs += @(
    'new-tab',
    '--title', $Title,
    '-d', $ProjectRoot,
    'powershell', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $Command
  )
  & wt.exe @wtArgs
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "Windows Terminal failed to open tab '$Title' (exit $LASTEXITCODE)"
  }
}

Assert-Command 'wt.exe'
Assert-Command 'ngrok'
Assert-Command 'npm'

if (-not (Test-Path -LiteralPath $EnvPath)) {
  throw ".env not found at $EnvPath. Copy .env.example to .env first."
}

$portRaw = Get-DotEnvValue -Path $EnvPath -Key 'CLICK_SERVER_PORT'
$port = if ([string]::IsNullOrWhiteSpace($portRaw)) { $DefaultPort } else { [int]$portRaw }

Write-Host "Project: $ProjectRoot"
Write-Host "Server port: $port"

$existingUrl = Get-NgrokHttpsUrl
$startedNgrok = $false

if ($existingUrl) {
  Write-Host "Reusing existing ngrok tunnel: $existingUrl"
  $publicUrl = $existingUrl
} else {
  Write-Host 'Starting ngrok tab...'
  Start-WtTab -Title 'ngrok' -Command "ngrok http $port" -NewWindow
  $startedNgrok = $true
  Start-Sleep -Seconds 1
  Write-Host "Waiting for ngrok HTTPS URL (up to ${NgrokWaitSeconds}s)..."
  $publicUrl = Wait-NgrokHttpsUrl -TimeoutSeconds $NgrokWaitSeconds
  Write-Host "ngrok URL: $publicUrl"
}

$previous = Get-DotEnvValue -Path $EnvPath -Key 'PUBLIC_BASE_URL'
if ($previous -ne $publicUrl) {
  Set-DotEnvValue -Path $EnvPath -Key 'PUBLIC_BASE_URL' -Value $publicUrl
  Write-Host "Updated PUBLIC_BASE_URL in .env"
  if ($previous) { Write-Host "  was: $previous" }
  Write-Host "  now: $publicUrl"
} else {
  Write-Host "PUBLIC_BASE_URL already set to $publicUrl"
}

$webhookUrl = "$publicUrl/api/regos/webhook"
Write-Host ''
Write-Host 'Configure REGOS webhook URL to:'
Write-Host "  $webhookUrl"
Write-Host 'Telegram payment/dashboard links use PUBLIC_BASE_URL (same origin).'
Write-Host ''

if (-not $startedNgrok) {
  # Ensure the named window exists when we reuse a tunnel started outside this script.
  Start-WtTab -Title 'ngrok' -Command "Write-Host 'ngrok already running at $publicUrl'; Write-Host 'Inspector: http://127.0.0.1:4040'; Write-Host 'Leave this tab open or close it.';" -NewWindow
  Start-Sleep -Seconds 1
}

Write-Host 'Starting app tabs...'
Start-WtTab -Title 'server' -Command 'npm run server'
Start-Sleep -Milliseconds 400
Start-WtTab -Title 'bot' -Command 'npm run bot'
Start-Sleep -Milliseconds 400
Start-WtTab -Title 'admin-ui' -Command 'npm run bot-admin-ui:dev'

Write-Host ''
Write-Host 'Dev environment launched in one Windows Terminal window (separate tabs).'
Write-Host '  Admin UI:  http://localhost:5301/bot-admin/'
Write-Host "  Server:    http://127.0.0.1:$port"
Write-Host "  Public:    $publicUrl"
Write-Host "  REGOS WH:  $webhookUrl"
Write-Host '  ngrok UI:  http://127.0.0.1:4040'
