# Origami Live - register the native-messaging host so the Studio's "Go Live"
# button can reach it. One-time. Re-run with -ExtensionId <id> if the id changes
# (e.g. after publishing to the Web Store).
#
#   powershell -ExecutionPolicy Bypass -File setup-host.ps1
#
param(
  [string]$ExtensionId = "oghflmdefaljpkmdeeijbjbhofadhkli"
)
$ErrorActionPreference = "Stop"
$HostName = "com.origami.live"

# the built host sits next to this script, in ../dist/host.cjs
$dist = (Resolve-Path (Join-Path $PSScriptRoot "..\dist")).Path
$hostCjs = Join-Path $dist "host.cjs"
if (-not (Test-Path $hostCjs)) {
  throw "host.cjs not found in $dist - run 'npm -w origami-serve run build' first"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node was not found on PATH - install Node.js, then re-run"
}

# 1) a launcher .bat: a Windows native host must point at an executable, not a .cjs
$bat = Join-Path $dist "origami-live-host.bat"
Set-Content -Path $bat -Encoding ascii -Value @('@echo off', 'node "%~dp0host.cjs"')

# 2) the native-messaging host manifest (names the extension allowed to call it)
$manifest = Join-Path $dist "$HostName.json"
$json = [ordered]@{
  name            = $HostName
  description     = "Origami Live - serves the current deck on localhost so it plays like a real web page"
  path            = $bat
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
Set-Content -Path $manifest -Encoding ascii -Value $json

# 3) register the manifest for each Chromium browser (HKCU - no admin needed)
$browsers = [ordered]@{
  Chrome   = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
  Brave    = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
  Edge     = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
  Chromium = "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName"
}
foreach ($name in $browsers.Keys) {
  $key = $browsers[$name]
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name "(default)" -Value $manifest
  Write-Host "registered for $name"
}

Write-Host ""
Write-Host "Origami Live helper installed."
Write-Host "  host:      $hostCjs"
Write-Host "  manifest:  $manifest"
Write-Host "  extension: $ExtensionId"
Write-Host "Now press 'Go Live' in the Studio. Fully restart the browser first so it re-reads the registry."
