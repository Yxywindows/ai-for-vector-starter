$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Get-NetTCPConnection -LocalPort 18404 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host 'Port 18404 is already in use. Check http://127.0.0.1:18404/ before starting another copy.'
  exit 1
}
node server.mjs
